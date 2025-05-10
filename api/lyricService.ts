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
// 删除旧的 checkRepoFormatExistence 函数实现，因为我们已经有了新的带超时版本

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

// 新增：轻量级检查外部 API 中可用的歌词格式（不读取内容）
async function checkExternalFormatsAvailability(
  id: string,
  logger: BasicLogger
): Promise<{ formats: LyricFormat[]; hasTranslation: boolean; hasRomaji: boolean; error?: Error; statusCode?: number }> {
  const externalUrl = buildExternalApiUrl(id, process.env.EXTERNAL_NCM_API_URL);
  logger.debug?.(`Metadata: Checking external API formats: ${externalUrl}`);
  
  try {
    // 设置较短的超时时间，因为这只是格式检查
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒超时
    
    const externalResponse = await fetch(externalUrl, { 
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    if (!externalResponse.ok) {
      logger.warn(`Metadata: External API check failed with status: ${externalResponse.status}`);
      return { 
        formats: [], 
        hasTranslation: false, 
        hasRomaji: false, 
        error: new Error(`External API failed with status ${externalResponse.status}`),
        statusCode: externalResponse.status
      };
    }

    // 解析JSON，但不处理歌词内容
    const externalData = await externalResponse.json() as any;
    const availableFormats: LyricFormat[] = [];
    let hasTranslation = false;
    let hasRomaji = false;

    // 检查各种格式是否存在（仅检查结构，不处理内容）
    if (externalData?.lrc?.lyric) {
      availableFormats.push('lrc');
    }
    
    if (externalData?.yrc?.lyric) {
      availableFormats.push('yrc');
    }
    
    if (externalData?.tlyric?.lyric) {
      hasTranslation = true;
    }
    
    if (externalData?.romalrc?.lyric) {
      hasRomaji = true;
    }

    logger.debug?.(`Metadata: External API formats found: ${availableFormats.join(', ')}`);
    logger.debug?.(`Metadata: Translation: ${hasTranslation}, Romaji: ${hasRomaji}`);
    
    return { formats: availableFormats, hasTranslation, hasRomaji };
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(`Metadata: External API formats check failed: ${err.message}`);
    
    // 判断是否为超时错误
    const isTimeoutError = err.name === 'AbortError';
    if (isTimeoutError) {
      logger.warn(`Metadata: External API request timed out after 3 seconds`);
    }
    
    return { 
      formats: [], 
      hasTranslation: false, 
      hasRomaji: false, 
      error: err,
      statusCode: isTimeoutError ? 408 : 502
    };
  }
}

// 修改 getLyricMetadata 函数以实现更激进的并行优化
export async function getLyricMetadata(
  id: string,
  options: {
    logger: BasicLogger;
  }
): Promise<LyricMetadataResult> {
  const { logger } = options;
  logger.info(`LyricService: Getting metadata for ID: ${id}`);

  // 定义总体超时时间
  const TOTAL_TIMEOUT_MS = 5000; // 5秒总超时
  const EARLY_RETURN_TIMEOUT_MS = 3000; // 3秒后如果有任何格式，提前返回
  
  // 创建存储结果的状态对象
  const state = {
    foundFormats: new Set<LyricFormat>(),
    hasTranslation: false,
    hasRomaji: false,
    error: undefined as string | undefined,
    statusCode: undefined as number | undefined,
    // 用于提前结束的标志
    shouldReturnEarly: false,
    earlyReturnTriggered: false
  };

  // 创建整体超时控制器
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn(`Metadata: Overall check timed out after ${TOTAL_TIMEOUT_MS}ms`);
    abortController.abort();
  }, TOTAL_TIMEOUT_MS);
  
  // 创建提前返回定时器
  const earlyReturnId = setTimeout(() => {
    // 如果已经找到了任何格式，就标记为可以提前返回
    if (state.foundFormats.size > 0 && !state.earlyReturnTriggered) {
      logger.info(`Metadata: Early return triggered after ${EARLY_RETURN_TIMEOUT_MS}ms with ${state.foundFormats.size} formats found`);
      state.shouldReturnEarly = true;
    }
  }, EARLY_RETURN_TIMEOUT_MS);

  try {
    // 定义所有要检查的格式
    const repoFormatsToConsider: LyricFormat[] = [
      'ttml',
      ...DEFAULT_FALLBACK_ORDER.filter(f => f !== 'ttml')
    ];
    const uniqueRepoFormats = [...new Set(repoFormatsToConsider)];
    
    logger.debug?.(`Metadata: Starting parallel checks for repository and external API`);
    
    // 1. 创建一个函数处理仓库格式检查结果
    const handleRepoFormatCheck = async (format: LyricFormat) => {
      try {
        const result = await checkRepoFormatExistence(id, format, logger);
        if (result.exists) {
          state.foundFormats.add(format);
          logger.debug?.(`Metadata: Found ${format} in repository`);
          
          // 当发现第一个可用格式，判断是否可以提前返回
          if (state.foundFormats.size === 1) {
            logger.debug?.(`Metadata: Found first available format (${format})`);
          }
        }
      } catch (error) {
        // 单个格式检查错误不影响整体结果，记录日志即可
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Metadata: Error checking ${format} in repository: ${msg}`);
      }
    };
    
    // 2. 创建外部API检查处理函数
    const handleExternalCheck = async () => {
      try {
        const result = await checkExternalFormatsAvailability(id, logger);
        
        // 添加外部API找到的格式
        result.formats.forEach(format => {
          state.foundFormats.add(format);
          logger.debug?.(`Metadata: Found ${format} in external API`);
        });
        
        // 设置翻译和罗马音状态
        if (result.hasTranslation) {
          state.hasTranslation = true;
          logger.debug?.(`Metadata: Translation available in external API`);
        }
        
        if (result.hasRomaji) {
          state.hasRomaji = true;
          logger.debug?.(`Metadata: Romaji available in external API`);
        }
        
        // 如果找到了格式，判断是否可以提前返回
        if (result.formats.length > 0 && state.foundFormats.size > 0) {
          logger.debug?.(`Metadata: Found formats in external API`);
        }
        
        // 处理错误
        if (result.error) {
          state.error = `External API error: ${result.error.message}`;
          state.statusCode = result.statusCode;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Metadata: Error checking external API: ${msg}`);
        state.error = `External API error: ${msg}`;
      }
    };
    
    // 3. 创建所有并行任务 - 仓库格式检查和外部API检查完全并行
    const allTasks = [
      ...uniqueRepoFormats.map(format => handleRepoFormatCheck(format)),
      handleExternalCheck()
    ];
    
    // 4. 使用Promise.race实现早期返回逻辑
    const monitorEarlyReturn = async () => {
      while (!state.earlyReturnTriggered && !abortController.signal.aborted) {
        // 每100ms检查一次是否可以提前返回
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // 条件1: 如果已经找到任何格式，且已经过了提前返回时间
        // 条件2: 如果找到至少2种格式，无论等待时间
        if ((state.shouldReturnEarly && state.foundFormats.size > 0) || 
            state.foundFormats.size >= 2) {
          state.earlyReturnTriggered = true;
          logger.info(`Metadata: Early return with ${state.foundFormats.size} formats found`);
          return;
        }
      }
    };
    
    // 5. 创建总超时Promise
    const timeoutPromise = new Promise<void>((_, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(new Error('Overall metadata check timed out'));
      });
    });
    
    // 6. 用Promise.race实现早期返回或超时
    await Promise.race([
      // 早期返回监控
      monitorEarlyReturn(),
      // 总超时
      timeoutPromise,
      // 如果所有任务都完成了（这种情况较少见，会等所有检查完成）
      Promise.all(allTasks).then(() => {
        logger.debug?.(`Metadata: All format checks completed normally`);
      })
    ]);
    
    // 7. 至此，要么提前返回、要么超时、要么所有任务都完成 - 构建响应
    logger.info(`Metadata: Check completed with ${state.foundFormats.size} formats found`);
    
    // 构建并返回结果
    const finalAvailableFormats = Array.from(state.foundFormats);
    
    if (finalAvailableFormats.length > 0) {
      return {
        found: true,
        id,
        availableFormats: finalAvailableFormats,
        hasTranslation: state.hasTranslation,
        hasRomaji: state.hasRomaji,
      };
    } else {
      return {
        found: false,
        id,
        error: state.error || "No lyric formats found in repository or external API.",
        statusCode: state.statusCode || 404
      };
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    
    // 检查是否是我们自己的超时错误
    if (err.message.includes('timed out') || err.name === 'AbortError') {
      logger.warn(`Metadata: ${err.message}`);
      // 超时了，但可能已经找到一些格式，还是可以返回
      const finalAvailableFormats = Array.from(state.foundFormats);
      
      if (finalAvailableFormats.length > 0) {
        logger.info(`Metadata: Returning ${finalAvailableFormats.length} formats despite timeout`);
        return {
          found: true,
          id,
          availableFormats: finalAvailableFormats,
          hasTranslation: state.hasTranslation,
          hasRomaji: state.hasRomaji,
        };
      } else {
        return {
          found: false,
          id,
          error: "Metadata check timed out without finding any formats",
          statusCode: 408 // Request Timeout
        };
      }
    }
    
    // 其他未预期的错误
    logger.error(`Metadata: Unexpected error during metadata check: ${err.message}`);
    return {
      found: false,
      id,
      error: `Failed to check lyric metadata: ${err.message}`,
      statusCode: 500
    };
  } finally {
    // 清理计时器
    clearTimeout(timeoutId);
    clearTimeout(earlyReturnId);
  }
}

// 更新 checkRepoFormatExistence 函数以支持超时
async function checkRepoFormatExistence(
  id: string,
  format: LyricFormat,
  logger: BasicLogger
): Promise<{ format: LyricFormat; exists: boolean; error?: Error }> {
  const url = buildRawUrl(id, format);
  logger.debug?.(`Metadata: Checking repo existence for ${format.toUpperCase()}: ${url}`);
  
  try {
    // 设置 2 秒超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    
    const response = await fetch(url, { 
      method: 'HEAD',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      logger.debug?.(`Metadata: Repo format ${format.toUpperCase()} exists`);
      return { format, exists: true };
    } else if (response.status === 404) {
      logger.debug?.(`Metadata: Repo format ${format.toUpperCase()} does not exist`);
      return { format, exists: false };
    } else {
      logger.warn(`Metadata: Repo format ${format.toUpperCase()} check returned status ${response.status}`);
      return { format, exists: false, error: new Error(`HTTP error ${response.status}`) };
    }
  } catch (err) {
    // 检查是否是超时错误
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn(`Metadata: Repo check for ${format} timed out after 2 seconds`);
      return { format, exists: false, error: new Error('Request timed out') };
    }
    
    const error = err instanceof Error ? err : new Error('Unknown fetch error');
    logger.error(`Metadata: Network error during repo check for ${format}: ${error.message}`);
    return { format, exists: false, error };
  }
}
