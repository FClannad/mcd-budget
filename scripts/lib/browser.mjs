// Optional local-browser test support. No npm packages, user profile, or remote browser service.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ROOT } from '../../src/config.mjs';

export const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

export async function until(check, description, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await delay(40);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${description}`);
}

export function findBrowser() {
  if (process.env.CHROME_PATH) {
    const path = resolve(process.env.CHROME_PATH);
    if (!existsSync(path)) throw new Error('CHROME_PATH 指向的浏览器不存在。');
    return path;
  }
  const paths = process.platform === 'win32' ? [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : (process.env.PATH ?? '').split(delimiter).flatMap(path => ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'].map(name => join(path, name)));
  const browser = paths.find(path => existsSync(path));
  if (!browser) throw new Error('未找到 Chrome / Chromium / Edge。安装本机浏览器或设置 CHROME_PATH 后重试；本脚本不会下载浏览器。');
  return browser;
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer); pending.reject(new Error(`Browser disconnected during ${pending.method}`));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolveRequest, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }
}

export async function launchBrowser() {
  const executable = findBrowser();
  const profiles = resolve(ROOT, '.local/browser-profiles');
  mkdirSync(profiles, { recursive: true });
  const profile = mkdtempSync(join(profiles, 'check-'));
  const { MCD_MCP_TOKEN: _unusedToken, ...childEnv } = process.env;
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps',
    '--disable-features=MediaRouter,OptimizationHints,Translate', '--metrics-recording-only', '--window-size=1440,1000', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: childEnv });
  let launchError, exited = false, cdp;
  child.on('error', error => { launchError = error; exited = true; });
  child.on('exit', () => { exited = true; });
  const close = async () => {
    if (cdp && !exited) await cdp.send('Browser.close').catch(() => {});
    if (!exited) await until(() => exited, 'browser exit', 5000).catch(() => { child.kill(); });
    cdp?.socket.close();
    if (!exited) await until(() => exited, 'browser process cleanup', 5000).catch(() => {});
    // Delete only this run's generated profile, after resolving and checking the target.
    const parent = realpathSync(profiles);
    if (existsSync(profile)) {
      const target = realpathSync(profile), inside = relative(parent, target);
      if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside) || dirname(target) !== parent) {
        throw new Error('Refused profile cleanup outside the generated profile directory.');
      }
      rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    }
  };
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    await until(() => {
      if (launchError) throw new Error(`无法启动本机浏览器：${launchError.code ?? 'unknown'}`);
      if (exited) throw new Error('浏览器在建立测试连接前退出。');
      return existsSync(portFile) && readFileSync(portFile, 'utf8').trim().split(/\r?\n/).length >= 2;
    }, 'browser debugging endpoint', 20000);
    const [port, endpoint] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || !endpoint.startsWith('/devtools/browser/')) throw new Error('Invalid local debugging endpoint');
    const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Browser WebSocket timed out')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser WebSocket failed')); }, { once: true });
    });
    cdp = new Connection(socket);
    return { cdp, close };
  } catch (error) { await close(); throw error; }
}