import { Worker } from 'worker_threads';
import path from 'path';
import { getLogger } from './utils';
import { LyricFormat } from './utils';

const logger = getLogger('Workers');

// 工作线程池配置
const MAX_WORKERS = Math.max(2, Math.min(4, Math.floor(require('os').cpus().length / 2)));
const WORKER_IDLE_TIMEOUT_MS = 30 * 1000; // 30秒空闲后释放工作线程

// 工作线程池
class WorkerPool {
  private workers: Worker[] = [];
  private busyWorkers = new Set<Worker>();
  private taskQueue: { task: any, resolve: Function, reject: Function }[] = [];
  private idleTimers = new Map<Worker, NodeJS.Timeout>();

  constructor(private maxWorkers: number) {
    logger.info(`Initializing worker pool with max ${maxWorkers} workers`);
  }

  // 提交任务到工作线程池
  async runTask<T>(taskData: any): Promise<T> {
    return new Promise((resolve, reject) => {
      // 将任务添加到队列
      this.taskQueue.push({ task: taskData, resolve, reject });
      
      // 尝试启动任务处理
      this.processQueue();
    });
  }

  // 处理任务队列
  private processQueue() {
    // 如果没有等待的任务，则返回
    if (this.taskQueue.length === 0) return;

    // 尝试获取可用的工作线程
    const worker = this.getAvailableWorker();
    if (!worker) {
      // 如果没有可用的工作线程，则等待
      logger.debug('No available workers, waiting for one to become available');
      return;
    }

    // 从队列中获取下一个任务
    const { task, resolve, reject } = this.taskQueue.shift()!;
    
    // 标记工作线程为忙碌状态
    this.busyWorkers.add(worker);
    
    // 取消空闲计时器
    const idleTimer = this.idleTimers.get(worker);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(worker);
    }

    // 创建一次性消息处理器
    const messageHandler = (result: any) => {
      worker.removeListener('message', messageHandler);
      worker.removeListener('error', errorHandler);
      
      // 标记工作线程为可用
      this.busyWorkers.delete(worker);
      
      // 设置空闲计时器
      const timer = setTimeout(() => {
        this.terminateWorker(worker);
      }, WORKER_IDLE_TIMEOUT_MS);
      
      this.idleTimers.set(worker, timer);
      
      // 处理下一个任务
      this.processQueue();
      
      // 返回结果
      resolve(result);
    };

    // 创建一次性错误处理器
    const errorHandler = (error: Error) => {
      worker.removeListener('message', messageHandler);
      worker.removeListener('error', errorHandler);
      
      // 标记工作线程为可用
      this.busyWorkers.delete(worker);
      
      // 如果工作线程出错，则终止它并创建一个新的
      this.terminateWorker(worker);
      this.createWorker();
      
      // 处理下一个任务
      this.processQueue();
      
      // 返回错误
      reject(error);
    };

    // 监听工作线程的消息和错误
    worker.once('message', messageHandler);
    worker.once('error', errorHandler);

    // 发送任务到工作线程
    worker.postMessage(task);
  }

  // 获取一个可用的工作线程
  private getAvailableWorker(): Worker | null {
    // 尝试找到一个未被使用的工作线程
    for (const worker of this.workers) {
      if (!this.busyWorkers.has(worker)) {
        return worker;
      }
    }

    // 如果所有工作线程都在使用中，且未达到最大数量，则创建一个新的
    if (this.workers.length < this.maxWorkers) {
      return this.createWorker();
    }

    // 如果所有工作线程都在使用中，且已达到最大数量，则返回null
    return null;
  }

  // 创建一个新的工作线程
  private createWorker(): Worker {
    // 工作线程代码路径 - 这个文件会在下面创建
    const workerScriptPath = path.resolve(__dirname, 'worker-scripts', 'format-checker-worker.js');
    
    logger.debug(`Creating new worker with script ${workerScriptPath}`);
    
    const worker = new Worker(workerScriptPath);
    this.workers.push(worker);
    
    return worker;
  }

  // 终止一个工作线程
  private terminateWorker(worker: Worker) {
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      logger.debug('Terminating idle worker');
      
      // 移除空闲计时器
      const timer = this.idleTimers.get(worker);
      if (timer) {
        clearTimeout(timer);
        this.idleTimers.delete(worker);
      }
      
      // 终止工作线程
      worker.terminate();
      
      // 从列表中移除
      this.workers.splice(index, 1);
      this.busyWorkers.delete(worker);
    }
  }

  // 关闭所有工作线程
  async shutdown() {
    logger.info(`Shutting down worker pool with ${this.workers.length} workers`);
    
    // 清除所有空闲计时器
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    
    // 终止所有工作线程
    const terminationPromises = this.workers.map(worker => worker.terminate());
    
    // 清空工作线程列表
    this.workers = [];
    this.busyWorkers.clear();
    
    // 等待所有工作线程终止
    await Promise.all(terminationPromises);
    
    logger.info('Worker pool shutdown complete');
  }
}

// 创建工作线程池
const workerPool = new WorkerPool(MAX_WORKERS);

// 需要创建的工作线程脚本目录
const workerScriptsDir = path.resolve(__dirname, 'worker-scripts');

// 格式检查任务接口
interface FormatCheckTask {
  type: 'checkMultipleFormats';
  id: string;
  formats: LyricFormat[];
  repoBaseUrl: string;
}

// 格式检查结果接口
interface FormatCheckResult {
  availableFormats: LyricFormat[];
  errors: Record<string, string>;
}

// 使用工作线程检查多个歌词格式
export async function checkMultipleFormatsWithWorker(
  id: string,
  formats: LyricFormat[],
  repoBaseUrl: string = 'https://raw.githubusercontent.com'
): Promise<FormatCheckResult> {
  const task: FormatCheckTask = {
    type: 'checkMultipleFormats',
    id,
    formats,
    repoBaseUrl
  };

  try {
    const result = await workerPool.runTask<FormatCheckResult>(task);
    return result;
  } catch (error) {
    logger.error(`Worker task failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      availableFormats: [],
      errors: { general: `Worker task failed: ${error instanceof Error ? error.message : String(error)}` }
    };
  }
}

// 优雅关闭工作线程池
export async function shutdownWorkers() {
  await workerPool.shutdown();
} 