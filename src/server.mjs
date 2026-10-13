import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ROOT, loadConfig } from './config.mjs';
import { AppError } from './errors.mjs';
import { McpClient, READ_ONLY_TOOLS, redact } from './mcp.mjs';
import { planMeals } from './planner.mjs';
import { LiveBudgetService } from './live.mjs';
import { RecommendationService } from './recommend.mjs';

const BODY_LIMIT = 64 * 1024;
const STATIC_FILES = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'], ['/assets/hero.svg', 'assets/hero.svg'],
  ['/live.js', 'live.js'], ['/live.css', 'live.css'],
  ['/assets/food.svg', 'assets/food.svg'], ['/assets/icon.svg', 'assets/icon.svg'],
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const LIVE_ROUTES = new Map([
  ['/api/live/stores', 'stores'], ['/api/live/menu', 'menu'],
  ['/api/live/detail', 'detail'], ['/api/live/quote', 'quote'],
  ['/api/live/recommend', 'recommend'],
]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new AppError('CONTENT_TYPE', '请求需使用 application/json。', 415);
  }
  return new Promise((resolveBody, reject) => {
    let size = 0, over = Number(req.headers['content-length'] ?? 0) > BODY_LIMIT;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (over) return;
      if (size > BODY_LIMIT) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      // Finish draining without buffering before replying. Closing a still-uploading
      // Connection: close socket can reset the TCP connection and lose the 413 on Windows.
      // The server requestTimeout bounds incomplete uploads.
      if (over) { reject(new AppError('BODY_TOO_LARGE', '请求内容过大。', 413)); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AppError('INVALID_JSON', '请求不是有效 JSON。')); }
    });
    req.on('error', () => reject(new AppError('REQUEST_ABORTED', '请求已中断。')));
  });
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ token = '', mcpClient, catalogue, clock = Date.now } = {}) {
  const client = mcpClient ?? new McpClient({ token });
  let upstreamWindow = clock(), upstreamCount = 0;
  const reserveUpstream = () => {
    if (clock() - upstreamWindow >= 60000) { upstreamWindow = clock(); upstreamCount = 0; }
    if (upstreamCount >= 30) throw new AppError('LOCAL_UPSTREAM_LIMIT', '本机每分钟最多 30 次 MCP 工具调用，自动推荐也逐次计数；请一分钟后重试。', 429);
    upstreamCount++;
  };
  const mcp = {
    get configured() { return client.configured; },
    async callTool(...args) { reserveUpstream(); return client.callTool(...args); },
    async listTools(...args) { reserveUpstream(); return client.listTools(...args); },
  };
  const live = new LiveBudgetService({ mcp, clock });
  const recommendations = new RecommendationService({ live, mcp, clock });
  const menu = catalogue ?? JSON.parse(readFileSync(resolve(ROOT, 'data/demo.json'), 'utf8'));
  const csrfToken = randomBytes(32).toString('hex');
  let mcpWindow = clock(), mcpCount = 0, inFlight = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    try {
      const port = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!hosts.has(req.headers.host)) throw new AppError('BAD_HOST', '仅允许从本机地址访问。', 403);
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError('BAD_ORIGIN', '拒绝跨站请求。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('BAD_ORIGIN', '拒绝跨站请求。', 403);
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, { ok: true, version: '0.1.0', mode: 'demo',
          mcpConfigured: mcp.configured, liveBudget: true, liveRecommendations: true, readOnlyTools: READ_ONLY_TOOLS });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { csrfToken });
      if (req.method === 'GET' && url.pathname === '/api/demo/catalogue') return json(res, 200, menu);
      if (req.method === 'POST') {
        if (!sameSecret(req.headers['x-csrf-token'], csrfToken)) throw new AppError('CSRF', '页面会话无效，请刷新后重试。', 403);
        const body = await readJson(req);
        if (url.pathname === '/api/demo/plan') return json(res, 200, planMeals(body, menu));
        if (url.pathname === '/api/mcp/tools' || url.pathname === '/api/mcp/call' || LIVE_ROUTES.has(url.pathname)) {
          if (clock() - mcpWindow >= 60000) { mcpWindow = clock(); mcpCount = 0; }
          if (++mcpCount > 30) throw new AppError('LOCAL_RATE_LIMIT', '本地 MCP 请求过于频繁，请一分钟后再试。', 429);
          if (inFlight >= 2) throw new AppError('MCP_BUSY', '已有两个请求正在执行，请等待完成。', 429);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_REQUEST', '请求需为 JSON 对象。');
          inFlight++;
          try {
            if (url.pathname === '/api/live/recommend') return json(res, 200, await recommendations.recommend(body));
            if (LIVE_ROUTES.has(url.pathname)) return json(res, 200, await live[LIVE_ROUTES.get(url.pathname)](body));
            if (url.pathname.endsWith('/tools')) {
              return json(res, 200, { source: 'mcp', readOnly: true, tools: await mcp.listTools({ refresh: true }) });
            }
            return json(res, 200, await mcp.callTool(body.name, body.arguments));
          } finally { inFlight--; }
        }
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC_FILES.has(url.pathname)) {
        const relative = STATIC_FILES.get(url.pathname);
        const data = await readFile(resolve(ROOT, 'public', relative));
        res.writeHead(200, { 'Content-Type': MIME[extname(relative)], 'Content-Length': data.byteLength });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      throw new AppError('NOT_FOUND', '没有这个页面或接口。', 404);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const known = error instanceof AppError;
      json(res, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? redact(error.message, token) : '服务暂时无法处理请求，请查看本地配置或稍后重试。' } });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = loadConfig();
    const server = createApp(config);
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已占用，可在 .env 中更改 PORT。` : '本地服务启动失败。');
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () => {
      console.log(`麦麦不超支已启动：http://127.0.0.1:${config.port}`);
      console.log(`预算实验室：固定演示数据；真实预算：自动推荐、门店券参考与官方核价。MCP：${config.token ? '已配置凭证' : '未配置 Token'}。不领券、不下单。`);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
