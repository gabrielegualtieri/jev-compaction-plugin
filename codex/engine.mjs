import { providerOf } from '../shared/providers.mjs';

const STATE_CONTEXT =
  'A coding agent is about to replace this conversation with a summary. history lists tool calls with outputs omitted. Each question asks whether one call, or its full output, must stay verbatim. Whatever is dropped can be re-run.';

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function argsOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return { arguments: value.slice(0, 500) };
    }
  }
  return {};
}

function parseDocuments(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return [JSON.parse(trimmed)];
    } catch {
      // Fall through to JSONL. A transcript can be one JSON value per line.
    }
  }
  const docs = [];
  for (const line of text.split('\n')) {
    const item = line.trim();
    if (!item) continue;
    try {
      docs.push(JSON.parse(item));
    } catch {
      // Ignore prose lines. The transcript format is not stable.
    }
  }
  return docs;
}

function walk(value, acc, seen, depth) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, acc, seen, depth + 1);
    return;
  }

  if (Array.isArray(value.toolUses)) {
    for (const tool of value.toolUses) {
      if (!tool || typeof tool !== 'object') continue;
      if (typeof tool.tool_use_id !== 'string' || typeof tool.tool !== 'string') continue;
      acc.uses.push({ id: tool.tool_use_id, tool: tool.tool, input: argsOf(tool.input) });
    }
  }
  if (Array.isArray(value.toolResults)) {
    for (const result of value.toolResults) {
      if (!result || typeof result !== 'object' || typeof result.tool_use_id !== 'string') continue;
      acc.results.set(result.tool_use_id, textOf(result.text));
    }
  }

  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'function_call' || type === 'tool_call' || type === 'tool_use') {
    const id = textOf(value.call_id || value.tool_use_id || value.id);
    const tool = textOf(value.name || value.tool);
    if (id && tool) acc.uses.push({ id, tool, input: argsOf(value.arguments ?? value.input) });
  }
  if (type === 'function_call_output' || type === 'tool_result') {
    const id = textOf(value.call_id || value.tool_use_id);
    if (id) acc.results.set(id, textOf(value.output ?? value.content ?? value.text));
  }

  for (const child of Object.values(value)) walk(child, acc, seen, depth + 1);
}

/** Pairs tool calls with their outputs. Ids are `t1`, `t2`, … in transcript order. */
export function extractCalls(text) {
  const acc = { uses: [], results: new Map() };
  const seen = new WeakSet();
  for (const doc of parseDocuments(text)) walk(doc, acc, seen, 0);
  const calls = [];
  const used = new Set();
  for (const use of acc.uses) {
    if (used.has(use.id) || !acc.results.has(use.id)) continue;
    used.add(use.id);
    const result = acc.results.get(use.id) ?? '';
    calls.push({
      id: `t${calls.length + 1}`,
      tool_use_id: use.id,
      tool: use.tool,
      input: use.input,
      result,
      resultChars: result.length,
    });
  }
  return calls;
}

export function markPinned(calls, preserveRecentMessages) {
  const recent = Number.isFinite(preserveRecentMessages) ? Math.max(0, Math.floor(preserveRecentMessages)) : 6;
  const total = calls.length;
  return calls.map((call, index) => ({
    ...call,
    pinned: index === 0 || index >= total - recent,
  }));
}

function questionsFor(call) {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

function noul(answers, name) {
  const answer = answers?.[name];
  if (!answer || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

function stateFor(calls) {
  const history = [];
  let used = 0;
  for (const call of calls) {
    const entry = {
      id: call.id,
      tool: call.tool,
      input: textOf(call.input).slice(0, 1000),
      result: `ok, ${call.resultChars} chars (omitted)`,
    };
    const next = used + textOf(entry).length;
    if (history.length > 0 && next > 80_000) break;
    history.push(entry);
    used = next;
  }
  return { context: STATE_CONTEXT, history };
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Asks Jev about calls that are not pinned. `fetchImpl` is injectable in tests.
 * Returns one decision per input call.
 */
export async function scoreCalls(calls, options) {
  const provider = providerOf(options.provider);
  const threshold = typeof options.keepThreshold === 'number' ? options.keepThreshold : 0.5;
  const marked = markPinned(calls, options.preserveRecentMessages ?? 6);
  const candidates = marked.filter((call) => !call.pinned);
  const answers = new Map();
  let requests = 0;
  if (candidates.length > 0) {
    if (!options.apiKey) throw new Error(`${provider.envKey} is not configured`);
    const state = stateFor(marked);
    const fetcher = options.fetchImpl ?? fetch;
    const batches = chunks(candidates, 6);
    const responses = await Promise.all(
      batches.map(async (batch) => {
        const questions = Object.assign({}, ...batch.map(questionsFor));
        const response = await fetcher(options.baseUrl || provider.baseUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model || provider.defaultModel,
            state,
            questions,
          }),
        });
        if (!response.ok) {
          throw new Error(`Jev request failed (${response.status})`);
        }
        const body = typeof response.text === 'function' ? await response.text() : response.text;
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed.answers !== 'object' || parsed.answers === null) {
          throw new Error('Jev response is missing answers');
        }
        return [batch, parsed.answers];
      }),
    );
    requests = responses.length;
    for (const [batch, batchAnswers] of responses) {
      for (const call of batch) {
        answers.set(call.id, {
          keepCall: noul(batchAnswers, `call_${call.id}`),
          keepResult: noul(batchAnswers, `result_${call.id}`),
        });
      }
    }
  }

  const decisions = marked.map((call) => {
    const answer = answers.get(call.id) ?? { keepCall: 1, keepResult: 1 };
    if (call.pinned) return { ...call, ...answer, action: 'keep', reason: 'pinned' };
    if (answer.keepResult >= threshold) return { ...call, ...answer, action: 'keep', reason: 'kept' };
    if (answer.keepCall >= threshold) {
      return { ...call, ...answer, action: 'drop_result', reason: 'result_dropped' };
    }
    return { ...call, ...answer, action: 'drop_call', reason: 'call_dropped' };
  });
  return { decisions, requests };
}

/** Verbatim outputs Codex's summary is not allowed to lose. Capped so the next turn still fits. */
export function reinjectText(decisions, maxChars = 16_000) {
  const kept = decisions
    .filter((decision) => decision.reason === 'kept' && decision.result.length > 200)
    .sort((a, b) => b.keepResult - a.keepResult);
  if (kept.length === 0) return '';
  const parts = [
    'Jev kept these tool outputs verbatim. The built-in summary may have dropped them. Use this text instead of guessing, and re-run the tool if an excerpt is cut.',
  ];
  let used = parts[0].length;
  for (const decision of kept) {
    const head = `[${decision.tool} ${decision.tool_use_id}]`;
    let body = decision.result;
    if (body.length > 4000) {
      body = `${body.slice(0, 4000)}\n[jev-compaction truncated ${decision.result.length - 4000} chars of this tool result; re-run the tool if needed]`;
    }
    const block = `${head}\n${body}`;
    if (used + block.length + 2 > maxChars) break;
    parts.push(block);
    used += block.length + 2;
  }
  return parts.length === 1 ? '' : parts.join('\n\n');
}

export function safeSessionId(sessionId) {
  const clean = String(sessionId ?? 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return clean || 'session';
}
