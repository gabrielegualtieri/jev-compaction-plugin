#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseUserConfigText } from '../shared/config.mjs';
import { parseProvider, providerOf } from '../shared/providers.mjs';
import { extractCalls, reinjectText, safeSessionId, scoreCalls } from './engine.mjs';

const TRANSCRIPT_CAP = 5_000_000;

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function dataDir(env = process.env) {
  if (env.PLUGIN_DATA) return join(env.PLUGIN_DATA, 'sessions');
  return join(homedir(), '.config', 'jev-compaction', 'codex-sessions');
}

export function loadCodexConfig(env = process.env, read = readFileSync) {
  let host = {};
  try {
    host = parseUserConfigText(read(configPathFrom(env), 'utf8')).codex ?? {};
  } catch {
    host = {};
  }
  const provider = providerOf(host.provider ?? parseProvider(env.JEV_COMPACTION_PROVIDER));
  return {
    provider: provider.id,
    apiKey: host.apiKey || env[provider.envKey] || '',
    model: host.model || provider.defaultModel,
    baseUrl: host.baseUrl || provider.baseUrl,
    keepThreshold: host.keepThreshold ?? 0.5,
    preserveRecentMessages: host.preserveRecentMessages ?? 6,
    envKey: provider.envKey,
  };
}

function configPathFrom(env) {
  return env.JEV_COMPACTION_CONFIG || join(homedir(), '.config', 'jev-compaction', 'config.json');
}

function sidecar(sessionId, env = process.env) {
  return join(dataDir(env), `${safeSessionId(sessionId)}.json`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function onPreCompact(event, env = process.env, deps = {}) {
  const config = loadCodexConfig(env, deps.read ?? readFileSync);
  if (!config.apiKey) {
    return {
      continue: true,
      systemMessage: `jev-compaction: ${config.envKey} is not set. Codex will summarize as usual. Run node scripts/setup.mjs --host codex.`,
    };
  }
  if (!event.transcript_path) {
    return {
      continue: true,
      systemMessage: 'jev-compaction: no transcript path. Codex will summarize as usual.',
    };
  }
  const text = readFileSync(event.transcript_path, 'utf8').slice(0, TRANSCRIPT_CAP);
  const calls = extractCalls(text);
  const { decisions, requests } = await scoreCalls(calls, { ...config, fetchImpl: deps.fetchImpl });
  const kept = decisions.filter((decision) => decision.reason === 'kept' && decision.result.length > 200);
  mkdirSync(dataDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(
    sidecar(event.session_id, env),
    JSON.stringify({
      sessionId: event.session_id ?? '',
      provider: config.provider,
      requests,
      kept: kept.map((decision) => ({
        tool_use_id: decision.tool_use_id,
        tool: decision.tool,
        keepResult: decision.keepResult,
        result: decision.result,
      })),
    }),
    { mode: 0o600 },
  );
  const scored = decisions.filter((decision) => decision.reason !== 'pinned').length;
  return {
    continue: true,
    systemMessage: `jev-compaction: scored ${scored} calls via ${config.provider} (${requests} request(s)). ${kept.length} verbatim result(s) will be restored after the summary.`,
  };
}

export function onSessionStart(event, env = process.env) {
  if (event.source !== 'compact') return { continue: true };
  const path = sidecar(event.session_id, env);
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { continue: true };
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // The note is still delivered. A later compact overwrites the sidecar.
  }
  const decisions = (saved.kept ?? []).map((item) => ({
    reason: 'kept',
    result: typeof item.result === 'string' ? item.result : '',
    keepResult: typeof item.keepResult === 'number' ? item.keepResult : 1,
    tool: typeof item.tool === 'string' ? item.tool : 'tool',
    tool_use_id: typeof item.tool_use_id === 'string' ? item.tool_use_id : '',
  }));
  const additionalContext = reinjectText(decisions);
  if (!additionalContext) {
    return {
      continue: true,
      systemMessage: 'jev-compaction: nothing verbatim needed to be restored.',
    };
  }
  return {
    continue: true,
    systemMessage: 'jev-compaction: restored tool output Jev kept verbatim.',
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
}

async function main() {
  try {
    const raw = await readStdin();
    const event = raw.trim() ? JSON.parse(raw) : {};
    if (event.hook_event_name === 'PreCompact') emit(await onPreCompact(event));
    else if (event.hook_event_name === 'SessionStart') emit(onSessionStart(event));
    else emit({ continue: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`jev-compaction: ${message}\n`);
    emit({
      continue: true,
      systemMessage: `jev-compaction: ${message}. Codex will summarize as usual.`,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
