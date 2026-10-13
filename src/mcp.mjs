import { AppError } from './errors.mjs';

export const MCP_ENDPOINT = 'https://mcp.mcd.cn';
export const READ_ONLY_TOOLS = Object.freeze([
  'query-nearby-stores', 'query-meals', 'query-meal-detail',
  'query-my-coupons', 'query-store-coupons', 'calculate-price',
]);
const ALLOWED = new Set(READ_ONLY_TOOLS);
const MAX_RESPONSE = 2 * 1024 * 1024;
const PROTOCOLS = new Set(['2025-06-18', '2025-03-26']);

export function redact(value, token = '') {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  let clean = token ? json.split(token).join('[REDACTED]') : json;
  clean = clean.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
  return typeof value === 'string' ? clean : JSON.parse(clean);
}

function checkEnvelope(envelope, id) {
  if (!envelope || envelope.jsonrpc !== '2.0' || envelope.id !== id) {
    throw new AppError('MCP_PROTOCOL', 'MCP 返回了无法匹配的响应。', 502);
  }
  if (envelope.error) throw new AppError('MCP_RPC_ERROR', `MCP 拒绝请求：${String(envelope.error.message ?? '未知协议错误').slice(0, 400)}`, 502);
  if (!Object.hasOwn(envelope, 'result')) throw new AppError('MCP_PROTOCOL', 'MCP 响应缺少 result。', 502);
  return envelope.result;
}

async function readResponse(response, id) {
  if (!response.body) throw new AppError('MCP_PROTOCOL', 'MCP 返回了空响应。', 502);
  const isSse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  const parseEvent = event => {
    const text = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!text) return undefined;
    let message;
    try { message = JSON.parse(text); }
    catch { throw new AppError('MCP_PROTOCOL', 'MCP 事件不是有效 JSON。', 502); }
    if (message.id !== id) return undefined;
    return { value: checkEnvelope(message, id) };
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE) throw new AppError('MCP_RESPONSE_LIMIT', 'MCP 响应过大，已停止读取。', 502);
      buffer += decoder.decode(value, { stream: true });
      if (isSse) {
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const parsed = parseEvent(event);
          if (parsed) return parsed.value;
        }
      }
    }
    buffer += decoder.decode();
    if (isSse) {
      const parsed = parseEvent(buffer);
      if (parsed) return parsed.value;
      throw new AppError('MCP_PROTOCOL', 'MCP 事件流结束，但没有对应的结果。', 502);
    }
    let envelope;
    try { envelope = JSON.parse(buffer); }
    catch { throw new AppError('MCP_PROTOCOL', 'MCP 响应不是有效 JSON。', 502); }
    return checkEnvelope(envelope, id);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Lightweight input checks only. Server-provided JSON Schema remains the source of truth;
// the MCP server performs complete validation (including refs / unions / complex constraints).
export function validateToolArguments(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new AppError('INVALID_TOOL_ARGS', '工具参数必须是 JSON 对象。');
  }
  for (const key of schema?.required ?? []) {
    if (!Object.hasOwn(args, key)) throw new AppError('MISSING_TOOL_ARG', `缺少必填参数：${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema?.properties?.[key];
    if (!property) {
      if (schema?.additionalProperties === false) throw new AppError('UNKNOWN_TOOL_ARG', `不支持的参数：${key}`);
      continue;
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) throw new AppError('INVALID_TOOL_ARG', `${key} 不在允许的取值中。`);
    if (typeof property.type !== 'string') continue;
    const valid = { string: typeof value === 'string', number: typeof value === 'number' && Number.isFinite(value),
      integer: Number.isInteger(value), boolean: typeof value === 'boolean', array: Array.isArray(value),
      object: value !== null && typeof value === 'object' && !Array.isArray(value), null: value === null };
    if (valid[property.type] === false) throw new AppError('INVALID_TOOL_ARG', `${key} 的类型应为 ${property.type}。`);
  }
}

export class McpClient {
  constructor({ token = '', fetchImpl = globalThis.fetch, timeoutMs = 18000 } = {}) {
    this.token = token.trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.protocol = '2025-06-18';
    this.sessionId = null;
    this.initPromise = null;
    this.toolsPromise = null;
    this.toolsAt = 0;
  }

  get configured() { return !!this.token && !/^(YOUR_|\$\{|your[-_])/i.test(this.token); }

  async rpc(method, params, notification = false) {
    if (!this.configured) throw new AppError('TOKEN_MISSING', '尚未配置 MCP Token。请在项目的本地 .env 中填写 MCD_MCP_TOKEN，重启服务后再连接。', 503);
    const id = notification ? undefined : this.nextId++;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}` };
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.protocol;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    try {
      const response = await this.fetchImpl(MCP_ENDPOINT, { method: 'POST', headers, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
        signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw new AppError('TOKEN_REJECTED', 'MCP 拒绝了凭证，请检查 Token 是否有效或过期。', 502);
        if (response.status === 429) throw new AppError('MCP_RATE_LIMIT', '官方 MCP 暂时限流，请稍后手动重试。', 429);
        if (response.status === 404 && this.sessionId) {
          this.sessionId = null; this.initPromise = null; this.toolsPromise = null;
          throw new AppError('MCP_SESSION_EXPIRED', 'MCP 会话已失效，请重新连接。', 502);
        }
        throw new AppError('MCP_HTTP_ERROR', `MCP 返回 HTTP ${response.status}，未回退到演示数据。`, 502);
      }
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (notification) { await response.body?.cancel().catch(() => {}); return null; }
      return redact(await readResponse(response, id), this.token);
    } catch (error) {
      if (error instanceof AppError) {
        error.message = redact(error.message, this.token);
        throw error;
      }
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new AppError('MCP_TIMEOUT', 'MCP 请求超时，请稍后手动重试。', 504);
      }
      throw new AppError('MCP_NETWORK', '无法连接官方 MCP。请检查网络；未向其他地址发送凭证，也未使用演示数据替代。', 502);
    }
  }

  async initialize() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const result = await this.rpc('initialize', { protocolVersion: this.protocol, capabilities: {},
          clientInfo: { name: 'mcd-budget', version: '0.1.0' } });
        if (!PROTOCOLS.has(result?.protocolVersion)) {
          throw new AppError('MCP_VERSION', '服务端协议版本尚未支持，请更新适配器。', 502);
        }
        this.protocol = result.protocolVersion;
        await this.rpc('notifications/initialized', {}, true);
        return result;
      })().catch(error => { this.initPromise = null; this.sessionId = null; throw error; });
    }
    return this.initPromise;
  }

  async listTools({ refresh = false } = {}) {
    await this.initialize();
    if (refresh || !this.toolsPromise || Date.now() - this.toolsAt > 300000) {
      this.toolsAt = Date.now();
      this.toolsPromise = (async () => {
        const tools = [], cursors = new Set();
        let cursor;
        for (let page = 0; page < 10; page++) {
          const result = await this.rpc('tools/list', cursor ? { cursor } : {});
          if (!Array.isArray(result?.tools)) throw new AppError('MCP_PROTOCOL', 'MCP 工具列表格式不正确。', 502);
          tools.push(...result.tools.filter(tool => ALLOWED.has(tool.name)));
          if (!result.nextCursor) {
            return [...new Map(tools.map(tool => [tool.name, { name: tool.name, description: tool.description ?? '',
              inputSchema: tool.inputSchema ?? { type: 'object' } }])).values()];
          }
          if (cursors.has(result.nextCursor)) throw new AppError('MCP_PAGINATION', 'MCP 返回重复的分页游标，已停止。', 502);
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        throw new AppError('MCP_PAGINATION', 'MCP 工具列表超过安全分页上限。', 502);
      })().catch(error => { this.toolsPromise = null; throw error; });
    }
    return this.toolsPromise;
  }

  async callTool(name, args) {
    // Enforced before authentication or networking. Even a caller-supplied schema cannot enable writes.
    if (!ALLOWED.has(name)) throw new AppError('TOOL_BLOCKED', '此工具不在只读白名单中。下单、领券、抽奖、兑换等操作均被禁止。', 403);
    const tools = await this.listTools();
    const tool = tools.find(item => item.name === name);
    if (!tool) throw new AppError('TOOL_UNAVAILABLE', '官方当前未提供这个工具，请重新读取工具列表。', 502);
    validateToolArguments(args, tool.inputSchema);
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (!result || typeof result !== 'object') throw new AppError('MCP_PROTOCOL', 'MCP 工具返回格式不正确。', 502);
    if (result.isError) throw new AppError('MCP_TOOL_ERROR', '官方工具返回错误。请检查参数和业务条件；结果未当作有效核价。', 502);
    return { source: 'mcp', endpoint: MCP_ENDPOINT, tool: name, receivedAt: new Date().toISOString(),
      note: '这是工具原始返回；isError=false 不代表业务必然成功，请检查业务状态和金额单位。', result };
  }
}
