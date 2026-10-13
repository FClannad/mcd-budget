import { AppError } from './errors.mjs';

// All arithmetic uses integer fen. No binary-floating-point price comparisons.
export function yuanToCents(value) {
  if (!['string', 'number'].includes(typeof value)) {
    throw new AppError('INVALID_MONEY', '金额必须是数字，最多保留两位小数。');
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text)) {
    throw new AppError('INVALID_MONEY', '金额格式不正确，请输入非负数字，最多保留两位小数。');
  }
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function formatMoney(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new AppError('INVALID_CENTS', '金额必须是非负整数分。');
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
