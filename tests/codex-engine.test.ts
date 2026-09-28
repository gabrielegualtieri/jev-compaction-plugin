import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractCalls, reinjectText, scoreCalls } from '../codex/engine.mjs';
import { onPreCompact, onSessionStart } from '../codex/hook.mjs';
import { writeFileSync } from 'node:fs';

describe('codex transcript', () => {
  it('pairs Claude-shaped and Codex-shaped tool calls', () => {
    const text = [
      JSON.stringify({
        role: 'assistant',
        toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
      }),
      JSON.stringify({
        role: 'user',
        toolResults: [{ tool_use_id: 'toolu_1', text: 'export const a = 1;\n' }],
      }),
      JSON.stringify({ type: 'function_call', name: 'Bash', call_id: 'call_2', arguments: '{"command":"npm test"}' }),
      JSON.stringify({ type: 'function_call_output', call_id: 'call_2', output: 'FAIL parser' }),
    ].join('\n');
    const calls = extractCalls(text);
    expect(calls.map((call) => [call.id, call.tool, call.result])).toEqual([
      ['t1', 'Read', 'export const a = 1;\n'],
      ['t2', 'Bash', 'FAIL parser'],
    ]);
  });

  it('asks Jev only about unpinned calls and reinjects kept verbatim output', async () => {
    const long = 'x'.repeat(500);
    const calls = extractCalls(
      JSON.stringify([
        { type: 'function_call', name: 'Read', call_id: 'a', arguments: '{}' },
        { type: 'function_call_output', call_id: 'a', output: long },
        { type: 'function_call', name: 'Bash', call_id: 'b', arguments: '{}' },
        { type: 'function_call_output', call_id: 'b', output: long },
      ]),
    );
    const urls: string[] = [];
    const { decisions } = await scoreCalls(calls, {
      provider: 'openrouter',
      apiKey: 'key',
      keepThreshold: 0.5,
      preserveRecentMessages: 0,
      fetchImpl: async (url: string, init: { body: string }) => {
        urls.push(url);
        const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
        const answers = Object.fromEntries(
          Object.keys(questions).map((name) => [name, { noul: name.startsWith('result_') ? 0.9 : 0.2 }]),
        );
        return { ok: true, status: 200, text: JSON.stringify({ answers, usage: { cost: 0.01 } }) };
      },
    });
    expect(urls).toEqual(['https://openrouter.ai/api/v1/systemone']);
    expect(decisions.map((decision) => decision.reason)).toEqual(['pinned', 'kept']);
    expect(reinjectText(decisions)).toContain(long);
    expect(reinjectText(decisions)).not.toContain('call_id');
  });
});

describe('codex hook', () => {
  it('scores before compact and restores the kept output on the compact session start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-codex-'));
    const transcript = join(dir, 'transcript.jsonl');
    const long = 'y'.repeat(400);
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'function_call', name: 'Read', call_id: 'a', arguments: '{}' }),
        JSON.stringify({ type: 'function_call_output', call_id: 'a', output: 'short' }),
        JSON.stringify({ type: 'function_call', name: 'Bash', call_id: 'b', arguments: '{}' }),
        JSON.stringify({ type: 'function_call_output', call_id: 'b', output: long }),
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ codex: { provider: 'openrouter', apiKey: 'test-key', preserveRecentMessages: 0 } }),
    );
    const env = {
      JEV_COMPACTION_CONFIG: join(dir, 'config.json'),
      PLUGIN_DATA: dir,
    };
    const before = await onPreCompact(
      { hook_event_name: 'PreCompact', session_id: 'sess-1', transcript_path: transcript, trigger: 'auto' },
      env,
      {
        fetchImpl: async (_url: string, init: { body: string }) => {
          const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
          const answers = Object.fromEntries(
            Object.keys(questions).map((name) => [name, { noul: name.startsWith('result_') ? 0.91 : 0.1 }]),
          );
          return { ok: true, status: 200, text: JSON.stringify({ answers }) };
        },
      },
    );
    expect(before.continue).toBe(true);
    expect(before.systemMessage).toContain('openrouter');
    const after = onSessionStart({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess-1' }, env);
    expect(after.hookSpecificOutput.additionalContext).toContain(long);
    expect(onSessionStart({ source: 'startup', session_id: 'sess-1' }, env)).toEqual({ continue: true });
  });
});
