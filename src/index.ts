import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { searchLyrics, SearchResult } from './lyricService.js'; // Import the service with .js extension
// Removed unused utils imports for now, service handles them

// Define interface for query parameters for better type safety
interface SearchQuery {
  id?: string;
  fallback?: string;
  fixedVersion?: string;
}

// --- Allowed Formats & Helper ---
// MOVED TO utils.ts

// --- Read External API URL from Environment Variable ---
const EXTERNAL_API_BASE_URL = process.env.EXTERNAL_NCM_API_URL;
// This should be checked at startup

// --- Fastify Server Instance ---
// Enable logger for development
const server = fastify({ logger: true });

// 添加一个全局钩子来添加CORS头
server.addHook('onRequest', (request, reply, done) => {
  // 设置CORS headers
  reply.header('Access-Control-Allow-Origin', '*'); // 生产环境请指定具体的源
  reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  reply.header('Access-Control-Expose-Headers', 'Content-Range, X-Content-Range');
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Access-Control-Max-Age', '86400');

  // 如果是预检请求，直接返回200响应并结束处理
  if (request.method === 'OPTIONS') {
    server.log.info(`Received OPTIONS request for: ${request.url}`); // 添加日志
    reply.code(204).send(); // 使用 204 No Content 更符合规范，且可以避免发送空响应体
    return; // 确保请求在此处结束
  }
  
  done(); // 对于非OPTIONS请求，继续处理
});

// Helper function to extract valid lyric lines
// MOVED TO utils.ts

// --- API Endpoint ---
// Register route with query parameter typing
server.get<{ Querystring: SearchQuery }>('/api/search', async (request: FastifyRequest<{ Querystring: SearchQuery }>, reply: FastifyReply) => {
  const { id, fallback: fallbackQuery, fixedVersion: fixedVersionRaw } = request.query;

  if (!id) {
    // Use Fastify's reply object to send response with status code
    return reply.code(400).send({ error: 'Missing id parameter' });
  }

  server.log.info(`API: Received request for ID: ${id}, fixed: ${fixedVersionRaw}, fallback: ${fallbackQuery}`);

  try {
    // Call the lyric service to handle fetching and fallbacks
    const result: SearchResult = await searchLyrics(id, {
      fixedVersion: fixedVersionRaw, // Pass raw string, service will handle validation/case
      fallback: fallbackQuery,
      logger: server.log // Pass logger instance
    });

    // Send response based on service result
    if (result.found) {
      server.log.info(`API: Found lyrics for ID: ${id}, Format: ${result.format}, Source: ${result.source}`);
      // Service returns the exact structure needed for the success response
      return reply.send(result);
    } else {
      // Service returns structure needed for error response (found: false, id, error, statusCode?)
      const statusCode = result.statusCode || 404; // Default to 404 if service doesn't provide specific error code
      server.log.info(`API: Lyrics not found or error for ID: ${id}. Status: ${statusCode}, Error: ${result.error}`);
      return reply.code(statusCode).send(result);
    }

  } catch (error) {
    // Catch unexpected errors ONLY during the API handler execution (service should handle its own errors)
    server.log.error({ msg: `Unexpected error during API handler execution for ID: ${id}`, error });
    const errorMessage = error instanceof Error ? error.message : 'Unknown processing error';
    // Return a generic 500 error for unexpected issues in the handler itself
    return reply.code(500).send({ found: false, id, error: `Failed to process lyric request: ${errorMessage}` });
  }
});

// Helper function to fetch from GitHub Repo
// MOVED TO lyricService.ts

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

// 为 /api/search 添加显式的 OPTIONS 路由处理器
// 即使有 onRequest 钩子，在 Vercel 环境下显式路由可能更可靠
server.options('/api/search', async (request, reply) => {
  // CORS 头应该由 onRequest 钩子或 vercel.json 处理
  // 这里我们只需要确保返回 204 No Content
  server.log.info(`Explicit OPTIONS handler for /api/search triggered.`);
  return reply.code(204).send();
});
