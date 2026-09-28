import { describe, expect, it } from 'vitest';

import { parseUserConfig } from '../src/config-file.ts';
import { PROVIDERS as tsProviders } from '../src/provider.ts';
import { parseUserConfig as parseJs, redactKey, upsertHost } from '../shared/config.mjs';
import { PROVIDERS as jsProviders } from '../shared/providers.mjs';

describe('provider tables', () => {
  it('keeps the TypeScript and JavaScript endpoints identical', () => {
    expect(jsProviders.typesafe).toEqual(tsProviders.typesafe);
    expect(jsProviders.openrouter).toEqual(tsProviders.openrouter);
  });
});

describe('setup file', () => {
  const sample = {
    claude: { provider: 'OpenRouter', apiKey: ' or-key ', keepThreshold: 0.2, ignored: true },
    codex: { provider: 'typesafe', apiKey: 'ts-key' },
    extra: 1,
  };

  it('parses the same host sections in TypeScript and JavaScript', () => {
    expect(parseUserConfig(sample)).toEqual(parseJs(sample));
    expect(parseUserConfig(sample).claude).toEqual({
      provider: 'openrouter',
      apiKey: 'or-key',
      keepThreshold: 0.2,
    });
  });

  it('updates one host without dropping the other', () => {
    const next = upsertHost(parseJs(sample), 'codex', { provider: 'openrouter', apiKey: 'new' });
    expect(next.claude.apiKey).toBe('or-key');
    expect(next.codex).toMatchObject({ provider: 'openrouter', apiKey: 'new' });
  });

  it('redacts keys', () => {
    expect(redactKey('sk-or-v1-secret1234')).toBe('********1234');
    expect(redactKey('')).toBe('(not set)');
  });
});
