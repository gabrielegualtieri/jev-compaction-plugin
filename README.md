# jev-compaction-plugin

Verbatim context compaction for Claude Code, judged by [TypeSafe Jev](https://www.typesafe.ai).

When a session is compacted, this plugin does **not** ask a model to write a summary. It sends the conversation to Jev, drops tool calls that no longer matter, truncates tool results that do not need to stay in full, and leaves every kept character exactly as it was.

The same decision engine lives in [`src/`](src) and can be called without Claude Code.

Claude Code plugin `0.3.0` · library `0.2.0` · MIT · Node 18+

> [!IMPORTANT]
> This repository is the source of truth for the code in this tree. It is **not** the package published on npm as [`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction) (`0.4.1`, publisher `aleksvega`). That package is a different project (extra CLIs, `npx jev-setup`, OpenRouter). `npm install fast-jev-compaction` will not install this repo.
>
> `package.json` here is still named `fast-jev-compaction` at version `0.2.0`. The Claude Code manifest in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) is version `0.3.0`. Neither version is published to npm from this GitHub repository.

## Contents

- [What stays, what goes](#what-stays-what-goes)
- [How a compaction runs](#how-a-compaction-runs)
- [Decisions](#decisions)
- [The state Jev actually sees](#the-state-jev-actually-sees)
- [Use the library](#use-the-library)
- [Library options](#library-options)
- [Claude Code plugin](#claude-code-plugin)
- [Repository map](#repository-map)
- [Development](#development)
- [Limits](#limits)

## What stays, what goes

| Kept verbatim | Shortened | Removed |
| --- | --- | --- |
| User and assistant **text** | A tool **result** Jev says is no longer needed in full | A tool **call and its result**, together, when Jev says the call itself does not matter |
| Pinned calls (first message, and the newest tail) | The note names how many characters were cut, so the assistant can re-run the tool | A message that has no text left and no tools left |
| Calls that have no `tool_result` yet | | |

Text is never paraphrased. The only strings this library writes are the truncation note and, inside the **request** sent to Jev, short stand-ins for outputs that are too large to resend.

## How a compaction runs

```mermaid
flowchart TD
  start[Transcript] --> pair[Pair each tool_use with its tool_result]
  pair --> pin{Call or result in the pinned window?}
  pin -->|yes| keep[Keep call and result]
  pin -->|no| fit[Fit a result-free state into maxStateTokens]
  fit --> ask[Ask Jev two questions per call]
  ask --> result{keepResult at or above threshold?}
  result -->|yes| keep
  result -->|no| call{keepCall at or above threshold?}
  call -->|yes| trunc[Keep the call, truncate the result]
  call -->|no| drop[Drop the call and the result]
  keep --> ratio{Plugin only: reduction large enough?}
  trunc --> ratio
  drop --> ratio
  ratio -->|yes| done[Replace history. No summary.]
  ratio -->|no, or any error| builtin[Claude Code built-in summary]
```

The library stops at the decisions. The fallback box on the right is the Claude Code hook, not `compact()`.

1. **Pair.** Every `tool_use` is matched to a `tool_result` by `tool_use_id`. A call with no result is ignored: there is nothing to drop yet, and it does not appear in `decisions`.
2. **Pin.** Message `0` is always pinned. So are the newest `preserveRecentMessages` messages (`6` by default). A call is pinned when **either** the call message **or** the result message is in that set. Pinned calls are not sent to Jev.
3. **Fit.** Jev does not receive tool outputs. It receives a structured state. If that state is over `maxStateTokens`, it is reduced in fixed stages (below). Fitting never changes the transcript.
4. **Ask.** Each eligible call becomes two `noul` questions. Batches run at the same time. Every batch is sent with the **same** full state.
5. **Apply.** The transcript is rebuilt. Untouched messages are the same objects that went in. A message whose text is empty and whose tools are all gone is deleted. A result is never left without its call.

`compact()` throws if the key is missing, Jev fails, an answer is malformed, or the history cannot be fitted. It does not catch those errors.

## Decisions

Threshold defaults to `0.5`. Comparison is `>=`.

| `keepResult` | `keepCall` | `action` | `reason` | Transcript |
| --- | --- | --- | --- | --- |
| *(not asked)* | *(not asked)* | `keep` | `pinned` | Untouched. Recorded as probability `1`. |
| ≥ threshold | any | `keep` | `kept` | Call and full result stay. |
| < threshold | ≥ threshold | `drop_result` | `result_dropped` | Call stays. Result is replaced. |
| < threshold | < threshold | `drop_call` | `call_dropped` | Call and result are both removed. |

A `drop_result` that is already short is **not** rewritten. "Short" means `text.length <= truncateHeadChars + 120` (`420` characters at the default head of `300`). The original message object is returned, including any Claude Code handle.

Otherwise both copies of the output are rewritten: `tool_use.text` on the assistant message and `tool_result.text` on the user message.

```text
<first truncateHeadChars characters>
[fast-jev-compaction truncated N chars of this tool result; re-run the tool if needed]
```

Errors insert ` (error)` before the semicolon: `this tool result (error); re-run...`. With `truncateHeadChars: 0` the head line is omitted and only the note remains.

Question names are `call_t1`, `result_t1`, `call_t2`, … where `t1` is the first paired call in the transcript.

## The state Jev actually sees

One JSON object:

| Field | Content |
| --- | --- |
| `context` | Fixed instructions: outputs are omitted, deletions are permanent, tools can be re-run. |
| `goal` | `options.goal`, or the last three **user** prompts that have text and **no** tool results. Each prompt is cut at 500 characters. |
| `history` | One entry per message that still has text or a paired call: `{ i, role, text, tool_calls? }`. |

Each call in the full state looks like:

```json
{ "id": "t3", "tool": "Read", "input": "{\"file_path\":\"src/a.ts\"}", "result": "ok, 4213 chars (omitted)" }
```

`result` is `error, N chars (omitted)` when the tool result is an error. The number `N` is the real output length. The bytes are not included.

### Fitting stages

Applied in order. The first stage that lands at or under `maxStateTokens` (default `25000`) wins. `stats.stateStage` is the label below.

| Stage label | What changes in the **state only** |
| --- | --- |
| `full` | Tool inputs truncated to 1000 characters. |
| `inputs<=200` | Inputs truncated to 200. |
| `inputs<=60` | Inputs truncated to 60. |
| `texts abridged` | Long texts become 400 characters, `[… N chars omitted …]`, then the last 150. Oldest unpinned entries first, pinned entries last. A text is abridged only if it is longer than 590 characters. |
| `old messages collapsed` | Unpinned text becomes `[… N chars omitted …]`, with `N` taken from the original message. |
| `old calls compacted` | Unpinned calls become one line: `t12 Read file_path=src/a.ts → ok 480ch`. |
| `old messages left out` | Unpinned entries that contain no call are removed. |
| `old calls merged` | Adjacent unpinned, call-only entries of the same role are folded into one entry. Call ids stay. |

If the last stage is still over budget, `fitState` throws:

```text
history too large for Jev (~N tokens after truncation, limit 25000)
```

Token counts are an estimate, not a tokenizer. A word costs one token per six letters, a run of digits costs half a token per digit, any other symbol costs `0.9`. The total is rounded up. On real Jev transcripts this lands a little **above** the usage Jev reports, which is what you want for a ceiling. There is a flat 20-token allowance for the request envelope on top of state and questions.

### Batches

Questions are split so that `state + questions + 20` stays under `maxRequestTokens` (default `30000`, under Jev's 32k request limit). The state is repeated on every request. Batches run with `Promise.all`. If the state is so large that a single call's two questions do not fit, compaction throws `state leaves no room for questions`. If there is nothing to ask, no HTTP request is made: `stats.requests` is `0` and `stats.stateStage` is `""`.

## Use the library

From a checkout of **this** repository, not from the npm registry:

```sh
git clone https://github.com/gabrielegualtieri/jev-compaction-plugin.git
cd jev-compaction-plugin
npm install
npm run build
export TYPESAFE_API_KEY=...   # never commit this
```

Point a dependency at the checkout (`"fast-jev-compaction": "file:../jev-compaction-plugin"`) and import the built entry. `tsx` scripts inside the repo can import [`src/index.ts`](src/index.ts) the way [`examples/demo.ts`](examples/demo.ts) does.

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'toolu_1', text: 'export const a = 1;\n' }],
  },
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });

if (reductionRatio(result) < 0.25) {
  // Not worth replacing the transcript. Keep the original, or summarize.
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript can be passed through as-is.

Prefer your own HTTP client: implement `JevAsker` (`ask(state, questions)`) and call `compact(messages, asker, options)`. `buildJevRequest` and `parseJevResponse` build the `POST` and reject anything that is not an `answers` object. `noulAnswer` throws if a named answer is missing or not a finite `noul`.

The request this client sends:

```http
POST https://api.typesafe.ai/v1/systemone
authorization: Bearer $TYPESAFE_API_KEY
content-type: application/json

{ "model": "jev-latest", "state": {}, "questions": {} }
```

`JevClient` reads `apiKey` from the options, otherwise `process.env.TYPESAFE_API_KEY`. An empty key throws `TYPESAFE_API_KEY is not configured` before any network call.

Other exported pieces, if you want to drive a step yourself: `collectToolCalls`, `fitState`, `goalFromMessages`, `estimateTokens`, `batchCalls`, `questionsFor`, `decideCall`, `applyDecisions`, `messageChars`, `resolveOptions`.

### What `stats` means

| Field | Meaning |
| --- | --- |
| `messagesBefore` / `messagesAfter` | Transcript length. |
| `charsBefore` / `charsAfter` | Sum of message text, `JSON.stringify` of each tool **input**, and each **tool result** text. `tool_use.text` is not counted. A circular input counts as 20. |
| `calls` | Paired calls, pinned included. |
| `pinned`, `kept`, `resultsDropped`, `callsDropped` | Counts by `reason`, not by `action`. |
| `stateTokens`, `stateStage` | Fitted state. Both stay empty/`0` when nothing was asked. |
| `requests` | HTTP batches. |
| `ms` | Wall time inside `compact()`, including the concurrent requests. |

`reductionRatio(result)` is `(charsBefore - charsAfter) / charsBefore`, or `0` when the transcript has no counted characters. It is a character ratio, not a token ratio, and it ignores `tool_use.text`.

## Library options

Passed to `compact` / `compactMessages`. Invalid numbers fall back to the default. `preserveRecentMessages` and `truncateHeadChars` are floored at `0`.

| Option | Default | Role |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | `compactMessages` / `JevClient` only. |
| `model` | `jev-latest` | Model field. The hook passes this; `compact()` does not. |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | `JevClient` only. The Claude hook always uses the default URL. |
| `fetch` | global `fetch` | `JevClient` only, for tests. |
| `goal` | last 3 qualifying user prompts | Task description inside the state. |
| `keepThreshold` | `0.5` | Minimum probability to keep a call or a result. |
| `preserveRecentMessages` | `6` | Newest messages pinned, **plus** message `0`. |
| `maxStateTokens` | `25000` | Estimated ceiling for the state. |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions. |
| `truncateHeadChars` | `300` | Characters kept from a dropped result before the note. |

With the default tail, a transcript is fully pinned until it is longer than 7 messages (`preserveRecentMessages + 1`). A call can still be pinned after that, if its result landed in the tail.

## Claude Code plugin

[`hooks/fast-jev.ts`](hooks/fast-jev.ts) registers two function hooks. The plugin root is the repository root, so the hook imports [`src/`](src) directly. No build step is required to load it.

| Hook | Behavior |
| --- | --- |
| `session.compact` | Runs the library. On success **and** a character reduction of at least `minReductionRatio`, returns `{ messages }` and skips the built-in summary. Otherwise calls `next` and Claude summarizes as usual. |
| `turn.complete` | Reads `session.usage().context.percent`. At or above `compactAtPercent` (default `60`), calls `session.compact()` once. An in-flight flag ignores re-entry. Failures are logged as `auto-compact skipped (...)`, not toasted. |

Function hooks are early access. The checked-in types in [`types/claude-code.d.ts`](types/claude-code.d.ts) were generated by Claude Code **2.1.274**. Set the opt-in wherever Claude Code runs, for example `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "TYPESAFE_API_KEY": "<your key>"
  }
}
```

Install **this** marketplace. The marketplace id inside [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) is `fast-jev-compaction`; the GitHub repo name is `jev-compaction-plugin`. Both show up in the commands:

```sh
claude plugin marketplace add gabrielegualtieri/jev-compaction-plugin
claude plugin install fast-jev-compaction@fast-jev-compaction
```

From a local checkout, skip the marketplace:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

Restart Claude Code so the plugin loads. The install UI asks for the `userConfig` values; leave them blank to keep the defaults and take the key from the environment.

Key lookup, in order:

1. Plugin option `apiKey`, if it is a non-empty string.
2. `TYPESAFE_API_KEY` from the hook environment.
3. `env.TYPESAFE_API_KEY` inside Claude settings.

A missing key, an HTTP error, a bad answer, a state that will not fit, or a reduction under `minReductionRatio` all fall through to the built-in summary. The default minimum is `0.25` (25% of counted characters).

### What you see in the UI

Toasts stay up for 15 seconds. There is **no** `fast-jev-compaction:` prefix.

| Outcome | Toast |
| --- | --- |
| History replaced | `kept 5/7 messages, no summary (42% reduction; 1 kept, 1 call_dropped; state ~800 tokens (full) in 1 request(s))` |
| Jev ran, but the shrink was too small | `fallback to built-in summary (below 25% minimum: …)` |
| Anything threw | `fallback to built-in summary (TYPESAFE_API_KEY is not configured)` — the parentheses are the error message |

`kept 5/7` is **messages** after / before. The later `1 kept` is the number of non-pinned calls whose **result** was kept. Different counts, same word.

The summary fragments, omitted when zero, are `N kept`, `N results truncated`, `N call_dropped`, `N pinned`. If none apply: `no tool calls`.

Before the toast, non-pinned decisions are written to the log, split so each line stays under 4096 characters:

```text
decisions: t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90
```

`action` is the third field (`keep`, `drop_result`, `drop_call`). Pinned calls are not listed. A run with only pinned calls logs `decisions: (none)`. Ratio fallbacks still log decisions. Error fallbacks do not.

Rebuilt messages are new objects without the engine handle, which is how Claude picks up the edit. Untouched messages, and short results that did not need a rewrite, keep their handles.

Plugin options declared in `userConfig`:

| Option | Default | Passed to the library? |
| --- | --- | --- |
| `apiKey` | unset | No. Used only to authenticate. |
| `keepThreshold` | `0.5` | Yes |
| `preserveRecentMessages` | `6` | Yes |
| `maxStateTokens` | `25000` | Yes |
| `maxRequestTokens` | `30000` | Yes |
| `truncateHeadChars` | `300` | Yes |
| `model` | `jev-latest` | As the HTTP `model` field |
| `compactAtPercent` | `60` | No. Auto-compact trigger only. |
| `minReductionRatio` | `0.25` | No. Accept/reject the result only. |

A non-numeric value is ignored and the default is used. `goal` is not in the manifest; if a string `goal` is present in plugin options anyway, the hook forwards it. `baseUrl` is not configurable on the hook.

More operator detail: [`hooks/README.md`](hooks/README.md).

## Repository map

```text
src/compact.ts          pair, decide, rebuild, compact()
src/state.ts            pinning, token estimate, fitState()
src/request.ts          POST body, response checks, noulAnswer()
src/client.ts           JevClient
src/messages.ts         compactMessages()
hooks/fast-jev.ts       session.compact and turn.complete
.claude-plugin/         plugin.json 0.3.0, marketplace id fast-jev-compaction
tests/                  vitest, fake Jev, no network
examples/demo.ts        one live compaction of a canned parser-bug transcript
demo/JevDemo/           macOS SwiftUI player for screen recording, no API
types/claude-code.d.ts  function-hook types from Claude Code 2.1.274
```

## Development

```sh
npm install
npm run typecheck       # src/ and hooks/
npm test                # fake Jev, never calls TypeSafe
npm run build           # tsc → dist/, the published-style entry
npm run validate:plugin # claude plugin validate .claude-plugin/plugin.json
TYPESAFE_API_KEY=... npm run demo
```

The demo compacts [`examples/demo.ts`](examples/demo.ts) with `preserveRecentMessages: 2` and prints each decision. It spends real API usage.

The macOS animation does not. It plays a scripted transcript inside a Claude-style terminal: dropped calls collapse, kept text stays. Space replays.

```sh
demo/JevDemo/build.sh   # demo/JevDemo/build/JevDemo.app, then open
```

Requires macOS 14 and `swiftc`. `demo/JevDemo/build.sh --no-launch` only builds.

## Limits

- A probability is not a proof the result is safe to delete. The note tells the assistant to re-run the tool.
- Ordinary prose is not compacted. A long chat with small tool outputs often misses `minReductionRatio`, and the hook correctly falls back to Claude's summary.
- The character ratio ignores `tool_use.text`. If an output exists only there, and not on `tool_result.text`, the hook underestimates the savings.
- The token estimate is deliberately a bit high, and it is not the tokenizer Jev uses. Do not treat `stateTokens` as billing.
- Every batch resends the whole state. A transcript near 25k estimated tokens costs one request per small group of questions.
- Function hooks can change between Claude Code releases. After an upgrade, regenerate `types/claude-code.d.ts` and re-read the hook.
- Do not put `TYPESAFE_API_KEY` in the repo. `.gitignore` already ignores `.env`.

## License

[MIT](LICENSE).
