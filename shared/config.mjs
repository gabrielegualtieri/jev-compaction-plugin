import { parseProvider } from './providers.mjs';

export const HOST_NUMBER_KEYS = [
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
  'compactAtPercent',
  'minReductionRatio',
];

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseHostConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const host = {};
  const provider = parseProvider(value.provider);
  if (provider) host.provider = provider;
  const apiKey = stringValue(value.apiKey);
  if (apiKey) host.apiKey = apiKey;
  const model = stringValue(value.model);
  if (model) host.model = model;
  const baseUrl = stringValue(value.baseUrl);
  if (baseUrl) host.baseUrl = baseUrl;
  const goal = stringValue(value.goal);
  if (goal) host.goal = goal;
  for (const key of HOST_NUMBER_KEYS) {
    const number = numberValue(value[key]);
    if (number !== undefined) host[key] = number;
  }
  return host;
}

export function parseUserConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const file = {};
  const claude = parseHostConfig(value.claude);
  const codex = parseHostConfig(value.codex);
  if (claude) file.claude = claude;
  if (codex) file.codex = codex;
  return file;
}

export function parseUserConfigText(text) {
  try {
    return parseUserConfig(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Merge one host section. Other hosts in `file` are preserved. */
export function upsertHost(file, host, patch) {
  const next = parseUserConfig(file);
  const current = { ...(next[host] ?? {}) };
  if (patch.provider) current.provider = patch.provider;
  if (patch.apiKey) current.apiKey = patch.apiKey;
  if (patch.model) current.model = patch.model;
  if (patch.baseUrl) current.baseUrl = patch.baseUrl;
  if (patch.goal) current.goal = patch.goal;
  for (const key of HOST_NUMBER_KEYS) {
    if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) current[key] = patch[key];
  }
  return { ...next, [host]: current };
}

export function redactKey(apiKey) {
  if (!apiKey) return '(not set)';
  if (apiKey.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, apiKey.length - 4))}${apiKey.slice(-4)}`;
}
