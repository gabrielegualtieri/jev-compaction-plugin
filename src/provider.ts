export const PROVIDERS = {
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe',
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    envKey: 'TYPESAFE_API_KEY',
    defaultModel: 'jev-latest',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/systemone',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'jev-latest',
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

export function parseProvider(value: unknown): ProviderName | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().toLowerCase();
  if (name === 'typesafe' || name === 'openrouter') return name;
  return undefined;
}

export function providerOf(value: unknown): (typeof PROVIDERS)[ProviderName] {
  return PROVIDERS[parseProvider(value) ?? 'typesafe'];
}
