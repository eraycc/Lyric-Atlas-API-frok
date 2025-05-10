const { parentPort } = require('worker_threads');
const http2 = require('http2');

// 如果没有parentPort，说明不是在工作线程中运行
if (!parentPort) {
  console.error('This script must be run as a worker thread!');
  process.exit(1);
}

// HTTP/2连接缓存
const connectionCache = new Map();

// 获取或创建HTTP/2连接
function getConnection(origin) {
  if (connectionCache.has(origin)) {
    const existingClient = connectionCache.get(origin);
    if (!existingClient.destroyed) {
      return existingClient;
    }
    connectionCache.delete(origin);
  }

  const client = http2.connect(origin);
  
  client.on('error', (err) => {
    console.warn(`[Worker] HTTP/2 connection error: ${err.message}`);
    connectionCache.delete(origin);
  });
  
  client.on('close', () => {
    connectionCache.delete(origin);
  });
  
  connectionCache.set(origin, client);
  return client;
}

// 在工作线程中执行HEAD请求检查资源是否存在
async function checkResourceExists(baseUrl, path, timeout = 3000) {
  return new Promise((resolve) => {
    try {
      const client = getConnection(baseUrl);
      const fullPath = path.startsWith('/') ? path : `/${path}`;
      
      const req = client.request({
        ':path': fullPath,
        ':method': 'HEAD',
      });
      
      // 设置超时
      const timeoutId = setTimeout(() => {
        req.close();
        resolve({ exists: false, error: 'timeout' });
      }, timeout);
      
      req.on('response', (headers) => {
        clearTimeout(timeoutId);
        resolve({ 
          exists: headers[':status'] === 200,
          statusCode: headers[':status']
        });
        req.close();
      });
      
      req.on('error', (err) => {
        clearTimeout(timeoutId);
        resolve({ exists: false, error: err.message });
        req.close();
      });
      
      req.end();
    } catch (error) {
      resolve({ exists: false, error: error.message || 'Unknown error' });
    }
  });
}

// 处理检查多个格式的任务
async function handleCheckMultipleFormats(task) {
  const { id, formats, repoBaseUrl } = task;
  
  // 构建完整paths
  const paths = formats.map(format => `/Steve-XMH/amll-ttml-db/main/ncm-lyrics/${id}.${format}`);
  
  const results = await Promise.all(
    paths.map((path, index) => 
      checkResourceExists(repoBaseUrl, path)
        .then(result => ({ format: formats[index], ...result }))
    )
  );
  
  // 整理结果
  const availableFormats = [];
  const errors = {};
  
  for (const { format, exists, error } of results) {
    if (exists) {
      availableFormats.push(format);
    } else if (error) {
      errors[format] = error;
    }
  }
  
  return {
    availableFormats,
    errors
  };
}

// 监听来自主线程的消息
parentPort.on('message', async (task) => {
  try {
    let result;
    
    // 根据任务类型调用相应的处理函数
    switch (task.type) {
      case 'checkMultipleFormats':
        result = await handleCheckMultipleFormats(task);
        break;
      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }
    
    // 发送结果回主线程
    parentPort.postMessage(result);
  } catch (error) {
    // 发送错误回主线程
    parentPort.postMessage({
      error: error.message || 'Unknown error in worker',
      availableFormats: [],
      errors: { general: error.message || 'Unknown error in worker' }
    });
  }
});

// 在退出时关闭所有连接
process.on('exit', () => {
  for (const client of connectionCache.values()) {
    client.close();
  }
}); 