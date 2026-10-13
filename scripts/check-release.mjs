import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../src/config.mjs';

const required = ['README.md', 'SKILL.md', 'MCP_INTEGRATION.md', 'CONTEST_DECLARATION.md', 'LICENSE',
  '.env.example', '.gitignore', '.gitattributes', 'mcp-config.example.json', 'package.json',
  'src/server.mjs', 'src/config.mjs', 'src/mcp.mjs', 'src/live.mjs', 'src/planner.mjs', 'src/money.mjs', 'src/errors.mjs',
  'public/index.html', 'public/app.js', 'public/styles.css', 'public/assets/hero.svg', 'public/assets/food.svg', 'public/assets/icon.svg',
  'public/live.js', 'public/live.css',
  'src/recommend.mjs', 'scripts/recommend-browser-check.mjs',
  'test/recommend.test.mjs', 'test/recommend-server.test.mjs', 'test/fixtures/recommend.mjs',
  'scripts/plan.mjs', 'scripts/mcp.mjs', 'scripts/browser-check.mjs', 'scripts/live-browser-check.mjs', 'scripts/lib/browser.mjs',
  'test/planner.test.mjs', 'test/mcp.test.mjs', 'test/server.test.mjs', 'test/cli.test.mjs',
  'test/live.test.mjs', 'test/live-server.test.mjs', 'test/fixtures/live.mjs',
  'docs/SUBMISSION.md', 'docs/LOCAL_VALIDATION.md', 'docs/LIVE_VALIDATION.md', 'docs/LIVE_VALIDATION.template.md', 'docs/WORKBUDDY_HANDOFF.md',
  'docs/validation-status.json', 'docs/evidence/live-20261013.json',
  'docs/evidence/recommend-20261013.json',
  'docs/screenshots/recommend-desktop-20261013.png', 'docs/screenshots/recommend-mobile-20261013.png',
  'docs/screenshots/live-desktop-20261013.png', 'docs/screenshots/live-mobile-20261013.png',
  'docs/screenshots/desktop.png', 'docs/screenshots/mobile.png', 'docs/screenshots/receipt.png', 'THIRD_PARTY_NOTICES.md'];
let failures = 0;
for (const arg of process.argv.slice(2)) {
  if (arg !== '--submission') { console.error(`FAIL 未知检查选项：${arg}`); failures++; }
}
for (const file of required) {
  const path = resolve(ROOT, file);
  if (!existsSync(path) || !statSync(path).isFile()) { console.error(`FAIL 缺少 ${file}`); failures++; }
}
console.log(`INFO 检查 ${required.length} 个必要文件（包含实际测试脚本，不只检查文档）。`);
try {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'docs/upstream/manifest.json'), 'utf8'));
  for (const path of ['CONTEST_DECLARATION.md', 'docs/upstream/mcp-README.md', 'docs/upstream/contest-README.md', 'docs/upstream/activityGuidelines.md']) {
    const entry = manifest.find(item => item.path === path);
    const hash = createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
    if (!entry || entry.sha256 !== hash) throw new Error(`${path} 与下载时记录的 SHA-256 不一致。`);
  }
  const config = JSON.parse(readFileSync(resolve(ROOT, 'mcp-config.example.json'), 'utf8'));
  if (config.mcpServers?.['mcd-mcp']?.headers?.Authorization !== 'Bearer ${MCD_MCP_TOKEN}') {
    throw new Error('配置示例认证字段必须只使用环境变量占位符。');
  }
  console.log('OK   原版声明、三份上游快照的 SHA-256 与脱敏配置');
  console.log('INFO 哈希仅确认本地快照完整，不代表已联网核对最新活动规则。');
} catch (error) { console.error(`FAIL ${error.message}`); failures++; }
try {
  const status = JSON.parse(readFileSync(resolve(ROOT, 'docs/validation-status.json'), 'utf8'));
  const liveReady = status.liveMcpTested === true && existsSync(resolve(ROOT, 'docs/LIVE_VALIDATION.md'));
  if (!liveReady) {
    console.log('TODO 真实 MCP 端到端联调与脱敏记录尚未完成；mock 与 template 不是实测证据。');
    if (process.argv.includes('--submission')) failures++;
  } else {
    console.log('OK   已有有限范围真实 MCP 联调记录；其中历史报价已过期，不是全部工具或参赛资格认证。');
  }
  if (!status.workbuddyUsed || !existsSync(resolve(ROOT, 'workbuddy.md'))) {
    console.log('INFO 未提供真实 WorkBuddy 开发记录，不能申报相应专项使用证明。');
  }
  console.log('INFO 本检查不执行测试，也不是资格认证；需另跑测试并由本人检查真实性和敏感信息。');
} catch (error) { console.error(`FAIL 无法检查验证状态：${error.message}`); failures++; }
console.log(failures ? `\n检查未通过：${failures} 项需处理。` : '\n本地开发文件检查通过。此结果不表示已经参赛就绪。');
process.exitCode = failures ? 1 : 0;
