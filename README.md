# jev-compaction-plugin

Verbatim context compaction judged by [TypeSafe Jev](https://www.typesafe.ai). One install, two hosts, and a setup command that asks each person for their own provider and key.

| Host | What Jev is allowed to do |
| --- | --- |
| **Claude Code** | Replace the built-in summary. Kept text stays verbatim. Tool calls Jev rejects are deleted or truncated. |
| **Codex / ChatGPT** | Codex still writes the summary. Afterward the plugin puts back the tool outputs Jev said must stay verbatim. Codex cannot accept a replacement history yet. |

Jev is not a chat model. Both providers speak the System One API (`model`, `state`, `questions`, `answers.*.noul`). Do not point this plugin at `chat/completions`.

> [!IMPORTANT]
> This repository is not the npm package [`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction). That package is a different project. Install from this GitHub repo.

Plugin and library version: `0.4.0`. MIT. Node 18+ (the setup script and the Codex hook need Node 18 with `fetch`).

## Configure, then install

Each host has its own section. Claude can use OpenRouter while Codex uses TypeSafe, or the other way around. Run the wizard once from a checkout:

```sh
git clone https://github.com/gabrielegualtieri/jev-compaction-plugin.git
cd jev-compaction-plugin
node scripts/setup.mjs
```

It asks which host (`claude`, `codex`, or `both`), then for each one:

1. Provider: `typesafe` or `openrouter`.
2. The API key. On macOS and Linux it is hidden. On Windows it stays visible, then the wizard continues and saves.
3. Optional model and thresholds. Enter keeps the defaults.

The key is written to `~/.config/jev-compaction/config.json` (mode `0600`):

```json
{
  "claude": { "provider": "openrouter", "apiKey": "…" },
  "codex": { "provider": "typesafe", "apiKey": "…" }
}
```

For Claude, the wizard also sets `~/.claude/settings.json`:

- `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` = `1` (required; function hooks are early access)
- `env.JEV_COMPACTION_PROVIDER`
- `env.TYPESAFE_API_KEY` or `env.OPENROUTER_API_KEY`, matching the provider

Other settings in that file are left alone. The key is not printed back; the confirmation shows only the last four characters.

Non-interactive, one host at a time:

```sh
node scripts/setup.mjs --host claude --provider openrouter --api-key "$OPENROUTER_API_KEY"
node scripts/setup.mjs --host codex --provider typesafe --api-key "$TYPESAFE_API_KEY"
```

Optional flags: `--model`, `--keep-threshold`, `--preserve-recent`, `--compact-at`, `--min-reduction`, `--config`, `--claude-settings`, `--no-claude-settings`. `--help` lists them.

Running setup again updates only the host you name. The other host stays as it was.

### Where a value comes from

| Order | Claude Code | Codex |
| --- | --- | --- |
| 1 | Plugin install prompt, when you set a **non-default** value or any API key | `codex` section of the setup file |
| 2 | `claude` section of the setup file | `JEV_COMPACTION_PROVIDER` and `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` |
| 3 | Those same environment variables, including Claude settings `env` | |
| 4 | Built-in defaults (`typesafe`, `jev-latest`, threshold `0.5`) | |

Leave the Claude install prompts at their defaults if you want the setup file to win. A key typed into the install prompt always wins over the file. Defaults that match the manifest (`provider=typesafe`, `keepThreshold=0.5`, …) do not, so a saved default does not block OpenRouter in the file.

`JEV_COMPACTION_CONFIG` overrides the config path.

## Providers

| | TypeSafe | OpenRouter |
| --- | --- | --- |
| Endpoint | `https://api.typesafe.ai/v1/systemone` | `https://openrouter.ai/api/v1/systemone` |
| Env key | `TYPESAFE_API_KEY` | `OPENROUTER_API_KEY` |
| Model | `jev-latest` | `jev-latest` (OpenRouter maps it to `~typesafe/jev-latest`) |

Same JSON body. OpenRouter may add `id`, `provider`, and `usage.cost`; those are ignored. Input tokens are billed on the account you chose. Output tokens are free. The request still has to stay under Jev's 32k limit (`maxStateTokens` 25000, `maxRequestTokens` 30000).

A library caller passes the provider through:

```ts
import { compactMessages } from 'fast-jev-compaction';

await compactMessages(transcript, { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY });
```

Build this repo first (`npm run build`) and depend on it with `"fast-jev-compaction": "file:../jev-compaction-plugin"`. Do not `npm install fast-jev-compaction` from the public registry.

## Install on Claude Code

After `node scripts/setup.mjs --host claude`:

```sh
claude plugin marketplace add gabrielegualtieri/jev-compaction-plugin
claude plugin install fast-jev-compaction@fast-jev-compaction
```

From a checkout, without the marketplace:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

Restart Claude Code. The marketplace id inside [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) is `fast-jev-compaction`. The GitHub repo name is `jev-compaction-plugin`. Both appear in the commands above.

`/compact`, and auto-compact when the context reaches `compactAtPercent` (default 60), go through `session.compact`. On success, and only if the character reduction is at least `minReductionRatio` (default 25%), the history is replaced and Claude does not summarize. Otherwise you get the built-in summary. Toasts do not have a plugin prefix:

| Outcome | Toast |
| --- | --- |
| History replaced | `kept 5/7 messages, no summary (42% reduction; …)` |
| Shrink too small | `fallback to built-in summary (below 25% minimum: …)` |
| Key missing, HTTP error, bad answer, state too big | `fallback to built-in summary (<message>)` |

`kept 5/7` counts messages. Inside the parentheses, `1 kept` counts non-pinned calls whose full result survived. The decision log is separate: `decisions: t1:Read:drop_call/call=0.10/result=0.10`.

Hook detail: [`hooks/README.md`](hooks/README.md).

## Install on Codex (ChatGPT's coding agent)

ChatGPT the chat product has no compaction hook. This target is Codex: the Codex CLI and the Codex plugin directory shared with ChatGPT.

```sh
node scripts/setup.mjs --host codex
codex plugin marketplace add gabrielegualtieri/jev-compaction-plugin
```

Approve the hooks when Codex asks. The manifest is [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json). It points at [`codex/hooks.json`](codex/hooks.json), not at Claude's function-hook module.

What actually happens:

1. `PreCompact` reads `transcript_path`, scores tool calls with Jev, and lets Codex summarize (`continue: true`). It cannot return a replacement transcript. That gap is [openai/codex#46337](https://github.com/openai/codex/issues/46337).
2. `SessionStart` with source `compact` injects the outputs Jev marked `kept` as `additionalContext`, capped at 16k characters.

A missing key or a bad transcript does not stop compaction. Codex shows a `systemMessage` and summarizes as usual. The transcript format is not a stable Codex API; the parser accepts Claude-style `toolUses` / `toolResults` and Codex `function_call` / `function_call_output` records, including JSONL.

## What Claude keeps

Pinned messages are never sent to Jev: message `0`, and the newest `preserveRecentMessages` (default 6). A call is pinned if either the call or its result sits in that window. Calls with no result yet are ignored.

| `keepResult` | `keepCall` | Result |
| --- | --- | --- |
| not asked (pinned) | | Untouched |
| ≥ threshold (default 0.5) | any | Call and full result stay |
| below | ≥ threshold | Call stays. Result is cut to `truncateHeadChars` (300) plus a note, unless it is already shorter than that head + 120 characters |
| below | below | Call and result are both removed |

User and assistant text is never rewritten. A message that loses all of its text and tools is dropped. The truncation note is:

```text
[fast-jev-compaction truncated N chars of this tool result; re-run the tool if needed]
```

Jev does not see the tool output. It sees `ok, N chars (omitted)` (or `error, …` when the result is an error). If that state is over 25k estimated tokens it is reduced in stages: shorter inputs, abridged text, collapsed old messages, one-line calls, then dropped call-less entries. The stage name is `stats.stateStage`. If it still does not fit, compaction throws and Claude falls back.

Token estimates are deliberately a little high. They are not Jev's tokenizer and not the billing figure.

## Options

| Option | Default | Claude | Codex |
| --- | --- | --- | --- |
| `provider` | `typesafe` | yes | yes |
| `apiKey` | env / setup file | yes | yes |
| `model` | `jev-latest` | yes | yes |
| `keepThreshold` | `0.5` | yes | yes |
| `preserveRecentMessages` | `6` | yes | yes (last calls, plus the first) |
| `maxStateTokens` | `25000` | yes | no (Codex caps the state at 80k characters) |
| `maxRequestTokens` | `30000` | yes | no (Codex batches 6 calls) |
| `truncateHeadChars` | `300` | yes | no |
| `compactAtPercent` | `60` | auto-compact only | no |
| `minReductionRatio` | `0.25` | accept or fall back | no |

## Develop

```sh
npm install
npm test          # no network
npm run typecheck
npm run setup     # the wizard
TYPESAFE_API_KEY=... npm run demo
```

`npm test` uses a fake Jev. `npm run demo` spends a real TypeSafe call.

The macOS animation in `demo/JevDemo` does not call the API.

```sh
demo/JevDemo/build.sh
```

## Limits

- A probability is not a proof. The assistant can re-run the tool.
- Claude only replaces history when the character reduction is at least 25%. Long chats with small tool outputs fall back to the summary. The ratio ignores `tool_use.text`.
- Codex always summarizes, then restores what Jev kept. That can duplicate text the summary already kept.
- Codex's transcript parser will miss calls in a shape it does not recognize. Compaction still proceeds.
- Function hooks are early access and the checked-in types are from Claude Code 2.1.274.
- Do not commit keys. The setup file lives outside the repo.

## License

[MIT](LICENSE).
