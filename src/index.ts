import fastify, { FastifyRequest, FastifyReply } from 'fastify';

// Define interface for query parameters for better type safety
interface SearchQuery {
  id?: string;
  fallback?: string;
  fixedVersion?: string;
}

// --- Allowed Formats & Helper ---
type LyricFormat = 'ttml' | 'yrc' | 'lrc' | 'eslrc';
const ALLOWED_FORMATS: LyricFormat[] = ['ttml', 'yrc', 'lrc', 'eslrc'];
// Default *fallback* order, excluding ttml initially
const DEFAULT_FALLBACK_ORDER: LyricFormat[] = ['yrc', 'lrc', 'eslrc'];

const isValidFormat = (format: string | undefined | null): format is LyricFormat => {
  if (!format) return false;
  return ALLOWED_FORMATS.includes(format as LyricFormat);
};

const buildRawUrl = (id: string, format: LyricFormat): string => {
  const sanitizedId = encodeURIComponent(id);
  const baseUrl = 'https://raw.githubusercontent.com/Steve-XMH/amll-ttml-db/main/ncm-lyrics/';
  return `${baseUrl}${sanitizedId}.${format}`;
};

// --- Read External API URL from Environment Variable ---
const EXTERNAL_API_BASE_URL = process.env.EXTERNAL_NCM_API_URL;

// buildExternalApiUrl now relies on EXTERNAL_API_BASE_URL being set
const buildExternalApiUrl = (id: string): string => {
    if (!EXTERNAL_API_BASE_URL) {
        // This case should ideally be prevented by the startup check
        throw new Error("External API base URL is not configured.");
    }
    return `${EXTERNAL_API_BASE_URL}?id=${encodeURIComponent(id)}`;
}

// Define result types for promises
type FetchResult =
  | { status: 'found'; format: LyricFormat; content: string }
  | { status: 'notfound'; format: LyricFormat }
  | { status: 'error'; format: LyricFormat; statusCode?: number; error: Error };

// --- Fastify Server Instance ---
// Enable logger for development
const server = fastify({ logger: true });

// --- API Endpoint ---
// Register route with query parameter typing
server.get<{ Querystring: SearchQuery }>('/api/search', async (request: FastifyRequest<{ Querystring: SearchQuery }>, reply: FastifyReply) => {
  const { id, fallback: fallbackQuery, fixedVersion: fixedVersionRaw } = request.query;
  const fixedVersionQuery = fixedVersionRaw?.toLowerCase();

  if (!id) {
    // Use Fastify's reply object to send response with status code
    return reply.code(400).send({ error: 'Missing id parameter' });
  }

  server.log.info(`Processing request for ID: ${id}, fixed: ${fixedVersionQuery}, fallback: ${fallbackQuery}`);

  try {
    // --- Handle fixedVersion (fetches only from repo) ---
    if (isValidFormat(fixedVersionQuery)) {
      server.log.info(`Handling fixedVersion request for format: ${fixedVersionQuery}`);
      const result = await fetchRepoLyric(id, fixedVersionQuery); // Use repo fetcher
      if (result.status === 'found') {
        return reply.send({ found: true, id, format: result.format, source: 'repository', content: result.content });
      } else if (result.status === 'notfound') {
        return reply.code(404).send({ found: false, id, error: `Lyrics not found for fixed format: ${fixedVersionQuery}` });
      } else { // status === 'error'
        const statusCode = result.statusCode && result.statusCode >= 500 ? 502 : 500;
        return reply.code(statusCode).send({ error: `Failed to fetch fixed format ${fixedVersionQuery}: ${result.error.message}` });
      }
    }

    // --- Handle TTML first (from repo) ---
    server.log.info(`Attempting primary format: TTML from repository`);
    const ttmlResult = await fetchRepoLyric(id, 'ttml');

    if (ttmlResult.status === 'found') {
      server.log.info(`Primary format TTML found in repository for ID: ${id}. Returning.`);
      return reply.send({ found: true, id, format: ttmlResult.format, source: 'repository', content: ttmlResult.content });
    }

    if (ttmlResult.status === 'error') {
      server.log.error(`Error fetching primary format TTML from repository. Failing request. Error: ${ttmlResult.error.message}`);
      const statusCode = ttmlResult.statusCode && ttmlResult.statusCode >= 500 ? 502 : 500;
      return reply.code(statusCode).send({ error: `Failed to fetch primary format TTML: ${ttmlResult.error.message}` });
    }

    // --- TTML was 'notfound' in repo, proceed to repo fallbacks ---
    server.log.info(`Primary format TTML not found (404) in repository. Proceeding to repository fallbacks.`);

    let fallbackOrder: LyricFormat[];
    if (fallbackQuery) {
      fallbackOrder = fallbackQuery.split(',').map((f: string) => f.trim().toLowerCase()).filter((f): f is LyricFormat => isValidFormat(f) && f !== 'ttml');
      if (fallbackOrder.length === 0 && fallbackQuery.split(',').length > 0) {
        server.log.warn(`Fallback query provided ("${fallbackQuery}") but resulted in no valid fallback formats after filtering.`);
      }
    } else {
      fallbackOrder = DEFAULT_FALLBACK_ORDER;
    }

    server.log.info(`Checking repository fallback formats in order: ${fallbackOrder.join(', ') || 'None'}`);

    for (const fallbackFormat of fallbackOrder) {
      const fallbackResult = await fetchRepoLyric(id, fallbackFormat); // Use repo fetcher
      if (fallbackResult.status === 'found') {
        server.log.info(`Repository fallback format ${fallbackFormat.toUpperCase()} found for ID: ${id}. Returning.`);
        return reply.send({ found: true, id, format: fallbackResult.format, source: 'repository', content: fallbackResult.content });
      }
      if (fallbackResult.status === 'error') {
        server.log.error(`Error fetching repository fallback format ${fallbackFormat.toUpperCase()}. Failing request. Error: ${fallbackResult.error.message}`);
        const statusCode = fallbackResult.statusCode && fallbackResult.statusCode >= 500 ? 502 : 500;
        return reply.code(statusCode).send({ error: `Failed to fetch repository fallback format ${fallbackFormat.toUpperCase()}: ${fallbackResult.error.message}` });
      }
      server.log.info(`Repository fallback format ${fallbackFormat.toUpperCase()} not found (404). Continuing.`);
    }

    // --- All repository checks failed (404), proceed to External API Fallback ---
    server.log.info(`No lyrics found in repository for ID: ${id}. Trying external API fallback.`);
    const externalUrl = buildExternalApiUrl(id);

    try {
      const externalResponse = await fetch(externalUrl);
      if (!externalResponse.ok) {
        server.log.error(`External API fetch failed with status: ${externalResponse.status} for URL: ${externalUrl}`);
        return reply.code(502).send({ found: false, id, error: `External API fallback failed with status ${externalResponse.status}` });
      }

      // Try parsing JSON
      let externalData;
      try {
        externalData = await externalResponse.json() as any; // Use 'as any' for simplicity or define a proper type
      } catch (parseError) {
        server.log.error(`Failed to parse JSON from external API fallback for ID: ${id}`, parseError);
        return reply.code(502).send({ found: false, id, error: 'External API fallback returned invalid JSON.' });
      }

      // Check for YRC lyric
      if (externalData?.yrc?.lyric) {
        server.log.info(`Found YRC lyrics in external API fallback for ID: ${id}. Returning.`);
        return reply.send({ found: true, id, format: 'yrc', source: 'external', content: externalData.yrc.lyric });
      }

      // Check for LRC lyric if YRC not found
      if (externalData?.lrc?.lyric) {
        server.log.info(`Found LRC lyrics in external API fallback for ID: ${id}. Returning.`);
        return reply.send({ found: true, id, format: 'lrc', source: 'external', content: externalData.lrc.lyric });
      }

      // If neither YRC nor LRC found in external API response
      server.log.info(`No usable lyrics (YRC/LRC) found in external API response for ID: ${id}.`);
      return reply.code(404).send({ found: false, id, error: 'Lyrics not found in repository or external API' });

    } catch (externalFetchError) {
      server.log.error(`Network error during external API fallback fetch for ID: ${id}`, externalFetchError);
      const errorMessage = externalFetchError instanceof Error ? externalFetchError.message : 'Unknown external fetch error';
      return reply.code(502).send({ found: false, id, error: `External API fallback failed: ${errorMessage}` });
    }

  } catch (error) {
    // Catch unexpected errors during the overall process
    server.log.error({ msg: `Unexpected error during handler execution for ID: ${id}`, error });
    const errorMessage = error instanceof Error ? error.message : 'Unknown processing error';
    return reply.code(500).send({ error: `Failed to process lyric request: ${errorMessage}` });
  }
});

// Helper function to fetch from GitHub Repo
async function fetchRepoLyric(id: string, format: LyricFormat): Promise<FetchResult> {
  const url = buildRawUrl(id, format);
  server.log.info(`Attempting fetch from GitHub repo for ${format.toUpperCase()}: ${url}`);
  try {
    const response = await fetch(url);
    if (response.ok) {
      const content = await response.text();
      server.log.info(`Repo fetch success for ${format.toUpperCase()} (status: ${response.status})`);
      return { status: 'found', format, content };
    } else if (response.status === 404) {
      server.log.info(`Repo fetch resulted in 404 for ${format.toUpperCase()}`);
      return { status: 'notfound', format };
    } else {
      server.log.error(`Repo fetch failed for ${format.toUpperCase()} with HTTP status ${response.status}`);
      return { status: 'error', format, statusCode: response.status, error: new Error(`HTTP error ${response.status}`) };
    }
  } catch (err) {
    server.log.error(`Network error during repo fetch for ${format.toUpperCase()}`, err);
    const error = err instanceof Error ? err : new Error('Unknown fetch error');
    return { status: 'error', format, error };
  }
}

// --- Server Startup Logic ---
const start = async () => {
  // --- CHECK REQUIRED ENV VARS ---
  if (!EXTERNAL_API_BASE_URL) {
    console.error("FATAL ERROR: Required environment variable EXTERNAL_NCM_API_URL is not set.");
    process.exit(1); // Exit if required config is missing
  }
  console.log(`Using external API URL: ${EXTERNAL_API_BASE_URL}`); // Log after confirmation

  const port = parseInt(process.env.PORT || '3000', 10);
  try {
    await server.listen({ port: port, host: '0.0.0.0' });
    // Logger will automatically print the address
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

// Vercel 自动注入 VERCEL 环境变量，若存在则导出 handler 供无服务器函数使用，否则本地/传统环境直接监听端口。

export default async function handler(req: any, res: any) {
  // 确保 Fastify 实例已就绪
  await server.ready();
  // 复用 Fastify 内部的 Node 原生服务器处理请求
  server.server.emit('request', req, res);
}

if (!process.env.VERCEL) {
  // 非 Vercel 环境（本地开发或其他平台）正常启动监听端口
  start();
}
