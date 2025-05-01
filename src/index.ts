import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { searchLyrics, SearchResult } from './lyricService.js'; // Import the service with .js extension
// Removed unused utils imports for now, service handles them
import cors from '@fastify/cors'; // 导入 CORS 插件

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

// 注册 CORS 插件以支持预检请求
server.register(cors, {
  // 配置 CORS 选项
  origin: true, // 允许所有源，或者指定允许的源，如 ['https://example.com']
  methods: ['GET', 'OPTIONS'], // 允许的 HTTP 方法
  allowedHeaders: ['Content-Type', 'Authorization'], // 允许的请求头
  exposedHeaders: ['Content-Range', 'X-Content-Range'], // 暴露给客户端的响应头
  credentials: true, // 允许跨域请求携带凭证
  maxAge: 86400, // 预检请求结果缓存时间（秒）
});

// Define a regex to match typical LRC/YRC timestamp lines
// MOVED TO utils.ts

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
