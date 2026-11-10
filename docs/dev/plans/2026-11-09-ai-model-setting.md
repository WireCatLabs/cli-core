# Plan: one "AI model" setting that can replace the agent

Status: the first slice is built (cli-core `models ai`, memo image reading, Desktop «Модель ИИ»). The rest is open.

## What is built, and where it differs from the design below

Owner rulings: NEED-2463 (one third-party model setting that replaces the agent), NEED-2465…2468 (open questions
1–4, below), NEED-2494 A (image recognition waits for this setting).

- **cli-core** (`src/models/ai.ts`, `src/cli/ai-model-command.ts`): the shared `ai` section, the shared key
  (service `WireCat`, account `ai:<origin>`, `isMovedRun`), `models ai show|set|unset|remove|revoke|check` mounted in memo's
  `models`, owner-only (`agentOf` refuses unless `--from-app`; `mcp: false`), and `aiImageReader` for images.
- **Differs: no bottom layer of `models.default`.** Each job opts in by reading `readAiSetting` itself. That keeps
  `analysis` and the other purposes exactly as they are, with no per-purpose gate to add (§1's gate table).
- **Differs: the https-or-loopback rule applies to `ai.base_url` only.** The public `endpoint()` is unchanged, so no
  caller breaks. Question 3 A holds for the new setting.
- **Added: image consent.** `models ai set … --allow-remote` stores `images: {origin, model, at}`; a `set` without it, or `models ai revoke`, drops it. Images go only to that
  origin and model; a change of either closes it until the owner agrees again.
- **Check** reads the HTTP status the gateway now keeps in `details.status`: 401/403, 402, 404, 429, 5xx. OpenAI's
  "no credit" 429 codes and OpenRouter's 200-with-error body are not told apart yet; they read as rate-limited and
  failed.
- **Open:** the `ai-model` reader and the per-job `jobs` map (§2), enrichment following `ai` (C5), merging the two
  `models keys` commands (C3), tg/max `personal models ai`, the full reason table (C4).

## Goal

The owner's decision of 2026-11-09:

> There must be a choice of a third-party model that replaces the agent, with the ability to enter keys, and
> support on all platforms. Ollama: yes, as a beta, if it is not hard. Anthropic and OpenAI: yes, with the
> ability to change the URL, so OpenRouter and others can be connected. Explain this to users.

What this means in practice:

- **One setting.** Provider, model, API key and base URL, chosen once.
  - Every WireCat CLI (memo, tg, max, mail…) and WireCat Desktop read it.
- **Three providers.**
  - Anthropic.
  - "OpenAI or compatible", which also covers OpenRouter, Together, LM Studio and others through a base URL.
  - Ollama on this computer, marked beta.
- **A "Check" button.** It makes one tiny call and says in plain words what is wrong.
- **Linux, macOS and Windows.** The key goes in the system keyring, or in a 0600 file when there is no keyring.
- **A model instead of an agent.** The jobs an agent does today that a model can do get the model as a choice.
- **Security.** The key never reaches argv, logs or the screen. It goes only to the address it was saved
  with. An agent cannot change the address or the key.

## Current state

Refs read, so every line number below can be checked:

- cli-core at `916b7eef7` (0.620.0), re-read at `050cd56d5` (0.624.0): the files below did not change in a way that
  moves these lines. Paths are relative to this repository.
- memo `origin/main` [`2ad5587`](https://github.com/WireCatLabs/cli-memo/tree/2ad55877a69611c88dc2d0d413d0c2aaf93296c2)
  (0.131.72), re-read at `e9873e3` (0.131.75).
- Desktop `origin/main` [`1440371`](https://github.com/WireCatLabs/wirecat-desktop/tree/14403716f619e10c2868da9a13a47e4457883716)
  (#232), re-read at `4f1f6b09` (#255).

### Most of it already exists, in four places that do not share

| Piece | Where | What it keeps | Shared across CLIs? |
|---|---|---|---|
| `models.<purpose>` setting | `src/models/settings.ts:6-19`, resolved at `:23-74` | `provider` (`off`/`openai`/`anthropic`), `model`, `base_url`, per purpose, with `default` as the fallback (`:51-62`) | **No.** Each CLI's own config layers, plus `<PREFIX>_MODELS_<PURPOSE>_*` env (`:36,44`) |
| Enrichment setting | `src/services/enrichment-setting.ts:17-28` | `provider`, `model`, `base_url`, `consented_at` | **Yes.** Section `enrichment` of `~/.config/WireCat/config.json` (`:32`, `src/store/shared-config.ts:22-28`) |
| memo's reader choice | [memo `src/config.ts:88-94`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/config.ts#L88-L94) | `sources: {reader, model}` | No, memo's own config |
| memo `answers --analyze` | [memo `src/answers/command.ts:142-160`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/answers/command.ts#L142-L160) | `MEMO_MODELS_ANALYSIS_*` env, key from `MEMO_MODEL_API_KEY` env | No, env only |

### Providers and adapters

- **The gateway.** `modelGateway` (`src/models/index.ts:19-95`) accepts only two adapters, `openai` and
  `anthropic` (`:36-39`).
  - Errors use one fixed message, with no provider text in it.
  - The reason is `model.key-rejected` on 401/403 or `model.unreachable` on a network failure (`:69-91`).
  - 429 becomes `rate_limited` (`:80-81`).
  - Nothing else is told apart. The OpenAI adapter throws the status away (`src/models/openai.ts:50`:
    `if (!response.ok) throw new Error(...)`).
- **The OpenAI adapter.**
  - It sends `POST {baseUrl}/chat/completions` with `Authorization: Bearer` only when a key exists
    (`src/models/openai.ts:22-24`).
  - It sends `max_completion_tokens` to api.openai.com and `max_tokens` to every other host (`:43-45`).
  - It sets `redirect: "error"` (`:48`).
  - It accepts only `finish_reason: "stop"` (`:57`).
- **The Anthropic adapter.** It uses `@anthropic-ai/sdk` with `baseURL` from the target, `maxRetries: 0`,
  `logLevel: "off"`, `redirect: "error"` and a 120 s timeout (`src/models/anthropic.ts:16-24`).
- **memo's native Ollama reader.** It is pinned to `http://127.0.0.1:11434` on purpose ("a remote one would be a way
  to send the text off it"), and it calls `/api/generate`
  ([memo `src/sources/readers/ollama.ts:4-5`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/sources/readers/ollama.ts#L4-L5)).

### Base URL

- **A custom base URL is already supported** by `models.<purpose>.base_url`, `models consents set --base-url`
  (`src/cli/enrichment-consents-command.ts:81`) and the analysis choice (`src/cli/analysis-choice.ts:37-41`).
- **`endpoint()` accepts `http:` for any host** (`src/models/endpoint.ts:4`). It refuses only credentials, a
  query or a fragment.
- A loopback check exists, but only for remote embeddings: `isLocal`, with
  `localhost`, `127.0.0.1` and `::1` (`src/embeddings/remote.ts:35-38`).

### Keys

- **Accounts and lookup order.** `embeddingKeys` (`src/embeddings/keys.ts:20-49`) reads the keyring account
  `embeddings:<name>`, then the env variable `<PREFIX>_<P>_API_KEY`, then `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`
  (for those two names only), then a 0600 file. Storage is cli-base `Credentials` in `auto` mode.
- **The service is the CLI's own `app.appName`** (`keys.ts:25`). A key saved through memo is invisible to tg and
  max.
- **The name of a custom URL's key is its host** (`endpointKeyName`, `keys.ts:10-13`). So `http://x` and
  `https://x` share one key, and so do two paths on one host.
- **`models keys set|remove <provider>` exists twice.**
  - `src/cli/messenger/models-command.ts:187-230` serves tg and max (`tg personal models keys`).
  - `src/cli/model-catalogue-command.ts:192-227` serves memo.
  - Both read the key from a hidden prompt or stdin, never from argv.
  - Both are `grantsAuthority`. The messenger one is listed as an MCP write
    (`src/mcp/__snapshots__/personal-catalogue.snap:218-219`).
  - **Neither refuses an agent's shell.** `consents set --yes` does (`enrichment-consents-command.ts:95-98`).
- **memo's readers use their own key code**, with `storage: "keyring"` and no env variable
  ([memo `src/sources/readers/keys.ts:13-27`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/sources/readers/keys.ts#L13-L27)).
  This is BUG-656, below.

### BUG-656: `sources readers` fails with no keyring

The id is not written down in any repository or journal searched (memo, cli-core, cli-testing,
wirecat-desktop, cli-docs, community). Its cause is clear in the code:

- memo's reader keys use `storage: "keyring"`
  ([`keys.ts:19`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/sources/readers/keys.ts#L19)).
- With that mode, cli-base 0.91.0 skips the file (`credentials.js:55`) and does not catch the keyring error
  (`:149-151`). Only `auto` warns and falls through to the file (`:152-160`).
- The API readers' `probe` reads the key, and `readers list` probes every reader in one `Promise.all`
  ([`suggest-command.ts:223-225`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/sources/suggest-command.ts#L223-L225)).
  So on a machine with no keyring the whole list fails, Claude Code and Codex rows included.
- Meanwhile `memo models keys set` uses `auto`. On that machine it writes the key to `credentials.json`,
  and the readers never look there.
- The two key paths also detect a moved run differently: `isMovedRun` in memo, `pathsAreOverridden` in cli-core
  (`keys.ts:29`). The standing rule is `isMovedRun` (cli-base 0.65.5, WC-SECR-24).

### Commands that take a provider or a base URL

- memo `sources suggest --provider <reader>` (readers only, owner only;
  [`suggest-command.ts:118`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/sources/suggest-command.ts#L118)).
- `models consents set <provider> --model <model> --base-url <url>` (`src/cli/enrichment-consents-command.ts:79-81`).
- tg/max `conversations … --analysis-provider <provider> --base-url <url>`
  (`src/cli/messenger/conversations-command.ts:66,69`).
- tg/max `conversations embed --embedding-provider <provider> --base-url <url>` (`conversations-command.ts:614,620`).
- `config set models.<purpose>.provider|model|base_url` in every CLI (`src/cli/settings.ts:896`).

### Who can change the endpoint today

- **`config set models.<purpose>.base_url` is not guarded.** It is checked against the owner-only list
  (`refuseGuardedKey`, `src/cli/config-command.ts:378-400`), and no caller in cli-core puts a `models.*` key on
  that list. An agent in a terminal can therefore point a purpose at any host.
- **A custom URL needs no key** (`analysis-choice.ts:43`), so nothing stops the text from being sent.
- **What protects the key is the host binding.** A stored key goes only to the host it was saved under.
- **cli-core says honestly that these guards stop mistakes, not attacks.** An agent can drop its markers
  (`config-command.ts:154`).

### Every job a model or agent does today

| # | Job | Command | Today | Can a third-party model do it? |
|---|---|---|---|---|
| 1 | Read a source for facts | memo `sources suggest` | Agent (`claude-code`, `codex`) or API reader (`ollama`, `openai`, `anthropic`), chosen by `sources readers set` ([`readers/index.ts:9`](https://github.com/WireCatLabs/cli-memo/blob/2ad55877a69611c88dc2d0d413d0c2aaf93296c2/src/sources/readers/index.ts#L9)) | **Yes.** It is the main target |
| 2 | Write-time enrichment | `memo sync` → `enrichRecords`, purpose `enrichment` (`src/services/enrichment.ts:208-228`) | API only, after consent | **Yes**, already |
| 3 | Answer analysis | memo `answers create --analyze` | API from env; without `--analyze` it hands an evidence bundle to the owner's agent | **Yes** |
| 4 | Link a chat to people and projects | tg/max `conversations … --analyze` (`src/cli/messenger/conversations-command.ts:94`), purpose `analysis` | Agent skill, or API when `models.analysis.provider` is set (`analysis-choice.ts:20-31`) | **Yes** |
| 5 | AI reply templates | auto-replies, purpose `replies` (`src/replies/rendering.ts:27-55`) | API only, with reply consent | **Yes** |
| 6 | OCR of attachments | purpose `ocr` (`src/attachments/gateway-ocr.ts:28-57`) | API only | **Yes**, if the model reads images |
| 7 | Memory proposals from a document | purpose `memories` (`src/services/documents/extraction.ts:18`, via `extractDocumentMemories`, `proposals.ts:22-26`, exported from `src/documents/index.ts:28`) | API only. The caller passes its own `complete`, and no caller was found in memo | **Yes** |
| 8 | Voice transcription | `messages transcribe` (`src/speech/transcribe.ts:94`) | Local model, or OpenAI audio with the `openai` key | **No.** It is an audio model, out of scope |
| 9 | Remote embeddings | `src/embeddings/remote.ts` | OpenAI `/embeddings`, not wired in memo | **No.** Out of scope |
| 10 | Scheduled agents (mail triage, morning digest), `digest backfill` | `memo schedule agent … claude\|codex` | Agent CLIs only | **No.** They need a tool loop that runs memo commands |
| 11 | MCP, skills, Desktop's "Fix with agent" | `memo mcp serve`; Desktop [`agent_run.rs:27-40`](https://github.com/WireCatLabs/wirecat-desktop/blob/14403716f619e10c2868da9a13a47e4457883716/src-tauri/src/agent_run.rs#L27-L40) | The owner's agent | **No.** The agent is the client |

`src/analysis/anthropic.ts:10` calls the Anthropic adapter directly, past the gateway, but nothing in `src` imports
it. It looks unused, and C4 deletes it or routes it through the gateway.

Jobs 1–7 can use the new setting. Jobs 10–11 stay with agents. Running a tool loop on an API model is a separate
project, not this plan.

### Desktop today

- **Settings → "Reading for facts".** It lists memo's readers and picks one
  ([`ReadersSetting.tsx:82-144`](https://github.com/WireCatLabs/wirecat-desktop/blob/14403716f619e10c2868da9a13a47e4457883716/src/features/settings/ReadersSetting.tsx#L82-L144)).
- **The key form** offers only `openai` and `anthropic`
  ([`:17`](https://github.com/WireCatLabs/wirecat-desktop/blob/14403716f619e10c2868da9a13a47e4457883716/src/features/settings/ReadersSetting.tsx#L17)).
  It sends the key to `models keys set` on stdin
  ([`memory_add.rs:418-421`](https://github.com/WireCatLabs/wirecat-desktop/blob/14403716f619e10c2868da9a13a47e4457883716/src-tauri/src/memory_add.rs#L418-L421)).
- **There is no model picker.** Choosing an API reader with no model refuses with "WireCat cannot choose one yet"
  ([`memory_add.rs:388-393`](https://github.com/WireCatLabs/wirecat-desktop/blob/14403716f619e10c2868da9a13a47e4457883716/src-tauri/src/memory_add.rs#L388-L393)).
- **Platform.** Desktop is Tauri 2 and is built for Linux AppImage, universal macOS and Windows NSIS
  (`.github/workflows/release.yml:107-122` there).
- **Texts.** They live per feature in `messages-*.ts` files as `en`, `ru: typeof en` and `es: typeof en`.

## Provider APIs, from their docs

Read 2026-11-09. Each line comes from the page linked. Where the docs disagree or say nothing, the line says
so. Nothing here was tried against a live API.

| | Anthropic | OpenAI | OpenRouter | Ollama (local) | LM Studio |
|---|---|---|---|---|---|
| Base URL | `https://api.anthropic.com` | `https://api.openai.com/v1` | `https://openrouter.ai/api/v1` | `http://localhost:11434`; OpenAI-compatible under `/v1` | `http://localhost:1234/v1` in the examples. The default port is not stated |
| Chat call | `POST /v1/messages` | `POST /chat/completions` | `POST /chat/completions` (OpenAI shape) | `POST /api/chat`, or `POST /v1/chat/completions` | `POST /v1/chat/completions` |
| Auth | `x-api-key`, called "legacy fallback, still supported", or `Authorization: Bearer` | `Authorization: Bearer` | `Authorization: Bearer` | None locally. Cloud `https://ollama.com` takes `Bearer` | None by default |
| Text | `content[].text` | `choices[0].message.content` | the same; a 200 can carry only `error` | `message.content`; `/v1` is the OpenAI shape | OpenAI shape (subpages not read) |
| Bad key | 401 `authentication_error` | 401 | 401 | not listed | not stated |
| No credit | 402 `billing_error` | **429** `insufficient_quota`-type codes (`credit_balance_exhausted`), sharing 429 with rate limits | 402; a spent per-key limit is 402 or 403, and the page contradicts itself | — | — |
| Unknown model | generic 404 `not_found_error` | generic 404 | 404 | 404 "model doesn't exist" | not stated |
| Error body | `{type:"error", error:{type, message}}` | `{error:{type, code, param, message}}` | `{error:{code, message, metadata}}` | `{error:"<string>"}` | not stated |
| Models list | `GET /v1/models` | `GET /v1/models` | `GET /api/v1/models`; key info at `GET /api/v1/key` | `GET /api/tags`, `GET /v1/models` | `GET /v1/models` |

Sources:

- [Anthropic API overview](https://platform.claude.com/docs/en/api/overview),
  [Messages](https://platform.claude.com/docs/en/api/messages),
  [errors](https://platform.claude.com/docs/en/api/errors),
  [models list](https://platform.claude.com/docs/en/api/models-list),
  [OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk).
  - The OpenAI-compatible layer is "not considered a long-term or production-ready solution", so the
    Anthropic provider keeps the native adapter.
  - The overview marks `anthropic-version` as required. The Messages page marks it optional. The SDK sends it
    either way.
- [OpenAI API reference overview](https://developers.openai.com/api/reference/overview),
  [error codes](https://developers.openai.com/api/docs/guides/error-codes),
  [openai-openapi](https://github.com/openai/openai-openapi). The `platform.openai.com` reference pages refuse
  automated reads (403).
- [OpenRouter quickstart](https://openrouter.ai/docs/quickstart),
  [API overview](https://openrouter.ai/docs/api-reference/overview),
  [authentication](https://openrouter.ai/docs/api-reference/authentication),
  [errors](https://openrouter.ai/docs/api-reference/errors),
  [limits and key info](https://openrouter.ai/docs/api_reference/limits).
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md),
  [OpenAI compatibility](https://docs.ollama.com/openai),
  [authentication](https://docs.ollama.com/api/authentication),
  [errors](https://docs.ollama.com/api/errors).
- [LM Studio OpenAI-compatible endpoints](https://lmstudio.ai/docs/app/api/endpoints/openai),
  [authentication](https://lmstudio.ai/docs/developer/core/authentication).

What follows for the design:

- **OpenRouter, Together, LM Studio and Ollama's `/v1` all speak the OpenAI chat shape.** The existing `openai`
  adapter covers them with a base URL. **No new adapter is needed**, Ollama included.
- **"No credit" cannot be read from the status alone.** It is 402 on Anthropic and OpenRouter, but 429 with an
  error code on OpenAI. The check has to read the error code as well as the status.
- **No page says whether a models-list call validates the key or the model.** So the Check uses a tiny
  completion instead (see [the Check](#5-the-check)).

## The design

### 1. One setting, in the shared config

A new section `ai` in the shared file the CLIs already read, `~/.config/WireCat/config.json`. It is next to
`enrichment`, written by `writeSharedSection`:

```json
"ai": {
  "provider": "openai",
  "base_url": "https://openrouter.ai/api/v1",
  "model": "openai/gpt-4o-mini"
}
```

- **`provider`** is one of the following.
  - `anthropic` uses the native adapter. Its default `base_url` is `https://api.anthropic.com`.
  - `openai` means "OpenAI or compatible" and uses the `openai` adapter. Its default `base_url` is
    `https://api.openai.com/v1`. Any other `base_url` makes it OpenRouter, Together, LM Studio and the like.
  - `ollama` (beta) is a preset of the `openai` adapter. Its `base_url` defaults to `http://127.0.0.1:11434/v1`,
    it sends no key, and the address must be loopback (see question 3).
- **`model`** is free text, 1–200 characters, as `models.<purpose>.model` is today. A provider's list fills a
  picker, but any name is accepted.
- **`base_url`** is optional. When it is absent, the provider's default applies.

**How the setting is resolved.** The shared `ai` section becomes the **lowest layer of `models.default`** in
`resolveModelSettings` (`src/models/settings.ts:51-62`), for every purpose except `analysis` (see the gate table
below). That gives this order:

1. `<PREFIX>_MODELS_<PURPOSE>_*` env, then the CLI's `models.<purpose>`.
2. `<PREFIX>_MODELS_DEFAULT_*` env, then the CLI's `models.default`.
3. The shared `ai` section.

So nothing that works today changes. Per-purpose settings stay the expert override, and `config show models`
reports the shared file as the source. No second system is added. The existing `models.*` system gains a shared
bottom layer.

**This is not consent.** Choosing a model never turns on a job that sends the owner's data out. This needs care,
because the `ai` layer feeds `models.default`, and so every purpose that falls back to it. Each purpose
therefore keeps a gate of its own that does not depend on a provider being set:

| Purpose | Gate today | With `ai` set |
|---|---|---|
| `analysis` (tg/max chat linking) | none but "a provider is set": `analysisChoice` treats an unset provider as the agent (`analysis-choice.ts:20-31`) | **Would open by itself.** So the shared layer does not feed `analysis`. Chat linking uses `ai` only when the owner's per-job choice says so (§2), stored as `jobs.analysis: "ai"` in the `ai` section |
| `replies` | reply consent, bound to `provider:base_url` (`src/replies/consents.ts:25-29`, `rendering.ts:33-37`) | stays closed until consent. A changed origin fails closed |
| `ocr` | an explicit OCR request, `enabled` (`gateway-ocr.ts:27`) | unchanged |
| `memories` | the caller passes its own `complete` (`proposals.ts:22`) | unchanged; the caller decides |
| `enrichment` | `consented_at` (below) | consent bound to origin and model |
| memo `sources` | the reader choice, owner only | `ai-model` is used only when chosen (§2) |

- Enrichment keeps its consent. `models consents set` with no provider uses the `ai` setting.
  - The consent records the **origin and model** it agreed to.
  - If the `ai` setting later points elsewhere, enrichment stops with `enrichment.endpoint-changed` until the
    owner consents again.
  - This replaces the provider, model and base URL kept in the `enrichment` section (`enrichment-setting.ts:17-28`).
    Only `consented_at` and the origin and model stay there.
- Replies keep their reply consent (`src/replies/consents.ts`).
- Analysis keeps its read-only and remote checks (`conversations-command.ts:95`).

No store migration is needed: this changes config and keyring only, and takes no migration number.

### 2. Which jobs it switches: one global choice, per-job only where both exist

**Recommended: one global model, plus a per-job "agent or model" choice only for the jobs that have both.**

- **Jobs that only an API can do** (2, 5, 6, 7) simply use the `ai` setting once their own consent is given.
  There is nothing to switch.
- **Jobs that only an agent can do** (10, 11) are untouched.
- **Jobs that can use either** are reading sources (1), answer analysis (3) and chat linking (4). Each keeps
  its own choice, so the owner can let Claude Code read a long PDF and let the model link chats.
  - memo's reader list becomes `claude-code`, `codex` and `ai-model`.
  - `ai-model` reads with the shared setting and needs no `--model`.
  - Chat linking (4) and answer analysis (3) store their choice in the `ai` section's `jobs` map (`"agent"` or
    `"ai"`, default `"agent"`), which `analysisChoice` and memo's `answers` read. That keeps today's behaviour for
    an owner who never touches it.
  - The old ids `openai`, `anthropic` and `ollama` stay accepted as aliases of `ai-model` for one release. The
    `sources: {reader, model}` they wrote is read once and reported by `memo doctor`.
- **Desktop shows one switch**, "Use my AI model instead of an agent". It sets all three jobs at once. The CLI
  keeps the per-job commands.

A single global switch would look simpler, but it would make "reading a 300-page PDF with Claude Code"
impossible while chats go to a cheap model. That is the main reason for the recommendation. It is open
question 1.

### 3. Keys

- **One shared keyring service.**
  - Service `WireCat`, the name the shared config already uses (`shared-config.ts:23`).
  - Account `ai:<origin>`, for example `ai:https://api.anthropic.com` or `ai:https://openrouter.ai`.
  - The origin is scheme, host and port. It replaces the host-only name of `endpointKeyName`.
  - Every CLI and Desktop then find the same key (open question 2).
- **Read order, fixed:**
  1. The shared entry for the target's origin.
  2. The legacy per-CLI `embeddings:<openai|anthropic|host>` entry, read only. `openai` and `anthropic` map to
     their official origins. A legacy host name maps only to `https://<host>` (that host and port), never to
     `http://`, because the old name carries no scheme.
  3. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (and the `<PREFIX>_` forms). These count only for the provider's
     official origin, as today.
  4. The 0600 file.
- **Storage on each OS** is cli-base `Credentials` in `auto` mode, which uses `@napi-rs/keyring`:
  - macOS: Keychain.
  - Windows: Credential Manager.
  - Linux: Secret Service.
- **The file fallback.** When the keyring call fails, cli-base warns once on stderr and uses
  `<WireCat config>/credentials.json`, written with mode 0600 (cli-base `credentials.js:147`).
  - The answer says where the key went (`"stored": "keyring" | "file"`), so Desktop can tell the owner.
  - On Windows the mode bits mean little, and the file relies on the profile folder's permissions. The keyring
    is nearly always present there.
- **A moved run** uses `isMovedRun`, per the standing keyring rule. It reads the shared entry and never writes,
  replaces or deletes it.
- **BUG-656 is fixed by deletion.** memo's `src/sources/readers/keys.ts` goes. The readers call cli-core's key
  store, so they get the file fallback, and a probe that cannot read a key reports `key: false` for that reader
  instead of failing the list.

### 4. CLI commands

Mounted by one cli-core function into memo's root `models` group and into tg/max's `personal models`. The
two `models keys` implementations become one. `models set` already means "choose the embedding model"
(`models-command.ts:305`), so the new group is **`models ai`**:

| Command | Who | Answer under `--json` |
|---|---|---|
| `models ai show` | anyone, MCP read | `{provider, model, base_url, origin, beta, key: {stored, source}, from, used_by: [{job, uses: "ai"\|"agent"\|"own setting"\|"off"}]}`; `key.source` is `keyring`/`file`/`environment`/`null` and never the key |
| `models ai list` | anyone | `{items: [{id, title?}], has_more: false}` from the provider's models list; `items: []` with `reason` when the provider does not answer. Desktop fills its picker from it |
| `models ai set <anthropic\|openai\|ollama> --model <m> [--base-url <url>] [--secret-stdin]` | owner only | `{provider, model, base_url, origin, beta, key: {stored, source}, changed}`. `--secret-stdin` reads the key from stdin and saves it **under this call's origin**, so a key and its address are saved together |
| `models ai check` | owner only (it spends a few tokens) | `{ok, reason, provider, model, origin, ms}`, see below |
| `models ai unset` | owner only | `{changed, key_kept: true}`; the key stays until `models ai remove` |
| `models keys set\|remove <name>` | owner only | unchanged shape. `openai`/`anthropic` map to the official origins. A bare host means `https://<host>`. It writes the shared entry |

"Owner only" means four things:

- The command is refused when `agentOf(env)` finds an agent, as `consents set --yes` already is.
- It is left out of the MCP catalogue.
- It keeps `grantsAuthority`.
- `config set` adds `models.*.provider` and `models.*.base_url` to the settings an agent may not change.

### 5. The Check

`models ai check` sends one request through `modelGateway` with:

- the system text "Reply with the word OK.";
- `maxTokens` 512, because reasoning models spend tokens before they answer;
- a reply that is accepted whatever its `finish_reason`.

**What it costs.** It proves the key, the model and the credit in one call. For the cheap models priced in
`enrichment-setting.ts:58-69` that is far under one cent. An expensive model can cost about a cent. A models-list call would be free, but the docs do not
say that it checks the key, and it never checks the model or the credit (open question 4).

The gateway learns to tell these apart, which also improves every other job's errors:

| Reason | Detected by | Text (en) |
|---|---|---|
| `ai.ok` | a text answer | "Works: {model} answered in {ms} ms." |
| `ai.key-missing` | no key for an origin that needs one | "No API key saved for {host}." |
| `ai.key-rejected` | 401, 403 | "{host} refused the key. Check that it is copied whole and not revoked." |
| `ai.no-credit` | 402 (Anthropic `billing_error`, OpenRouter); OpenAI 429 `credit_balance_exhausted` | "The account at {host} has no credit left." |
| `ai.spend-limit` | OpenAI 429 `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`; Anthropic 400 for a spend limit you set; OpenRouter 403 key limit | "A spending limit at {host} is reached. Raise it in your account there." |
| `ai.rate-limited` | any other 429 | "{host} is busy or the limit is reached. Try again in a minute." |
| `ai.model-unknown` | 404, Ollama `{error}` with 404 | "{host} has no model called {model}." For Ollama: "Run `ollama pull {model}` first." |
| `ai.unreachable` | network error, refused connection | "Cannot reach {host}." For Ollama: "Ollama is not running. Start it, then check again." |
| `ai.bad-answer` | 200 with an `error` body (OpenRouter), or no text | "{host} answered, but not with text. The model may not support chat." |
| `ai.provider-error` | 5xx, Anthropic 529 `overloaded_error`, OpenRouter 502/503 | "{host} has a problem on its side. Try again later." |
| `ai.address-refused` | the endpoint rule in §6 | "This address is not allowed: use https, or http only on this computer." |
| `ai.failed` | anything else, a 400 included | "{host} refused the request ({status})." |

Anthropic also documents a 429 for a tier spend cap with the same `rate_limit_error` type. It cannot be told apart
from a rate limit, so it gets the rate-limit text.

The provider's own error message is never shown or stored. Only the status and the error *code*, matched
against the list above, are read. This keeps the gateway's current rule (`src/models/index.ts:82-92`), and it
keeps any echo of the key in a provider message off the screen.

### 6. Security

1. **Key handling.**
   - The key never goes into argv. It enters only through a hidden prompt or stdin; Desktop already uses stdin.
   - It is never printed. Answers carry `stored` and `source`, never the key or a part of it.
   - It never goes into a log. The gateway's fixed messages stay, and the Anthropic SDK keeps
     `logLevel: "off"`.
   - A test captures stdout, stderr and the run log of `set`, `check` and a failed call, and asserts that the
     key appears in none of them. memo's commit `b95f418` already does this for files.
2. **https only, except loopback.**
   - `endpoint()` (`src/models/endpoint.ts`) accepts `https:` always. It accepts `http:` only when the hostname
     is exactly `localhost`, in `127.0.0.0/8`, or `[::1]`.
   - Tests cover `http://localhost.evil.com`, `http://127.0.0.1.nip.io` and `http://192.168.1.5:11434`, all
     refused.
   - This tightens a public function. A saved `http://` LAN URL will then fail to load with
     `configuration_error` (`settings.ts:70-72`), so the changelog entry goes under "Changed — may break callers"
     and says what to do.
3. **A key goes only to the origin it was saved with.**
   - Keys are looked up by the target's origin (§3), so changing the base URL can never send a stored key
     elsewhere. The new origin simply has no key.
   - `redirect: "error"` on both adapters stays (`openai.ts:48`, `anthropic.ts:19`). It stops a server from
     bouncing the request, and the key, to another host.
4. **Agents cannot change the endpoint or the key.**
   - This is the owner-only rule in §4, for `models ai set|unset|remove|revoke|check`, `models keys set|remove` and
     `config set models.*.provider|base_url`. Desktop passes `--from-app`, as it does for readers.
   - **The honest limit:** a process that sets `<PREFIX>_MODELS_*` env for its own run still changes that
     run's target, as `config-command.ts:154` already admits.
   - What it cannot do is reach a stored key. The key is bound to the origin, and an env-chosen origin finds
     no key.
   - Its own run can still send text to its own host with no key. That is the same as the agent sending the
     text itself, which it can already do.
5. **The read-only lock** (`<PREFIX>_READ_ONLY`) still refuses any remote call. `check` counts as one.

### 7. Desktop: Settings → "AI model"

**A new section above "Reading for facts"**, in `src/features/settings/AiModelSetting.tsx`, with
`messages-ai-model.ts`. It holds:

- **Provider radio:** Anthropic · OpenAI or compatible · Ollama (beta, this computer).
- **Address (base URL):** shown for "OpenAI or compatible" under "Advanced". For Ollama it is prefilled and
  read-only.
- **API key:** a `SecretField`. It is sent with `models ai set … --secret-stdin`, and the field is cleared before
  sending, as the readers' key form does today.
- **Model:** a combo box filled by `models ai list`, which also accepts typed text.
- **"Check" button,** which shows the reason text from §5.
- **"Use my AI model instead of an agent" switch** (§2).

The "Reading for facts" list drops its own key form and provider list
([`ReadersSetting.tsx:17, 146-224`](https://github.com/WireCatLabs/wirecat-desktop/blob/14403716f619e10c2868da9a13a47e4457883716/src/features/settings/ReadersSetting.tsx#L146-L224)).
Its `ai-model` row says "Your AI model: {provider} {model}".

Texts. No semicolons and no long dashes, per the WireCat voice:

| Key | en | ru | es |
|---|---|---|---|
| `heading` | AI model | Модель ИИ | Modelo de IA |
| `intro` | WireCat can use a model from an AI company instead of your agent (Claude Code, Codex) for reading sources, linking chats and other jobs. You pay the company for what it reads. | WireCat может использовать модель ИИ-компании вместо вашего агента (Claude Code, Codex): для чтения источников, связывания чатов и других задач. Вы платите компании за прочитанное. | WireCat puede usar un modelo de una empresa de IA en lugar de tu agente (Claude Code, Codex) para leer fuentes, enlazar chats y otras tareas. Pagas a la empresa por lo que lee. |
| `providerAnthropic` | Anthropic (Claude) | Anthropic (Claude) | Anthropic (Claude) |
| `providerOpenai` | OpenAI or compatible | OpenAI или совместимый | OpenAI o compatible |
| `providerOllama` | Ollama on this computer (beta) | Ollama на этом компьютере (бета) | Ollama en este ordenador (beta) |
| `baseUrl` | Address (base URL) | Адрес (base URL) | Dirección (base URL) |
| `baseUrlHelp` | The address WireCat sends requests to. Leave it empty for OpenAI itself. To use another service that works like OpenAI, paste its address. For OpenRouter, which gives one key for models from many companies, it is https://openrouter.ai/api/v1. Then type the model as OpenRouter names it, for example openai/gpt-4o-mini. Your key is sent only to this address. | Адрес, на который WireCat отправляет запросы. Для самого OpenAI оставьте поле пустым. Чтобы подключить другой сервис, который работает как OpenAI, вставьте его адрес. Для OpenRouter (один ключ для моделей многих компаний) это https://openrouter.ai/api/v1. Модель укажите так, как её называет OpenRouter, например openai/gpt-4o-mini. Ключ уходит только на этот адрес. | La dirección a la que WireCat envía las peticiones. Déjala vacía para OpenAI. Para otro servicio que funciona como OpenAI, pega su dirección. Para OpenRouter, que da una sola clave para modelos de muchas empresas, es https://openrouter.ai/api/v1. Escribe el modelo como lo llama OpenRouter, por ejemplo openai/gpt-4o-mini. Tu clave solo se envía a esta dirección. |
| `baseUrlRule` | Use an https address. http works only for a server on this computer, such as LM Studio or Ollama. | Нужен адрес с https. http подходит только для сервера на этом компьютере, например LM Studio или Ollama. | Usa una dirección https. http solo funciona con un servidor en este ordenador, como LM Studio u Ollama. |
| `key` | API key | API-ключ | Clave de API |
| `keyHelp` | Kept in your system's password store and never shown again. | Хранится в системном хранилище паролей и больше не показывается. | Se guarda en el almacén de contraseñas del sistema y no se vuelve a mostrar. |
| `keyInFile` | This computer has no password store, so the key is kept in a file only your user can read. | На этом компьютере нет хранилища паролей, поэтому ключ хранится в файле, который может прочитать только ваш пользователь. | Este ordenador no tiene almacén de contraseñas, así que la clave se guarda en un archivo que solo tu usuario puede leer. |
| `model` | Model | Модель | Modelo |
| `ollamaBeta` | Beta. Ollama must be running, and the model pulled with ollama pull. Nothing leaves this computer. | Бета. Ollama должна быть запущена, а модель скачана командой ollama pull. Ничего не покидает этот компьютер. | Beta. Ollama debe estar en marcha y el modelo descargado con ollama pull. Nada sale de este ordenador. |
| `check` | Check | Проверить | Comprobar |
| `checkCost` | Sends one short request, billed by your provider. Usually under one cent. | Отправляет один короткий запрос, его оплачиваете вы у провайдера. Обычно меньше цента. | Envía una petición corta que cobra tu proveedor. Suele costar menos de un céntimo. |
| `useInsteadOfAgent` | Use my AI model instead of an agent | Использовать мою модель вместо агента | Usar mi modelo en lugar de un agente |

The reason texts from §5 go into the same file in all three languages. They are keyed by reason id, in the
`"ai.key-rejected"` style that `messages-enrichment.ts` already uses.

## PRs, in order

Each PR has its own tests, and the tests use `memoryKeyring()` and a fake `fetch`. Sizes count changed lines,
tests included. The cli-core PRs merge as they go green, and one release carries them all.

| # | Repo | PR | Tests | Size |
|---|---|---|---|---|
| C1 | cli-core | **Endpoint and key binding.** `endpoint()` accepts https, or http on loopback only. The key name becomes the origin, and old host names are read only when they map to the same origin. `models keys set\|remove` refuse an agent's shell and leave MCP. The changelog gets "Changed — may break callers" | the URL table (loopback lookalikes refused). A key saved for `https://a` is not sent to `http://a` or `https://b`. An agent refused | S, ~250 |
| C2 | cli-core | **Shared `ai` section and shared key service.** Schema, read and write, the bottom layer of `models.default`, the Ollama preset, the `WireCat` keyring service with legacy read, and `isMovedRun` | resolution order (env > CLI > shared). A moved run never writes the shared entry. File fallback when the keyring throws | M, ~350 |
| C3 | cli-core | **`models ai show\|list\|set\|unset`.** One mount for memo and tg/max, the two `models keys` merged, owner-only guards, and `config set models.*.provider\|base_url` made owner-only | JSON shapes. `--secret-stdin` binds the key to the origin. No key in stdout, stderr or the log. The MCP catalogue snapshot | M, ~450 |
| C4 | cli-core | **`models ai check` and gateway reasons.** The OpenAI adapter keeps the status and error code. The reason table of §5. The unused `src/analysis/anthropic.ts` goes through the gateway or is removed | one fixture per row of the reason table, per provider shape: Anthropic, OpenAI, OpenRouter 200-with-error, Ollama string error | M, ~300 |
| C5 | cli-core | **Enrichment follows `ai`.** Consent keeps the origin and model, and a change pauses it | a changed origin stops sends until consent is given again | S, ~200 |
| — | cli-core | one release with C1–C5 | — | — |
| M1 | memo | **Fix BUG-656.** Bump cli-core, delete `src/sources/readers/keys.ts`, use cli-core keys, and make a key probe failure per reader | `readers list` with a keyring that throws lists every reader. A key in `credentials.json` is found | S, ~120 |
| M2 | memo | **`ai-model` reader; `answers --analyze` uses `ai`.** `openai`/`anthropic`/`ollama` become aliases. The native Ollama reader goes. `MEMO_MODEL_API_KEY` stays as an override for one release. `memo doctor` reports the old `sources` choice. Docs: `security.md`, `sources.md`, `troubleshooting.md` | aliases. Suggest through `ai-model` with a fake fetch. Doctor output | M, ~350 |
| D1 | Desktop | **Rust bridge.** `ai_show`, `ai_list`, `ai_set` (key on stdin), `ai_check`, `ai_off`, and the switch from §2 | argv builders, as in `memory_add.rs`'s tests. The key is never in argv | M, ~300 |
| D2 | Desktop | **Settings "AI model" section and texts in en/ru/es.** The readers row for `ai-model`. The old key form and `PROVIDERS` go | component tests per provider. Every reason has a text in all three languages | M, ~450 |

tg-cli and max-cli only bump cli-core: they get `personal models ai` from C3.

## What was not checked

- **No live call to any provider.** Status codes come from docs, and the docs disagree in places:
  - Anthropic's `anthropic-version`, required or optional;
  - OpenRouter's 402 or 403 for a spent key limit.

  C4's fixtures should be compared once against real answers, with the owner's own test key, run by the owner.
- **LM Studio's default port** is assumed from the doc's examples (1234).
- **Ollama's `/v1` with the `openai` adapter** has not been tried. The adapter requires `finish_reason: "stop"`
  and `usage.total_tokens` (`openai.ts:57-60`), and the Ollama page does not say that `/v1` returns both.
- **Who calls `extractDocumentMemories`** outside cli-core was not traced past memo, where nothing does.
- **OpenRouter's model id format** in the example texts (`openai/gpt-4o-mini`) was not checked on a docs page.
  D2 confirms it against OpenRouter's model list before the texts ship.
- `pnpm docs:check` and the Markdown lint were not run on this file; the worktree has no `node_modules`.

## Open questions for the owner

1. **Should the choice between an agent and the model be one global switch, or per job?**
   - Options: **A** one global switch. **B** one global model, plus "agent or model" per job for the three
     jobs that can use either: reading sources, answer analysis and chat linking. Desktop shows one switch that
     sets all three.
   - Recommended: **B**. The owner can keep Claude Code for long documents and a cheap model for chats. In
     Desktop it still looks like one switch.
2. **Should one key serve every WireCat tool, against the standing rule "one keyring entry per app and
   account"?**
   - Options: **A** one shared entry under service `WireCat`, as in §3. **B** each CLI keeps its own entry,
     and Desktop writes the key into every installed CLI.
   - Recommended: **A**. One setting with N copies of the key drifts: one gets revoked and the others still
     work. It needs a line added to the keyring rule.
3. **Should http be refused for a model on another computer in the home network (LAN Ollama or LM Studio,
   `http://192.168.x.x`)?**
   - Options: **A** refuse: https everywhere, http only on this computer. **B** allow http on private
     addresses, with a warning.
   - Recommended: **A**. The text and any key would cross the network unencrypted. A LAN server can sit behind
     https (Caddy, Tailscale). memo's Ollama reader is loopback-only for this reason today.
4. **May "Check" spend a fraction of a cent on a real request?**
   - Options: **A** a tiny completion, which proves the key, the model and the credit. **B** a free models-list
     call, which proves only that the address answers. The docs do not say it checks the key.
   - Recommended: **A**, with the cost stated next to the button.
