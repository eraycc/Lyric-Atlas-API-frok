// Define a simple logger interface
interface BasicLogger {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug?: (...args: any[]) => void; // Optional debug method
}

import {
  LyricFormat,
  buildRawUrl,
  buildExternalApiUrl,
  filterLyricLines,
  DEFAULT_FALLBACK_ORDER,
  isValidFormat
} from './utils';

// Define result types for internal fetch functions
export type FetchResult =
  | { status: 'found'; format: LyricFormat; content: string; source: 'repository' | 'external' }
  | { status: 'notfound'; format?: LyricFormat } // format might be unknown if initial external fetch failed
  | { status: 'error'; format?: LyricFormat; statusCode?: number; error: Error };

// Result type for the main search function
export type SearchResult =
  | { found: true; id: string; format: LyricFormat; source: 'repository' | 'external'; content: string; translation?: string; romaji?: string }
  | { found: false; id: string; error: string; statusCode?: number };

// Environment variable (should be passed in or handled differently in a real service)
const EXTERNAL_API_BASE_URL = process.env.EXTERNAL_NCM_API_URL;

// --- Internal Fetcher Functions ---

async function fetchRepoLyric(
  id: string,
  format: LyricFormat,
  logger: BasicLogger
): Promise<FetchResult> {
  const url = buildRawUrl(id, format);
  logger.info(`Attempting fetch from GitHub repo for ${format.toUpperCase()}: ${url}`);
  try {
    const response = await fetch(url);
    if (response.ok) {
      const content = await response.text();
      logger.info(`Repo fetch success for ${format.toUpperCase()} (status: ${response.status})`);
      return { status: 'found', format, content, source: 'repository' };
    } else if (response.status === 404) {
      logger.info(`Repo fetch resulted in 404 for ${format.toUpperCase()}`);
      return { status: 'notfound', format };
    } else {
      logger.error(`Repo fetch failed for ${format.toUpperCase()} with HTTP status ${response.status}`);
      return { status: 'error', format, statusCode: response.status, error: new Error(`HTTP error ${response.status}`) };
    }
  } catch (err) {
    logger.error(`Network error during repo fetch for ${format.toUpperCase()}`, err);
    const error = err instanceof Error ? err : new Error('Unknown fetch error');
    return { status: 'error', format, error };
  }
}

async function fetchExternalLyric(
  id: string,
  specificFormat: 'yrc' | 'lrc' | undefined, // Undefined means try both based on API response
  logger: BasicLogger
): Promise<FetchResult & { translation?: string; romaji?: string }> {
  const externalUrl = buildExternalApiUrl(id, EXTERNAL_API_BASE_URL);
  logger.info(`Attempting fetch from external API: ${externalUrl}`);

  try {
    const externalResponse = await fetch(externalUrl);
    if (!externalResponse.ok) {
      logger.error(`External API fetch failed with status: ${externalResponse.status} for URL: ${externalUrl}`);
      return { status: 'error', statusCode: 502, error: new Error(`External API failed with status ${externalResponse.status}`) };
    }

    let externalData;
    try {
      externalData = await externalResponse.json() as any;
    } catch (parseError) {
      logger.error(`Failed to parse JSON from external API fallback for ID: ${id}`, parseError);
      return { status: 'error', statusCode: 502, error: new Error('External API fallback returned invalid JSON.') };
    }

    // 获取翻译歌词，无论请求格式如何都尝试获取
    const translationRaw = filterLyricLines(externalData?.tlyric?.lyric);
    // 将 null 转换为 undefined 以符合类型要求
    const translation = translationRaw === null ? undefined : translationRaw;
    logger.info(`Translation lyrics ${translation ? 'found' : 'not found'} in external API response.`);

    // 获取罗马音歌词
    const romajiRaw = filterLyricLines(externalData?.romalrc?.lyric);
    const romaji = romajiRaw === null ? undefined : romajiRaw;
    logger.info(`Romaji lyrics ${romaji ? 'found' : 'not found'} in external API response.`);

    // Prioritize specific format if requested
    if (specificFormat === 'yrc') {
      const filteredContent = filterLyricLines(externalData?.yrc?.lyric);
      if (filteredContent) {
        logger.info(`Found and filtered YRC lyrics in external API for ID: ${id}.`);
        return { status: 'found', format: 'yrc', source: 'external', content: filteredContent, translation, romaji };
      }
    } else if (specificFormat === 'lrc') {
        const filteredContent = filterLyricLines(externalData?.lrc?.lyric);
        if (filteredContent) {
          logger.info(`Found and filtered LRC lyrics in external API for ID: ${id}.`);
          return { status: 'found', format: 'lrc', source: 'external', content: filteredContent, translation, romaji };
        }
    } else { // No specific format requested, try yrc then lrc
       const filteredYrc = filterLyricLines(externalData?.yrc?.lyric);
       if (filteredYrc) {
         logger.info(`Found and filtered YRC lyrics (default) in external API for ID: ${id}.`);
         return { status: 'found', format: 'yrc', source: 'external', content: filteredYrc, translation, romaji };
       }
       const filteredLrc = filterLyricLines(externalData?.lrc?.lyric);
       if (filteredLrc) {
         logger.info(`Found and filtered LRC lyrics (fallback) in external API for ID: ${id}.`);
         return { status: 'found', format: 'lrc', source: 'external', content: filteredLrc, translation, romaji };
       }
    }

    // If specific format requested but not found/filtered, or no format found
    logger.info(`No usable lyrics${specificFormat ? ` for format ${specificFormat}` : ''} found in external API response for ID: ${id}.`);
    return { status: 'notfound', format: specificFormat }; // Indicate not found for the specific/general case

  } catch (externalFetchError) {
    logger.error(`Network error during external API fallback fetch for ID: ${id}`, externalFetchError);
    const error = externalFetchError instanceof Error ? externalFetchError : new Error('Unknown external fetch error');
    return { status: 'error', statusCode: 502, error };
  }
}

// --- Helper functions for searchLyrics flow ---

async function handleFixedVersionSearch(
  id: string,
  fixedVersionQuery: LyricFormat, // Already validated
  logger: BasicLogger
): Promise<SearchResult> {
  logger.info(`LyricService: Handling fixedVersion request for format: ${fixedVersionQuery}`);

  // Try repository first
  const repoResult = await fetchRepoLyric(id, fixedVersionQuery, logger);
  if (repoResult.status === 'found') {
    return { found: true, id, format: repoResult.format, source: 'repository', content: repoResult.content };
  }
  if (repoResult.status === 'error') {
    return { found: false, id, error: `Repo fetch failed for fixed format ${fixedVersionQuery}: ${repoResult.error.message}`, statusCode: repoResult.statusCode };
  }

  // If repo not found, try external for yrc/lrc
  if (fixedVersionQuery === 'yrc' || fixedVersionQuery === 'lrc') {
    logger.info(`LyricService: Fixed ${fixedVersionQuery} not in repo, trying external.`);
    const externalResult = await fetchExternalLyric(id, fixedVersionQuery, logger);
    if (externalResult.status === 'found') {
      return {
        found: true,
        id,
        format: externalResult.format,
        source: 'external',
        content: externalResult.content,
        translation: externalResult.translation,
        romaji: externalResult.romaji
      };
    }
    if (externalResult.status === 'error') {
      return { found: false, id, error: `External fetch failed for fixed format ${fixedVersionQuery}: ${externalResult.error.message}`, statusCode: externalResult.statusCode };
    }
    logger.info(`LyricService: Fixed ${fixedVersionQuery} not found externally either.`);
  } else {
    logger.info(`LyricService: Fixed ${fixedVersionQuery} not in repo. External not checked for this format.`);
  }

  // If fixedVersion was specified but not found after all checks
  return { found: false, id, error: `Lyrics not found for fixed format: ${fixedVersionQuery}`, statusCode: 404 };
}

/**
 * Fetches all specified repository formats (TTML + fallbacks) in parallel.
 * Returns the first found result according to priority (TTML > fallback order),
 * or null if none are found. Logs errors encountered during fetches.
 */
async function findAllInRepo(
  id: string,
  fallbackQuery: string | undefined,
  logger: BasicLogger
): Promise<SearchResult | null> {
  let formatsToCheck: LyricFormat[] = ['ttml']; // Always check TTML first
  let specifiedFallbacks: LyricFormat[] = [];

  if (fallbackQuery) {
    specifiedFallbacks = fallbackQuery.split(',')
      .map((f: string) => f.trim().toLowerCase())
      .filter((f): f is LyricFormat => isValidFormat(f) && f !== 'ttml'); // Exclude ttml from fallbacks
    if (specifiedFallbacks.length === 0 && fallbackQuery.split(',').length > 0) {
      logger.warn(`LyricService: Fallback query ("${fallbackQuery}") resulted in no valid non-TTML formats.`);
    }
    formatsToCheck.push(...specifiedFallbacks);
  } else {
    // Add default fallbacks, excluding ttml if it's already there (which it always is)
    formatsToCheck.push(...DEFAULT_FALLBACK_ORDER.filter(f => f !== 'ttml'));
  }

  // Remove duplicates just in case, though logic should prevent 'ttml' duplication
  formatsToCheck = [...new Set(formatsToCheck)];

  if (formatsToCheck.length === 0) {
     logger.info(`LyricService: No valid repository formats to check.`);
     return null;
  }

  logger.info(`LyricService: Fetching repository formats in parallel: ${formatsToCheck.join(', ')}`);
  const fetchPromises = formatsToCheck.map(format => fetchRepoLyric(id, format, logger));
  const results = await Promise.allSettled(fetchPromises);

  // Map results for easier lookup, store only successful fetches or errors
  const resultMap = new Map<LyricFormat, FetchResult>();
  results.forEach((result, index) => {
      const format = formatsToCheck[index];
      if (result.status === 'fulfilled') {
          // Log errors here for context, even if fetchRepoLyric also logged
          if (result.value.status === 'error') {
              logger.error(`LyricService: Error fetching repo format ${format.toUpperCase()} during parallel check: ${result.value.error.message}`, result.value.error);
          }
           // Store found, notfound, or error results from fulfilled promises
          resultMap.set(format, result.value);
      } else {
          // Log rejected promises
          logger.error(`LyricService: Promise rejected for repo format ${format.toUpperCase()}: ${result.reason}`, result.reason);
          // Optionally store a synthetic error result
          // resultMap.set(format, { status: 'error', format, error: new Error(`Promise rejected: ${result.reason}`) });
      }
  });


  // Iterate through the desired order (formatsToCheck) to find the first success
  for (const format of formatsToCheck) {
      const fetchResult = resultMap.get(format);
      if (fetchResult?.status === 'found') {
          logger.info(`LyricService: Found repository format ${format.toUpperCase()} via parallel fetch.`);
          return { found: true, id, format: fetchResult.format, source: 'repository', content: fetchResult.content };
      }
      // 'notfound' or 'error' statuses mean we continue to the next format in the priority list
  }

  logger.info(`LyricService: Parallel repository fetches complete, no format found.`);
  return null; // None found
}

async function findInExternalApi(
  id: string,
  logger: BasicLogger
): Promise<SearchResult> { // Always returns a SearchResult (found, error, or final notfound)
  logger.info(`LyricService: Trying external API fallback.`);
  const externalResult = await fetchExternalLyric(id, undefined, logger); // undefined -> try yrc, then lrc
  if (externalResult.status === 'found') {
    return { 
      found: true, 
      id, 
      format: externalResult.format, 
      source: 'external', 
      content: externalResult.content,
      translation: externalResult.translation,
      romaji: externalResult.romaji
    };
  }
  if (externalResult.status === 'error') {
    return { found: false, id, error: `External API fallback failed: ${externalResult.error.message}`, statusCode: externalResult.statusCode };
  }

  // If externalResult.status is 'notfound'
  logger.info(`LyricService: External API fallback did not yield usable lyrics.`);
  return { found: false, id, error: 'Lyrics not found in repository or external API', statusCode: 404 };
}

// --- Main Search Function ---

export async function searchLyrics(
  id: string,
  options: {
    fixedVersion?: string;
    fallback?: string;
    logger: BasicLogger;
  }
): Promise<SearchResult> {

  const { fixedVersion: fixedVersionRaw, fallback: fallbackQuery, logger } = options;
  const fixedVersionQuery = fixedVersionRaw?.toLowerCase();
  logger.info(`LyricService: Processing ID: ${id}, fixed: ${fixedVersionQuery}, fallback: ${fallbackQuery}`);

  // 1. Handle fixedVersion if provided and valid
  if (isValidFormat(fixedVersionQuery)) {
    return handleFixedVersionSearch(id, fixedVersionQuery, logger);
  }

  // --- Standard Search Flow (No valid fixedVersion) ---
  logger.info(`LyricService: Starting standard search flow.`);

  // 2. Start repository and external API checks in parallel
  logger.info(`LyricService: Starting parallel checks for repository and external API.`);
  const repoPromise = findAllInRepo(id, fallbackQuery, logger);
  const externalApiPromise = findInExternalApi(id, logger);

  // Wait for both promises to settle
  const [repoResultSettled, externalApiResultSettled] = await Promise.allSettled([
    repoPromise,
    externalApiPromise
  ]);

  // 3. Prioritize Repository Result
  if (repoResultSettled.status === 'fulfilled' && repoResultSettled.value?.found) {
    logger.info('LyricService: Prioritizing result found in repository.');
    return repoResultSettled.value; // Found in repo, return immediately
  }

   // Log repository outcome if it didn't yield a usable result
   if (repoResultSettled.status === 'rejected') {
     logger.error('LyricService: Repository check promise was rejected.', repoResultSettled.reason);
   } else if (repoResultSettled.value && !repoResultSettled.value.found) {
       // Repo search completed but found nothing or had an error handled within findAllInRepo (returned SearchResult{found:false})
      logger.info(`LyricService: Repository check completed but found no lyrics (or encountered an error): ${repoResultSettled.value.error}`);
   } else if (repoResultSettled.value === null) {
       // This case handles when findAllInRepo explicitly returns null (e.g., no valid formats to check)
       logger.info('LyricService: Repository check found no applicable formats or lyrics.');
   }

  // 4. Fallback to External API Result
  logger.info('LyricService: Repository check did not yield results, evaluating external API outcome.');
  if (externalApiResultSettled.status === 'fulfilled') {
    logger.info(`LyricService: External API check promise fulfilled, returning its result (found: ${externalApiResultSettled.value.found}).`);
    return externalApiResultSettled.value; // Return external result (found, notfound, or error)
  } else {
    // External API promise was rejected
    logger.error('LyricService: External API check promise was rejected.', externalApiResultSettled.reason);
    // Construct a final error message reflecting both failures if necessary
    let repoErrorMsg = 'Repository check failed or found nothing.';
    if (repoResultSettled.status === 'fulfilled' && repoResultSettled.value && !repoResultSettled.value.found) {
        repoErrorMsg = `Repository check failed: ${repoResultSettled.value.error}`;
    }
    return {
        found: false,
        id,
        error: `Both repository and external API checks failed. Repo: ${repoErrorMsg} External API Error: ${externalApiResultSettled.reason?.message || 'Unknown rejection reason'}`,
        statusCode: 500 // Indicate a general server-side failure
    };
  }
} 