import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mergeClaudeSettings, saveHost } from '../scripts/setup.mjs';

describe('setup', () => {
  it('stores each host separately and enables Claude function hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-setup-'));
    const configPath = join(dir, 'config.json');
    const claudeSettingsPath = join(dir, 'settings.json');
    saveHost({
      configPath,
      host: 'claude',
      patch: { provider: 'openrouter', apiKey: 'or-secret-1234', keepThreshold: 0.4 },
      claudeSettingsPath,
    });
    saveHost({
      configPath,
      host: 'codex',
      patch: { provider: 'typesafe', apiKey: 'ts-secret-9876' },
      claudeSettingsPath,
      writeClaudeSettings: false,
    });
    const file = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(file.claude).toMatchObject({ provider: 'openrouter', apiKey: 'or-secret-1234', keepThreshold: 0.4 });
    expect(file.codex).toMatchObject({ provider: 'typesafe', apiKey: 'ts-secret-9876' });
    const settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
    expect(settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS).toBe('1');
    expect(settings.env.JEV_COMPACTION_PROVIDER).toBe('openrouter');
    expect(settings.env.OPENROUTER_API_KEY).toBe('or-secret-1234');
    expect(settings.env.TYPESAFE_API_KEY).toBeUndefined();
  });

  it('preserves unrelated Claude settings', () => {
    expect(
      mergeClaudeSettings(
        { theme: 'dark', env: { PATH: '/usr/bin' } },
        { provider: 'typesafe', apiKey: 'k', envKey: 'TYPESAFE_API_KEY' },
      ),
    ).toEqual({
      theme: 'dark',
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
        JEV_COMPACTION_PROVIDER: 'typesafe',
        TYPESAFE_API_KEY: 'k',
      },
    });
  });
});
