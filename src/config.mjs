import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppError } from './errors.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function loadConfig(env = process.env, envPath = resolve(ROOT, '.env')) {
  const local = {};
  try {
    for (const line of readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.match(/^\s*(MCD_MCP_TOKEN|PORT)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      local[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new AppError('CONFIG_READ', '无法读取本地 .env 文件。', 500);
  }
  const rawPort = String(env.PORT ?? local.PORT ?? '3210');
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new AppError('INVALID_PORT', 'PORT 必须是 1 至 65535 的整数。', 500);
  }
  return { token: (env.MCD_MCP_TOKEN ?? local.MCD_MCP_TOKEN ?? '').trim(), port: Number(rawPort) };
}
