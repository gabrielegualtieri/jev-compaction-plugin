import { parseProvider, type ProviderName } from './provider.js';

export type HostName = 'claude' | 'codex';

export const HOST_NUMBER_KEYS = [
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
  'compactAtPercent',
  'minReductionRatio',
] as const;

export type HostNumberKey = (typeof HOST_NUMBER_KEYS)[number];

export interface HostConfig {
  provider?: ProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  goal?: string;
  keepThreshold?: number;
  preserveRecentMessages?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  truncateHeadChars?: number;
  compactAtPercent?: number;
  minReductionRatio?: number;
}

export interface UserConfigFile {
  claude?: HostConfig;
  codex?: HostConfig;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseHostConfig(value: unknown): HostConfig | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const host: HostConfig = {};
  const provider = parseProvider(record['provider']);
  if (provider) host.provider = provider;
  const apiKey = stringValue(record['apiKey']);
  if (apiKey) host.apiKey = apiKey;
  const model = stringValue(record['model']);
  if (model) host.model = model;
  const baseUrl = stringValue(record['baseUrl']);
  if (baseUrl) host.baseUrl = baseUrl;
  const goal = stringValue(record['goal']);
  if (goal) host.goal = goal;
  for (const key of HOST_NUMBER_KEYS) {
    const number = numberValue(record[key]);
    if (number !== undefined) host[key] = number;
  }
  return host;
}

/** Accepts the setup file. Unknown fields and bad types are dropped. */
export function parseUserConfig(value: unknown): UserConfigFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const file: UserConfigFile = {};
  const claude = parseHostConfig(record['claude']);
  const codex = parseHostConfig(record['codex']);
  if (claude) file.claude = claude;
  if (codex) file.codex = codex;
  return file;
}

export function parseUserConfigText(text: string): UserConfigFile {
  try {
    return parseUserConfig(JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}
