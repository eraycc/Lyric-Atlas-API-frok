import { request } from 'undici';
import * as http2 from 'http2';
import { getLogger } from './utils';
import pLimit from 'p-limit';

const logger = getLogger('HttpClient');

// 创建并发限制器
const MAX_CONCURRENT_REQUESTS = 15;
const requestLimit = pLimit(MAX_CONCURRENT_REQUESTS);

// HTTP/2连接缓存
interface Http2ClientEntry {
  client: http2.ClientHttp2Session;
  lastUsed: number;
}

const http2Connections = new Map<string, Http2ClientEntry>();

// HTTP/2 Session管理
function getHttp2Session(origin: string): http2.ClientHttp2Session {
  const existingEntry = http2Connections.get(origin);
  
  if (existingEntry && !existingEntry.client.destroyed) {
    // 更新最后使用时间
    existingEntry.lastUsed = Date.now();
    return existingEntry.client;
  }

  // 创建新连接
  logger.debug(`Creating new HTTP/2 connection to ${origin}`);
  const client = http2.connect(origin);
  
  // 设置错误处理
  client.on('error', (err) => {
    logger.warn(`HTTP/2 connection error for ${origin}: ${err.message}`);
    http2Connections.delete(origin);
  });
  
  // 连接关闭时从缓存中移除
  client.on('close', () => {
    logger.debug(`HTTP/2 connection to ${origin} closed`);
    http2Connections.delete(origin);
  });

  // 保存连接
  http2Connections.set(origin, {
    client,
    lastUsed: Date.now()
  });

  return client;
}

// 清理未使用的HTTP/2连接
export function cleanupHttp2Connections(maxIdleTimeMs: number = 5 * 60 * 1000): void {
  const now = Date.now();
  
  for (const [origin, entry] of http2Connections.entries()) {
    if (now - entry.lastUsed > maxIdleTimeMs) {
      logger.debug(`Closing idle HTTP/2 connection to ${origin}`);
      entry.client.close();
      http2Connections.delete(origin);
    }
  }
}

// 设置自动清理
setInterval(() => cleanupHttp2Connections(), 60 * 1000);

/**
 * 使用Undici执行HEAD请求检查资源是否存在
 */
export async function checkResourceExists(
  url: string,
  options: {
    timeout?: number;
    retries?: number;
  } = {}
): Promise<{ exists: boolean; statusCode?: number; error?: Error }> {
  const { timeout = 2000, retries = 1 } = options;
  
  return requestLimit(async () => {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        logger.debug(`Retry ${attempt}/${retries} for ${url}`);
      }
      
      try {
        const { statusCode } = await request(url, {
          method: 'HEAD',
          headersTimeout: timeout,
          bodyTimeout: timeout,
        });
        
        return { 
          exists: statusCode === 200,
          statusCode 
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.debug(`Request failed for ${url}: ${lastError.message}`);
        
        // 如果不是最后一次尝试，等待一点时间再重试
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    }
    
    return { 
      exists: false, 
      error: lastError 
    };
  });
}

/**
 * 使用HTTP/2执行多个HEAD请求检查资源是否存在
 * 适用于相同域名下的多个资源
 */
export async function checkMultipleResourcesHttp2(
  baseUrl: string, // 例如: 'https://raw.githubusercontent.com'
  paths: string[], // 例如: ['/user/repo/file1.txt', '/user/repo/file2.txt']
  options: {
    timeout?: number;
  } = {}
): Promise<Map<string, { exists: boolean; statusCode?: number; error?: string }>> {
  const { timeout = 3000 } = options;
  const results = new Map<string, { exists: boolean; statusCode?: number; error?: string }>();
  
  try {
    const client = getHttp2Session(baseUrl);
    
    // 为每个路径创建Promise
    const requests = paths.map(async (path) => {
      return new Promise<void>((resolve) => {
        const fullPath = path.startsWith('/') ? path : `/${path}`;
        
        const req = client.request({
          ':path': fullPath,
          ':method': 'HEAD',
        });
        
        // 设置超时
        const timeoutId = setTimeout(() => {
          req.close();
          results.set(path, { exists: false, error: 'timeout' });
          resolve();
        }, timeout);
        
        req.on('response', (headers) => {
          clearTimeout(timeoutId);
          const status = headers[':status'] as number;
          results.set(path, { 
            exists: status === 200,
            statusCode: status
          });
          req.close();
          resolve();
        });
        
        req.on('error', (err) => {
          clearTimeout(timeoutId);
          results.set(path, { exists: false, error: err.message });
          resolve();
        });
        
        // 结束请求
        req.end();
      });
    });
    
    // 等待所有请求完成
    await Promise.all(requests);
    
    return results;
  } catch (error) {
    // 如果HTTP/2连接失败，则为所有路径设置错误
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`HTTP/2 batch request failed: ${errorMessage}`);
    
    paths.forEach(path => {
      if (!results.has(path)) {
        results.set(path, { exists: false, error: errorMessage });
      }
    });
    
    return results;
  }
}

/**
 * 使用Undici获取完整响应内容
 */
export async function fetchContent(
  url: string, 
  options: {
    timeout?: number;
    retries?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<{ content?: string; statusCode?: number; error?: Error }> {
  const { timeout = 5000, retries = 1, headers = {} } = options;
  
  return requestLimit(async () => {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        logger.debug(`Retry ${attempt}/${retries} for ${url}`);
      }
      
      try {
        const { statusCode, body } = await request(url, {
          method: 'GET',
          headers,
          headersTimeout: timeout,
          bodyTimeout: timeout,
        });
        
        if (statusCode === 200) {
          const content = await body.text();
          return { content, statusCode };
        } else {
          return { statusCode };
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.debug(`Fetch failed for ${url}: ${lastError.message}`);
        
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    
    return { error: lastError };
  });
} 