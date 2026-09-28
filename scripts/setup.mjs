#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { parseUserConfigText, redactKey, upsertHost } from '../shared/config.mjs';
import { parseProvider, providerOf } from '../shared/providers.mjs';

export function defaultConfigPath() {
  return join(homedir(), '.config', 'jev-compaction', 'config.json');
}

export function repoRootFromHere() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultClaudeSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

export function claudeHookCommand(repoRoot) {
  return `"${join(repoRoot, 'codex', 'run.cmd')}" claude`;
}

export function installClaudeCommandHooks(current, command) {
  const settings =
    current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? { ...settings.hooks }
      : {};
  const already = (groups) =>
    Array.isArray(groups) &&
    groups.some((group) =>
      (group?.hooks ?? []).some((hook) => String(hook?.command ?? '').includes('run.cmd')),
    );
  if (!already(hooks.PreCompact)) {
    hooks.PreCompact = [
      ...(Array.isArray(hooks.PreCompact) ? hooks.PreCompact : []),
      { hooks: [{ type: 'command', command, timeout: 120 }] },
    ];
  }
  if (!already(hooks.SessionStart)) {
    hooks.SessionStart = [
      ...(Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []),
      {
        matcher: 'compact',
        hooks: [{ type: 'command', command, timeout: 30 }],
      },
    ];
  }
  settings.hooks = hooks;
  return settings;
}

export function mergeClaudeSettings(current, { provider, apiKey, envKey }) {
  const settings =
    current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const env =
    settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
      ? { ...settings.env }
      : {};
  env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1';
  env.JEV_COMPACTION_PROVIDER = provider;
  env[envKey] = apiKey;
  settings.env = env;
  return settings;
}

export function writeJsonFile(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, path);
  chmodSync(path, mode);
}

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Saves one host. Claude also receives the function-hook flag and the key in
 * ~/.claude/settings.json, because the function-hook sandbox may not read the file.
 */
export function saveHost({
  configPath = defaultConfigPath(),
  host,
  patch,
  claudeSettingsPath = defaultClaudeSettingsPath(),
  writeClaudeSettings = host === 'claude',
}) {
  const provider = providerOf(patch.provider);
  const existing = parseUserConfigText(
    (() => {
      try {
        return readFileSync(configPath, 'utf8');
      } catch {
        return '{}';
      }
    })(),
  );
  const file = upsertHost(existing, host, { ...patch, provider: provider.id });
  writeJsonFile(configPath, file, 0o600);
  if (host === 'claude' && writeClaudeSettings) {
    const current = readJsonFile(claudeSettingsPath);
    writeJsonFile(
      claudeSettingsPath,
      installClaudeCommandHooks(
        mergeClaudeSettings(current, {
          provider: provider.id,
          apiKey: patch.apiKey,
          envKey: provider.envKey,
        }),
        claudeHookCommand(repoRootFromHere()),
      ),
      0o600,
    );
  }
  return { file, provider };
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function usage() {
  return `Configure Jev compaction for Claude Code, Codex, or both.

Interactive:
  node scripts/setup.mjs

One host, no prompts:
  node scripts/setup.mjs --host claude --provider openrouter --api-key "$OPENROUTER_API_KEY"
  node scripts/setup.mjs --host codex --provider typesafe --api-key "$TYPESAFE_API_KEY"

Providers: typesafe | openrouter
Optional: --model, --keep-threshold, --preserve-recent, --compact-at, --min-reduction,
          --config <file>, --claude-settings <file>, --no-claude-settings
`;
}

function numberFlag(argv, name) {
  const raw = flagValue(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function patchFromFlags(argv) {
  const provider = parseProvider(flagValue(argv, '--provider'));
  const apiKey = flagValue(argv, '--api-key');
  if (!provider) throw new Error('--provider must be typesafe or openrouter');
  if (!apiKey) throw new Error('--api-key is required when --host is set');
  const patch = { provider, apiKey };
  const model = flagValue(argv, '--model');
  if (model) patch.model = model;
  const numbers = {
    '--keep-threshold': 'keepThreshold',
    '--preserve-recent': 'preserveRecentMessages',
    '--compact-at': 'compactAtPercent',
    '--min-reduction': 'minReductionRatio',
    '--max-state-tokens': 'maxStateTokens',
    '--max-request-tokens': 'maxRequestTokens',
    '--truncate-head': 'truncateHeadChars',
  };
  for (const [flag, key] of Object.entries(numbers)) {
    const value = numberFlag(argv, flag);
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function askSecret(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (typeof stdin.setRawMode !== 'function') {
      reject(new Error('Cannot hide the API key: stdin is not a TTY. Pass --api-key.'));
      return;
    }
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      if (chunk === '\u0003') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        process.exit(130);
      }
      if (chunk === '\r' || chunk === '\n') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        stdin.pause();
        process.stderr.write('\n');
        resolve(value.trim());
        return;
      }
      if (chunk === '\u007f' || chunk === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += chunk;
    };
    stdin.on('data', onData);
  });
}

async function askHostPatch(rl, host) {
  process.stderr.write(`\n${host === 'claude' ? 'Claude Code' : 'Codex / ChatGPT'}\n`);
  let provider;
  while (!provider) {
    const answer = await ask(rl, 'Provider [typesafe/openrouter] (typesafe): ');
    provider = parseProvider(answer || 'typesafe');
    if (!provider) process.stderr.write('Type typesafe or openrouter.\n');
  }
  const spec = providerOf(provider);
  const apiKey = await askSecret(`${spec.envKey}: `);
  if (!apiKey) throw new Error('The API key cannot be empty.');
  const model = await ask(rl, `Model (${spec.defaultModel}): `);
  const thresholds = await ask(rl, 'Change thresholds? [y/N]: ');
  const patch = { provider, apiKey };
  if (model) patch.model = model;
  if (thresholds.toLowerCase() === 'y') {
    const pairs = [
      ['keepThreshold', 'Keep threshold (0.5): '],
      ['preserveRecentMessages', 'Recent messages to pin (6): '],
      ['compactAtPercent', 'Claude auto-compact percent (60): '],
      ['minReductionRatio', 'Claude minimum reduction (0.25): '],
    ];
    for (const [key, prompt] of pairs) {
      const raw = await ask(rl, prompt);
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
      patch[key] = value;
    }
  }
  return patch;
}

async function interactive(argv) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    let which = flagValue(argv, '--host');
    if (!which) {
      const answer = await ask(rl, 'Configure claude, codex, or both? [both]: ');
      which = answer || 'both';
    }
    if (!['claude', 'codex', 'both'].includes(which)) {
      throw new Error('--host must be claude, codex, or both');
    }
    const hosts = which === 'both' ? ['claude', 'codex'] : [which];
    const configPath = flagValue(argv, '--config') || defaultConfigPath();
    const claudeSettingsPath = flagValue(argv, '--claude-settings') || defaultClaudeSettingsPath();
    const writeClaudeSettings = !hasFlag(argv, '--no-claude-settings');
    for (const host of hosts) {
      const patch = await askHostPatch(rl, host);
      const { provider } = saveHost({
        configPath,
        host,
        patch,
        claudeSettingsPath,
        writeClaudeSettings,
      });
      process.stderr.write(
        `Saved ${host}: provider=${provider.id} key=${redactKey(patch.apiKey)}\n`,
      );
    }
    process.stderr.write(`Config: ${configPath}\n`);
  } finally {
    rl.close();
  }
}

function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    process.stderr.write(usage());
    return;
  }
  if (hasFlag(argv, '--install-hooks')) {
    const claudeSettingsPath = flagValue(argv, '--claude-settings') || defaultClaudeSettingsPath();
    writeJsonFile(
      claudeSettingsPath,
      installClaudeCommandHooks(readJsonFile(claudeSettingsPath) ?? {}, claudeHookCommand(repoRootFromHere())),
      0o600,
    );
    process.stderr.write(`Claude hooks written to ${claudeSettingsPath}\n`);
    return;
  }
  const host = flagValue(argv, '--host');
  if (!host) {
    if (!process.stdin.isTTY) {
      process.stderr.write(usage());
      process.exitCode = 1;
      return;
    }
    return interactive(argv);
  }
  if (host !== 'claude' && host !== 'codex') {
    throw new Error('Non-interactive --host must be claude or codex. Run with no flags to configure both.');
  }
  const patch = patchFromFlags(argv);
  const { provider } = saveHost({
    configPath: flagValue(argv, '--config') || defaultConfigPath(),
    host,
    patch,
    claudeSettingsPath: flagValue(argv, '--claude-settings') || defaultClaudeSettingsPath(),
    writeClaudeSettings: !hasFlag(argv, '--no-claude-settings'),
  });
  process.stderr.write(`Saved ${host}: provider=${provider.id} key=${redactKey(patch.apiKey)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = main();
    if (result && typeof result.then === 'function') {
      result.catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
