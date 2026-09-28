#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

function trace(text) {
  const line = `${new Date().toISOString()} ${text}\n`;
  try {
    const dir = join(homedir(), '.config', 'jev-compaction');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'last-run.log'), line);
  } catch {
    // The desktop app can still show stderr when the log directory is locked.
  }
  process.stderr.write(`jev-compaction: ${text}\n`);
}

export function loadHostConfig(host, env = process.env, read = readFileSync) {
  const name = host === 'claude' ? 'claude' : 'codex';
  let section = {};
  try {
    section = parseUserConfigText(read(configPathFrom(env), 'utf8'))[name] ?? {};
  } catch {
    section = {};
  }
  const provider = providerOf(section.provider ?? parseProvider(env.JEV_COMPACTION_PROVIDER));
  return {
    host: name,
    provider: provider.id,
    apiKey: section.apiKey || env[provider.envKey] || '',
    model: section.model || provider.defaultModel,
    baseUrl: section.baseUrl || provider.baseUrl,
    keepThreshold: section.keepThreshold ?? 0.5,
    preserveRecentMessages: section.preserveRecentMessages ?? 6,
    envKey: provider.envKey,
  };
}

export function loadCodexConfig(env = process.env, read = readFileSync) {
  return loadHostConfig('codex', env, read);
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
  const config = loadHostConfig(deps.host ?? 'codex', env, deps.read ?? readFileSync);
  trace(`${config.host} PreCompact provider=${config.provider} key=${config.apiKey ? 'yes' : 'no'}`);
  if (!config.apiKey) {
    return {
      continue: true,
      systemMessage: `jev-compaction: ${config.envKey} is not set for ${config.host}. The desktop app will summarize as usual.`,
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
  const detail = `${config.host} scored ${scored} calls via ${config.provider} (${requests} request(s)). ${kept.length} verbatim result(s) will be restored after the summary.`;
  trace(detail);
  return {
    continue: true,
    systemMessage: `jev-compaction: ${detail}`,
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

async function main(host) {
  trace(`${host} hook started`);
  try {
    const raw = await readStdin();
    const event = raw.trim() ? JSON.parse(raw) : {};
    if (event.hook_event_name === 'PreCompact') emit(await onPreCompact(event, process.env, { host }));
    else if (event.hook_event_name === 'SessionStart') emit(onSessionStart(event));
    else {
      trace(`${host} ignored event ${event.hook_event_name ?? 'none'}`);
      emit({ continue: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace(`${host} failed: ${message}`);
    emit({
      continue: true,
      systemMessage: `jev-compaction: ${message}. The desktop app will summarize as usual.`,
    });
  }
}

const hostArg = process.argv.find((arg) => arg === 'claude' || arg === 'codex');
if (hostArg) main(hostArg);
