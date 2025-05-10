import {
  LyricFormat,
  buildRawUrl,
  buildExternalApiUrl,
  filterLyricLines,
  DEFAULT_FALLBACK_ORDER,
  isValidFormat,
  getLogger,
} from './utils';
import { RepositoryFetcher } from './fetchers/repositoryFetcher';
import { ExternalApiFetcher } from './fetchers/externalApiFetcher';
import type { LyricFetcher, ExternalLyricFetcher } from './interfaces/fetcher';
import type { FetchResult, LyricProviderOptions } from './interfaces/lyricTypes';

// Get logger instance using our custom logger
const logger = getLogger('LyricService');

// Export SearchResult and LyricProviderOptions types for use in index.ts
export type { LyricProviderOptions };

// Result type for the main search function
export type SearchResult =
  | { found: true; id: string; format: LyricFormat; source: 'repository' | 'external'; content: string; translation?: string; romaji?: string }
  | { found: false; id: string; error: string; statusCode?: number };

// If BasicLogger is not imported or defined globally, define it here.
interface BasicLogger {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
}

// --- New types for metadata checking ---
export type LyricMetadataResult =
  | {
      found: true;
      id: string;
      availableFormats: LyricFormat[];
      hasTranslation?: boolean; // From external API
      hasRomaji?: boolean;      // From external API
    }
  | { found: false; id: string; error?: string; statusCode?: number };

// --- Lyric Provider Service ---

export class LyricProvider {
  private repoFetcher: LyricFetcher;
  private externalFetcher: ExternalLyricFetcher;

  constructor(externalApiBaseUrl: string | undefined) {
    this.repoFetcher = new RepositoryFetcher();
    this.externalFetcher = new ExternalApiFetcher(externalApiBaseUrl);
  }

  async search(id: string, options: LyricProviderOptions): Promise<SearchResult> {
    const { fixedVersion: fixedVersionRaw, fallback: fallbackQuery } = options;
    const fixedVersionQuery = fixedVersionRaw?.toLowerCase();
    logger.info(`LyricProvider: Processing ID: ${id}, fixed: ${fixedVersionQuery}, fallback: ${fallbackQuery}`);

    // 1. Handle fixedVersion if provided and valid
    if (isValidFormat(fixedVersionQuery)) {
      return this.handleFixedVersionSearch(id, fixedVersionQuery);
    }

    // --- Standard Search Flow (No valid fixedVersion) ---
    logger.info(`LyricProvider: Starting standard search flow.`);

    // 2. Start repository and external API checks in parallel
    logger.debug(`LyricProvider: Starting parallel checks for repository and external API.`);
    const repoPromise = this.findAllInRepo(id, fallbackQuery);
    const externalApiPromise = this.findInExternalApi(id);

    // Wait for both promises to settle
    const [repoResultSettled, externalApiResultSettled] = await Promise.allSettled([
      repoPromise,
      externalApiPromise
    ]);

    // 3. Prioritize Repository Result
    if (repoResultSettled.status === 'fulfilled' && repoResultSettled.value?.found) {
      logger.info('LyricProvider: Prioritizing result found in repository.');
      return repoResultSettled.value; // Found in repo, return immediately
    }

    // Log repository outcome if it didn't yield a usable result
    this.logRepoOutcome(repoResultSettled);

    // 4. Fallback to External API Result
    logger.info('LyricProvider: Repository check did not yield results, evaluating external API outcome.');
    if (externalApiResultSettled.status === 'fulfilled') {
      logger.info(`LyricProvider: External API check promise fulfilled, returning its result (found: ${externalApiResultSettled.value.found}).`);
      return externalApiResultSettled.value; // Return external result (found, notfound, or error)
    } else {
      // External API promise was rejected
      logger.error('LyricProvider: External API check promise was rejected.', externalApiResultSettled.reason);
      let repoErrorMsg = 'Repository check failed or found nothing.';
      if (repoResultSettled.status === 'fulfilled' && repoResultSettled.value && !repoResultSettled.value.found) {
        repoErrorMsg = `Repository check failed: ${repoResultSettled.value.error}`;
      }
      return {
        found: false,
        id,
        error: `Both repository and external API checks failed. Repo: ${repoErrorMsg} External API Error: ${externalApiResultSettled.reason?.message || 'Unknown rejection reason'}`,
        statusCode: 500
      };
    }
  }

  private async handleFixedVersionSearch(id: string, fixedVersionQuery: LyricFormat): Promise<SearchResult> {
    logger.info(`LyricProvider: Handling fixedVersion request for format: ${fixedVersionQuery}`);

    const repoResult = await this.repoFetcher.fetch(id, fixedVersionQuery);
    if (repoResult.status === 'found') {
      return { found: true, id, format: repoResult.format, source: 'repository', content: repoResult.content };
    }
    if (repoResult.status === 'error') {
      return { found: false, id, error: `Repo fetch failed for fixed format ${fixedVersionQuery}: ${repoResult.error.message}`, statusCode: repoResult.statusCode };
    }

    if (fixedVersionQuery === 'yrc' || fixedVersionQuery === 'lrc') {
      logger.info(`LyricProvider: Fixed ${fixedVersionQuery} not in repo, trying external.`);
      const externalResult = await this.externalFetcher.fetch(id, fixedVersionQuery);
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
      logger.info(`LyricProvider: Fixed ${fixedVersionQuery} not found externally either.`);
    } else {
      logger.info(`LyricProvider: Fixed ${fixedVersionQuery} not in repo. External not checked for this format.`);
    }

    return { found: false, id, error: `Lyrics not found for fixed format: ${fixedVersionQuery}`, statusCode: 404 };
  }

  private async findAllInRepo(id: string, fallbackQuery: string | undefined): Promise<SearchResult | null> {
    let formatsToCheck: LyricFormat[] = ['ttml'];
    let specifiedFallbacks: LyricFormat[] = [];

    if (fallbackQuery) {
      specifiedFallbacks = fallbackQuery.split(',')
        .map((f: string) => f.trim().toLowerCase())
        .filter((f): f is LyricFormat => isValidFormat(f) && f !== 'ttml');
      if (specifiedFallbacks.length === 0 && fallbackQuery.split(',').length > 0) {
        logger.warn(`LyricProvider: Fallback query ("${fallbackQuery}") resulted in no valid non-TTML formats.`);
      }
      formatsToCheck.push(...specifiedFallbacks);
    } else {
      formatsToCheck.push(...DEFAULT_FALLBACK_ORDER.filter(f => f !== 'ttml'));
    }

    formatsToCheck = [...new Set(formatsToCheck)];

    if (formatsToCheck.length === 0) {
      logger.info(`LyricProvider: No valid repository formats to check.`);
      return null;
    }

    logger.debug(`LyricProvider: Fetching repository formats in parallel: ${formatsToCheck.join(', ')}`);
    const fetchPromises = formatsToCheck.map(format => this.repoFetcher.fetch(id, format));
    const results = await Promise.allSettled(fetchPromises);

    const resultMap = new Map<LyricFormat, FetchResult>();
    results.forEach((result, index) => {
      const format = formatsToCheck[index];
      if (result.status === 'fulfilled') {
        if (result.value.status === 'error') {
          logger.error(`LyricProvider: Error fetching repo format ${format.toUpperCase()} during parallel check: ${result.value.error.message}`, result.value.error);
        }
        resultMap.set(format, result.value);
      } else {
        logger.error(`LyricProvider: Promise rejected for repo format ${format.toUpperCase()}: ${result.reason}`, result.reason);
      }
    });

    for (const format of formatsToCheck) {
      const fetchResult = resultMap.get(format);
      if (fetchResult?.status === 'found') {
        logger.info(`LyricProvider: Found repository format ${format.toUpperCase()} via parallel fetch.`);
        return { found: true, id, format: fetchResult.format, source: 'repository', content: fetchResult.content };
      }
    }

    logger.info(`LyricProvider: Parallel repository fetches complete, no format found.`);
    return null;
  }

  private async findInExternalApi(id: string): Promise<SearchResult> {
    logger.info(`LyricProvider: Trying external API fallback.`);
    const externalResult = await this.externalFetcher.fetch(id, undefined);
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
    logger.info(`LyricProvider: External API fallback did not yield usable lyrics.`);
    return { found: false, id, error: 'Lyrics not found in repository or external API', statusCode: 404 };
  }

  private logRepoOutcome(repoResultSettled: PromiseSettledResult<SearchResult | null>) {
    if (repoResultSettled.status === 'rejected') {
      logger.error('LyricProvider: Repository check promise was rejected.', repoResultSettled.reason);
    } else if (repoResultSettled.value === null) {
      logger.info('LyricProvider: Repository check found no applicable formats or lyrics.');
    } else if (!repoResultSettled.value.found) {
      logger.info(`LyricProvider: Repository check completed but found no lyrics (or encountered an error): ${repoResultSettled.value.error}`);
    }
    // If fulfilled and found, it was handled earlier.
  }
}

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

// --- Helper function for metadata: checks repo format existence ---
async function checkRepoFormatExistence(
  id: string,
  format: LyricFormat,
  logger: BasicLogger
): Promise<{ format: LyricFormat; exists: boolean; error?: Error }> {
  const url = buildRawUrl(id, format);
  logger.debug?.(`Metadata: Checking repo existence for ${format.toUpperCase()}: ${url}`);
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (response.ok) {
      logger.debug?.(`Metadata: Repo format ${format.toUpperCase()} exists (status: ${response.status}).`);
      return { format, exists: true };
    } else if (response.status === 404) {
      logger.debug?.(`Metadata: Repo format ${format.toUpperCase()} does not exist (status: 404).`);
      return { format, exists: false };
    } else {
      logger.warn(`Metadata: Repo format ${format.toUpperCase()} existence check returned status ${response.status}.`);
      return { format, exists: false, error: new Error(`HTTP error ${response.status}`) };
    }
  } catch (err) {
    logger.error(`Network error during repo existence check for ${format.toUpperCase()}`, err);
    const error = err instanceof Error ? err : new Error('Unknown fetch error');
    return { format, exists: false, error };
  }
}

async function fetchExternalLyric(
  id: string,
  specificFormat: 'yrc' | 'lrc' | undefined,
  logger: BasicLogger
): Promise<FetchResult & { translation?: string; romaji?: string }> {
  const externalUrl = buildExternalApiUrl(id, process.env.EXTERNAL_NCM_API_URL);
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
    const translationRaw = filterLyricLines(externalData?.tlyric?.lyric);
    const translation = translationRaw === null ? undefined : translationRaw;
    logger.info(`Translation lyrics ${translation ? 'found' : 'not found'} in external API response.`);
    const romajiRaw = filterLyricLines(externalData?.romalrc?.lyric);
    const romaji = romajiRaw === null ? undefined : romajiRaw;
    logger.info(`Romaji lyrics ${romaji ? 'found' : 'not found'} in external API response.`);

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
    } else {
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
    logger.info(`No usable lyrics${specificFormat ? ` for format ${specificFormat}` : ''} found in external API response for ID: ${id}.`);
    return { status: 'notfound', format: specificFormat };
  } catch (externalFetchError) {
    logger.error(`Network error during external API fallback fetch for ID: ${id}`, externalFetchError);
    const error = externalFetchError instanceof Error ? externalFetchError : new Error('Unknown external fetch error');
    return { status: 'error', statusCode: 502, error };
  }
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
  const { logger } = options;
  logger.info("searchLyrics called, but it's a placeholder in this diff.");
  return { found: false, id, error: 'Not implemented in placeholder' };
}

// --- New Metadata Function ---
export async function getLyricMetadata(
  id: string,
  options: {
    logger: BasicLogger;
  }
): Promise<LyricMetadataResult> {
  const { logger } = options;
  logger.info(`LyricService: Getting metadata for ID: ${id}`);

  const foundFormatsSet = new Set<LyricFormat>();
  let externalHasTranslation: boolean | undefined = undefined;
  let externalHasRomaji: boolean | undefined = undefined;
  let overallError: string | undefined = undefined;
  let lastStatusCode: number | undefined = undefined;

  // Check repository formats
  const repoFormatsToConsider: LyricFormat[] = [
    'ttml',
    ...DEFAULT_FALLBACK_ORDER.filter(f => f !== 'ttml')
  ];
  const uniqueRepoFormats = [...new Set(repoFormatsToConsider)];

  logger.debug?.(`Metadata: Checking repository formats: ${uniqueRepoFormats.join(', ')}`);
  const repoChecksPromises = uniqueRepoFormats.map(format =>
    checkRepoFormatExistence(id, format, logger)
  );
  const repoCheckResults = await Promise.allSettled(repoChecksPromises);

  repoCheckResults.forEach(result => {
    if (result.status === 'fulfilled' && result.value.exists) {
      foundFormatsSet.add(result.value.format);
    } else if (result.status === 'fulfilled' && result.value.error) {
      logger.warn(`Metadata: Repo check for ${result.value.format} resulted in an error: ${result.value.error.message}`);
    } else if (result.status === 'rejected') {
      const reasonMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error(`Metadata: Repo check promise rejected for a format. Reason: ${reasonMsg}`);
    }
  });

  logger.debug?.(`Metadata: Checking external API.`);
  const externalResult = await fetchExternalLyric(id, undefined, logger);

  if (externalResult.status === 'found') {
    foundFormatsSet.add(externalResult.format);
    if (externalResult.translation) { 
        externalHasTranslation = true;
    }
    if (externalResult.romaji) {
        externalHasRomaji = true;
    }
  } else if (externalResult.status === 'error') {
    logger.warn(`Metadata: External API check failed: ${externalResult.error.message}, Status: ${externalResult.statusCode}`);
    if (!overallError) overallError = `External API error: ${externalResult.error.message}`;
    if (!lastStatusCode) lastStatusCode = externalResult.statusCode;
  } else { // 'notfound'
    logger.info(`Metadata: No lyrics found in external API for metadata check.`);
  }

  const finalAvailableFormats = Array.from(foundFormatsSet);

  if (finalAvailableFormats.length > 0) {
    return {
      found: true,
      id,
      availableFormats: finalAvailableFormats,
      hasTranslation: externalHasTranslation,
      hasRomaji: externalHasRomaji,
    };
  } else {
    return {
      found: false,
      id,
      error: overallError || "No lyric formats found in repository or external API.",
      statusCode: lastStatusCode || 404
    };
  }
}
