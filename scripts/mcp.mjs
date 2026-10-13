import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { McpClient } from '../src/mcp.mjs';

try {
  const [action, tool, flag, filename, ...rest] = process.argv.slice(2);
  const client = new McpClient(loadConfig());
  let result;
  if (action === 'inspect' && !tool) {
    result = { source: 'mcp', readOnly: true, tools: await client.listTools() };
  } else if (action === 'call' && tool && flag === '--args' && filename && !rest.length) {
    const args = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    result = await client.callTool(tool, args);
  } else {
    throw new Error('用法：node scripts/mcp.mjs inspect；或 call <只读工具名> --args <本地参数JSON文件>。参数文件可能含门店/账号信息，请放在 .local 中。');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`[${error.code ?? 'ERROR'}] ${error.message}`); process.exitCode = 1; }
