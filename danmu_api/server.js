// server.js - 智能服务器启动器：根据 Node.js 环境自动选择最优启动模式

// 加载 .env 文件中的环境变量（本地开发时使用）
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// .env 文件在项目根目录（server.js 的上一级目录）
const envPath = path.join(__dirname, '..', '.env');

function loadEnv() {
  try {
    dotenv.config({ path: envPath, override: true });
    console.log('[server] .env file loaded successfully');
  } catch (e) {
    console.log('[server] dotenv not available or .env file not found, using system environment variables');
  }
}

// 初始加载
loadEnv();

// 监听 .env 文件变化（仅在文件存在时）
let envWatcher = null;
let reloadTimer = null;

function setupEnvWatcher() {
  if (!fs.existsSync(envPath)) {
    console.log('[server] .env file not found, skipping file watcher');
    return;
  }

  try {
    const chokidar = require('chokidar');
    envWatcher = chokidar.watch(envPath, {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100
      }
    });

    envWatcher.on('change', () => {
      // 防抖：避免短时间内多次触发
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }

      reloadTimer = setTimeout(() => {
        console.log(`[server] .env file changed, reloading environment variables...`);

        // 读取新的 .env 文件内容
        try {
          const envContent = fs.readFileSync(envPath, 'utf8');
          const lines = envContent.split('\n');

          // 解析 .env 文件中的所有键
          const newEnvKeys = new Set();
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              const match = trimmed.match(/^([^=]+)=/);
              if (match) {
                newEnvKeys.add(match[1]);
              }
            }
          }

          // 删除 process.env 中旧的键（不在新 .env 文件中的键）
          for (const key of Object.keys(process.env)) {
            if (!newEnvKeys.has(key)) {
              delete process.env[key];
            }
          }

          // 清除 dotenv 缓存并重新加载环境变量
          delete require.cache[require.resolve('dotenv')];
          loadEnv();

          console.log('[server] Environment variables reloaded successfully');
          console.log('[server] Updated keys:', Array.from(newEnvKeys).join(', '));
        } catch (error) {
          console.log('[server] Error reloading .env file:', error.message);
        }

        reloadTimer = null;
      }, 200); // 200ms 防抖
    });

    envWatcher.on('unlink', () => {
      console.log('[server] .env file deleted, using default environment variables');
    });

    envWatcher.on('error', (error) => {
      console.log('[server] File watcher error:', error.message);
    });

    console.log('[server] .env file watcher started');
  } catch (e) {
    console.log('[server] chokidar not available, .env hot reload disabled');
  }
}

// 优雅关闭：清理文件监听器
function cleanupWatcher() {
  if (envWatcher) {
    console.log('[server] Closing file watcher...');
    envWatcher.close();
    envWatcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

// 监听进程退出信号
process.on('SIGTERM', cleanupWatcher);
process.on('SIGINT', cleanupWatcher);

// 导入 ES module 兼容层（始终加载，但内部会根据需要启用）
require('./esm-shim');

const http = require('http');
const https = require('https');
const url = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');

// --- 版本兼容性检测工具 ---
// 辅助函数：比较两个版本号字符串
function compareVersion(version1, version2) {
  const v1Parts = version1.split('.').map(Number);
  const v2Parts = version2.split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;

    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
  }

  return 0;
}

// 检测是否需要异步启动（兼容层模式）
function needsAsyncStartup() {
  try {
    const nodeVersion = process.versions.node;
    // 检查 Node.js 版本是否 >= v20.19.0 (此版本及更高版本内置了 fetch API，对 node-fetch v3 的兼容性更好)
    const isNodeCompatible = compareVersion(nodeVersion, '20.19.0') >= 0;

    // 尝试检测已安装的 node-fetch 版本
    const packagePath = require.resolve('node-fetch/package.json');
    const pkg = require(packagePath);
    // 检查 node-fetch 是否是 v3.x 版本 (v3.x 在旧版 Node.js 中可能存在一些加载问题)
    const isNodeFetchV3 = pkg.version.startsWith('3.');

    // 核心逻辑：只有在 Node.js < v20.19.0 且同时使用 node-fetch v3 时，才需要特殊的异步启动（兼容层模式）
    const needsAsync = !isNodeCompatible && isNodeFetchV3;

    console.log(`[server] Environment check: Node ${nodeVersion}, node-fetch ${pkg.version}`);
    console.log(`[server] Node.js compatible (>=20.19.0): ${isNodeCompatible}`);
    console.log(`[server] node-fetch v3: ${isNodeFetchV3}`);
    console.log(`[server] Needs async startup: ${needsAsync}`);

    return needsAsync;

  } catch (e) {
    // 无法检测或者 node-fetch 不存在，使用同步启动
    console.log('[server] Cannot detect node-fetch, using sync startup');
    return false;
  }
}

// --- 核心 HTTP 服务器（端口 9321）逻辑 ---
// 创建主业务服务器实例（将 Node.js 请求转换为 Web API Request，并调用 worker.js 处理）
function createServer() {
  // 导入所需的 fetch 兼容对象
  const fetch = require('node-fetch');
  const { Request, Response } = fetch;
  // 导入核心请求处理逻辑
  const { handleRequest } = require('./worker.js'); // 直接导入 handleRequest 函数

  return http.createServer(async (req, res) => {
    try {
      // 构造完整的请求 URL
      const fullUrl = `http://${req.headers.host}${req.url}`;

      // 获取请求客户端的ip，兼容反向代理场景
      let clientIp = 'unknown';
      
      // 优先级：X-Forwarded-For > X-Real-IP > 直接连接IP
      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        // X-Forwarded-For 可能包含多个IP（代理链），第一个是真实客户端IP
        clientIp = forwardedFor.split(',')[0].trim();
        console.log(`[server] Using X-Forwarded-For IP: ${clientIp}`);
      } else if (req.headers['x-real-ip']) {
        clientIp = req.headers['x-real-ip'];
        console.log(`[server] Using X-Real-IP: ${clientIp}`);
      } else {
        clientIp = req.connection.remoteAddress || 'unknown';
        console.log(`[server] Using direct connection IP: ${clientIp}`);
      }
      
      // 清理IPv6前缀（如果存在）
      if (clientIp && clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
      }

      // 异步读取 POST/PUT 请求的请求体
      let body;
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        });
      }

      // 创建一个 Web API 兼容的 Request 对象
      const webRequest = new Request(fullUrl, {
        method: req.method,
        headers: req.headers,
        body: body || undefined, // 对于 GET/HEAD 等请求，body 为 undefined
      });

      // 调用核心处理函数，并标识平台为 "node"
      const webResponse = await handleRequest(webRequest, process.env, "node", clientIp);

      // 将 Web API Response 对象转换为 Node.js 响应
      res.statusCode = webResponse.status;
      // 设置响应头
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      // 发送响应体
      const responseText = await webResponse.text();
      res.end(responseText);
    } catch (error) {
      console.error('Server error:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
}

// 代理服务器逻辑（用于5321端口）
function createProxyServer() {
  return http.createServer((req, res) => {
    const queryObject = url.parse(req.url, true).query;

    if (queryObject.url) {
      const targetUrl = queryObject.url;
      console.log('Target URL:', targetUrl);

      // 从环境变量获取代理地址
      const proxyUrl = process.env.PROXY_URL;

      const urlObj = new URL(targetUrl);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET'
      };

      // 如果设置了代理，则使用代理
      if (proxyUrl) {
        options.agent = new HttpsProxyAgent(proxyUrl);
        console.log('Using proxy:', proxyUrl);
      } else {
        console.log('No proxy configured, direct connection');
      }

      const protocol = urlObj.protocol === 'https:' ? https : http;

      const proxyReq = protocol.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });

      proxyReq.on('error', (err) => {
        console.error('Proxy request error:', err);
        res.statusCode = 500;
        res.end('Proxy Error: ' + err.message);
      });

      proxyReq.end();
    } else {
      res.statusCode = 400;
      res.end('Bad Request: Missing URL parameter');
    }
  });
}

// --- 启动函数 ---
// 同步启动（最优/默认路径，适用于常规已兼容环境）
function startServerSync() {
  console.log('[server] Starting server synchronously (optimal path)');

  // 设置 .env 文件监听
  setupEnvWatcher();

  // 启动主业务服务器 (9321)
  const server = createServer();
  server.listen(9321, '0.0.0.0', () => {
    console.log('Server running on http://0.0.0.0:9321');
  });

  // 启动5321端口的代理服务
  const proxyServer = createProxyServer();

  proxyServer.listen(5321, '0.0.0.0', () => {
    console.log('Proxy server running on http://0.0.0.0:5321');
  });
}

// 异步启动（兼容层模式路径，适用于 Node.js < v20.19.0 + node-fetch v3）
async function startServerAsync() {
  try {
    console.log('[server] Starting server asynchronously (compatibility mode for Node.js <20.19.0 + node-fetch v3)');

    // 设置 .env 文件监听
    setupEnvWatcher();

    // 预加载 node-fetch v3（解决特定环境下 node-fetch v3 的加载问题）
    if (typeof global.loadNodeFetch === 'function') {
      console.log('[server] Pre-loading node-fetch v3...');
      await global.loadNodeFetch();
      console.log('[server] node-fetch v3 loaded successfully');
    }

    // 启动主业务服务器 (9321)
    const server = createServer();
    server.listen(9321, '0.0.0.0', () => {
      console.log('Server running on http://0.0.0.0:9321 (compatibility mode)');
    });

    // 启动5321端口的代理服务
    const proxyServer = createProxyServer();

    proxyServer.listen(5321, '0.0.0.0', () => {
      console.log('Proxy server running on http://0.0.0.0:5321 (compatibility mode)');
    });

  } catch (error) {
    console.error('[server] Failed to start server:', error);
    process.exit(1);
  }
}

// --- 启动决策逻辑 ---
// 智能选择启动方式：如果环境需要兼容，则异步启动；否则同步启动。
if (needsAsyncStartup()) {
  startServerAsync();
} else {
  startServerSync();
}
