# AI providers for search

Search uses the local embedding model chosen with `models set`, EmbeddingGemma until one is chosen (`e5-small` stays available; see
[Choosing the local embedding model](#choosing-the-local-embedding-model)). Conversation analysis defaults to your own agent using the linking skill; ordinary `conversations links rebuild` uses stored messages and local rules. Configuration alone never starts analysis.

These shared SDK settings/options reach MAX and Telegram at their next cli-core dependency bump.

All text generation uses the `./models` gateway. Set `models.<purpose>.provider`, `.model`, and
`.base_url` for `analysis`, `replies`, or another caller's purpose. Each field falls back to
`models.default`; `provider: off` explicitly disables a purpose. With no provider configured,
the gateway refuses without resolving a key or making a request. A model id is required when
a provider is enabled. Configuration alone never authorizes data transfer.

Conversation analysis reads `models.analysis`: with its provider unset or `off`, your agent links the chat.
`config set models.analysis.provider openai` sets one field; `config unset models.analysis.provider`
removes it. The whole `models` object can also be set as JSON. `config show` reports effective
values and the source of each field. Environment overrides use names such as
`MAX_MODELS_ANALYSIS_PROVIDER`, `MAX_MODELS_REPLIES_MODEL`, and `MAX_MODELS_DEFAULT_BASE_URL`.

The gateway takes `purpose`, optional `system`, `prompt`, optional untrusted `data`, `maxTokens`
and optional provider-specific `options`. The gateway sends data separately and instructs the
model to treat it as content rather than instructions. Reply blocks may use template metadata at the owner’s insertion points; they must
not copy the incoming message into the reply. SDK callers that require exact supporting evidence
set `allowSourceQuotes: true` on the request. This permits supporting quotes while keeping the
source in a separate untrusted-data message; it does not authorize following its instructions.
Other non-OCR requests keep the no-copy policy, including ordinary replies.
Options are validated by the selected adapter: unknown keys and wrong types
are refused before any request. OpenAI supports temperature, top_p, presence_penalty,
frequency_penalty, seed, stop, and response_format (text or json_object); Anthropic supports
stop_sequences only, since its API refuses temperature, top_p and top_k. Callers cannot override the model, messages,
credentials or token bound through options. The caller supplies a key resolver and a consent
check; consent is checked before keys or network calls. Tests inject fake adapters and fetch.
Gateway callers may supply an AbortSignal, combined with each adapter's request timeout.
Custom hosts literally named `openai` or `anthropic` use key names `endpoint:openai` and
`endpoint:anthropic`; this keeps their credentials separate from public provider keys.
Conversation analysis and AI reply previews register it with the CLI deadline; serve cancels reply
requests on shutdown, so a timed-out one-shot does not leave an HTTP request holding it open.

| Profile setting | Values / default |
|---|---|
| `embedding_provider` | `local` (default), `openai` |
| `embedding_model` | Local model ID, or the provider's embedding model; unset uses the `models set` choice locally and text-embedding-3-small at OpenAI |
| `embedding_base_url` | OpenAI-compatible API base, including `/v1` where required |
| `embedding_dims` | Positive vector dimension; required for a custom embedding endpoint |
| `models.analysis.provider` | unset or `off` (your agent links; the default), `openai`, `anthropic` |
| `models.analysis.model` | Explicit model ID from your provider; required for configured analysis |
| `models.analysis.base_url` | OpenAI-compatible API base, or Anthropic API root (without `/v1`) |

`config set` validates values, and `config show` reports their source. Profile and kind-specific configuration use the existing settings layers. Prefixed environment variables such as `MAX_EMBEDDING_PROVIDER`, `MAX_EMBEDDING_MODEL`, `MAX_MODELS_ANALYSIS_PROVIDER`, `MAX_MODELS_ANALYSIS_MODEL` and corresponding `_BASE_URL` / `_DIMS` override files. Command options override settings. Changing `--analysis-provider`, `--embedding-provider` or `--base-url` to a different provider/endpoint starts a new provider choice; give that provider's model/dimensions rather than inheriting another provider's settings. `--embedding-provider local --model e5-small` selects local embeddings for one command.

```sh
max config set embedding_provider openai
max config set embedding_model text-embedding-3-small
max models keys set openai
max conversations embed --chat '<chat>' --yes

max config set models.analysis.provider anthropic
max config set models.analysis.model '<model from your provider>'
max models keys set anthropic
max conversations links rebuild --chat '<chat>' --analyze --max-tokens 100000 --yes
```

Keys go in the OS keyring or the existing protected credential file, never config or command arguments. Public OpenAI and Anthropic can use `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, or their prefixed forms. A custom base URL uses its exact host (including port) as the key name:

```sh
max config set models.analysis.provider openai
max config set models.analysis.base_url http://localhost:11434/v1
max config set models.analysis.model '<your installed Ollama model>'
# A remote compatible server that needs a key:
max models keys set '<endpoint host[:port]>'
```

Custom endpoints never inherit the public OpenAI/Anthropic key. URLs must be HTTPS without embedded credentials, query or fragment; plain HTTP only on this computer (`localhost`, `127.x.x.x`, `[::1]`), so neither the text nor the key crosses a network unencrypted. With `models.analysis`, `models.replies` and `models.ocr` not set (and not `off`), linking, reply drafts and attachment OCR use the AI model chosen with `memo models ai set`, with the key kept for its address; OCR through it to another computer needs that model's yes to pictures (`--allow-remote`). Anthropic is analysis only: [Anthropic offers no embedding model](https://platform.claude.com/docs/en/build-with-claude/embeddings). OpenAI-style analysis uses Chat Completions; custom servers use the compatible `max_tokens` field, while api.openai.com uses `max_completion_tokens`. [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) covers a subset of that API. Choose a model that returns JSON and token usage; there is no automatic provider fallback or retry.

**Chat text to a model outside this computer** follows one setting for every WireCat tool, `models chats`. A model on this computer (`localhost`, `127.x.x.x`, `[::1]`) is not outside: it needs no yes and no setting, for `conversations embed` and for `--analyze` alike.

| Value | What `conversations embed` and `conversations links rebuild --analyze` do |
|---|---|
| `allowed` | send without a yes, in a terminal and over MCP |
| `ask` (default) | ask in a terminal; elsewhere need `--yes`, which an agent may pass over MCP |
| `denied` | refuse, even with `--yes` and a remembered consent; the error names the owner's command |

Only the owner makes it less strict: `set` is no MCP tool, and an agent's run is refused unless it comes from WireCat Desktop (`--from-app`). An agent may make it stricter.

```sh
max models chats show
max models chats set allowed    # or ask, or denied
```

Under `ask`, before analysis sends its first batch, the CLI explains the endpoint/model, messages, characters, estimated message tokens, and run cap. Machine mode requires `--yes` for a new consent. A yes is remembered for **this account, native chat ID, provider and endpoint path**, across model changes at that endpoint, until revoked. A different chat/account/provider/endpoint requires another yes. Under `allowed` nothing is asked or remembered. `conversations embed` under `ask` asks for remote message batches on every run; configuring a provider does not waive it. Search with a remote embedding provider sends the query text to that endpoint; MCP search/related/status honor the profile's embedding choice. Bulk refresh stays local.

```sh
max conversations consents list --json
max conversations consents remove --chat '<chat>'
max conversations consents remove --consent-provider '<exact identity from the list>'
max conversations consents remove                     # every remembered analysis consent in this account
```

Revocation removes permission for future batches, including subsequent batches of a running analysis command; an already submitted request cannot be recalled. Local write permissions still apply to analysis, consent storage and revocation. No messenger messages are sent or marked read.

The runner reads the same shipped `link-conversations` skill as your agent, adds a JSON-only response instruction, and calls the existing `batches next` / `links add` logic. Answer messages must be requested by the batch; parents must be earlier messages inside its context. Duplicate IDs, incorrect model/skill, malformed JSON, out-of-range confidence or truncated output fail the entire current batch before links are stored. Previously completed batches remain stored. Successful batches are rebuilt into conversations; remaining work is resumable.

`--size` uses the existing batch bounds (10–200, default 50). `--max-tokens` defaults to 100000 and caps **reservations for both input and output across this run**. Before each request, the runner reserves UTF-8 bytes for the skill/batch plus protocol overhead and at most 4096 output tokens. It stops before a batch that cannot fit, returning `stopped: "budget"`, `remaining`, `tokens` (provider-reported usage) and `reservedTokens`. Reservations are conservative and are not recycled; a command may stop below its actual usage cap. This is a token bound, not a dollar-price quote. Truncated output and usage exceeding a reservation fail the batch. Provider errors contain no remote body, key or message text.

Anthropic uses the official TypeScript SDK and [Messages streaming](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript); the runner reads the final message and checks its stop reason. The OpenAI-compatible adapter checks the first choice's finish reason and reported token usage. Both adapters are tested with local fake servers; there are no real provider calls in the test suite.

Embedding endpoints must accept requests at the configured URL directly. Set `embedding_base_url` to
the API base serving `/embeddings`; configured gateways use normal HTTP redirect handling.

## Choosing the local embedding model

One choice serves every WireCat CLI on this machine: `models set <id>` writes `text_models.use` to the shared settings
file (`~/.config/WireCat/config.json`, or the one beside a store moved by `MESSAGING_STORE`). Every embed (sync of
notes, mail, events and messages) and every search by meaning then uses it. A CLI's own `embedding_model`, its
`<PREFIX>_EMBEDDING_MODEL` and a `--model` flag still win in that CLI; `models set` says so when one does.

With nothing chosen, the model is EmbeddingGemma (e5-small until November 2026). A machine that has e5-small and not
EmbeddingGemma keeps using e5-small, so its search by meaning never stops for a missing model. Once EmbeddingGemma is
downloaded, syncs embed with it, and search by meaning keeps reading e5-small's vectors until the store holds more of
EmbeddingGemma's; about 20 minutes of embedding for 10,000 chunks of 1,200 characters on an 8-thread laptop, done a
part per sync. EmbeddingGemma comes under the Gemma Terms of Use: its `NOTICE` lies beside its files, and
`models list --json` gives `licence` and `terms`. `--accept-terms` is no longer needed and is ignored.

| Id | Size | On disk | Licence | Speed (chunks a second, one session) |
|---|---|---|---|---|
| `embeddinggemma` (default) | medium | 218 MB | Gemma Terms of Use | about 5 |
| `e5-small` | small | 135 MB | MIT | about 31 |
| `e5-large` | large | 579 MB | MIT | about 4 |

`models set` refuses a model that is not downloaded and names the download. Vectors are kept per model (the
`embeddings` table's key is `local:<id>:<dims>`), so a switch deletes nothing and re-embeds nothing at once: it prints
how many chunks the new model still lacks and about how long the syncs take over them. Until they are done, search by
meaning reads only the new model's vectors and words find the rest. Switching back is instant.

`models set` asks nothing, in a terminal or over MCP: many MCP clients cannot answer a question, and a switch can be
undone. A profile that must not switch models denies `models.set`. `models add` still needs `mcp.authority` over
MCP, as every command that changes what a later run does.

`models add <id> --payload '<json>'` adds a model of your own from Hugging Face: `repository`, `revision`, `onnx`,
`externalData`, `dims`, `pooling` (`mean` or `sentence_embedding`), `prefix.query`, `prefix.passage`, `maxTokens`.
It is pinned to the commit the revision names, with each file's size and sha256, and kept in `text_models.custom`
of the same file in the same shape as the built-in models; `models download <id>` then downloads it, checks every
hash and embeds a word to check the vector length. A custom model's vector key carries its weights' hash, so an id
redefined as another model never reads the old vectors.

```sh
memo models download e5-large
memo models set e5-large
memo models add e5-base --payload '{"repository":"Xenova/multilingual-e5-base","onnx":"onnx/model_quantized.onnx","dims":768,"pooling":"mean","prefix":{"query":"query: ","passage":"passage: "}}'
```

## Enrichment: rewriting records for search (off by default)

Enrichment sends each note, document and email to a hosted model, which writes standalone facts (names in full,
dates made absolute) and two questions in other words. Search then finds the record by those words too: they go into
the stems and into a chunk of their own beside the record's, so a hit still cites the record. `--exact`, the trigrams
and the record's own chunks keep only its own text. On 10,444 synthetic records it lifted memo 0.131.55 on reworded
questions from 0.62 to 0.79 at @10, and cost first place on questions in the record's own words (0.54 to 0.48), for
about $0.49 with gpt-4o-mini ([cli-testing #322](https://github.com/WireCatLabs/cli-testing/pull/322)).

It is off until the owner says yes. One setting serves every WireCat CLI: the `enrichment` section of the shared
settings file (`provider`, `model`, optional `base_url`, `consented_at`).

```sh
memo models consents show --json                          # on or off, records, enriched, pending, cost estimate
memo models consents set openai --model gpt-4o-mini       # what would be sent and what it costs; changes nothing
memo models consents set openai --model gpt-4o-mini --yes # on
memo models consents revoke                               # off, and deletes what the model wrote
memo models keys set openai < key.txt                     # the key, from stdin or a hidden prompt
memo models keys remove openai
```

With it on, `embedNotes` and `embedMail` (every `sync` that embeds) first enrich up to 600 records that have no
enrichment of their current text, 20 to a request and four requests at once, then embed. A record is sent once per
text: an edit sends it again, a re-sync does not. A batch the model answers wrongly leaves its records for the next
sync; a rate limit, a refused key, an unreachable provider or a missing key stops the run. A run that sent records
and got none back is `failed`. A stopped or failed run carries `reason` and a `reason_id` from a fixed list
(`enrichment.no-key`, `key-rejected`, `unreachable`, `rate-limited`, `bad-replies`, `cancelled`, `error`). The records go as untrusted data, never as instructions; each
record adds at most five facts and three questions of at most 400 characters.

When the tool passes its identity (memo does), the key is read from its keyring entry `embeddings:<provider>`
(`models keys set openai`), then `<PREFIX>_OPENAI_API_KEY` / `OPENAI_API_KEY` (or the Anthropic ones),
then an entry of the tool's service named after the provider alone (`cli-memo` / `anthropic`). The consent text also
says that a question in the record's own words finds that record first a little less often.
An agent's shell cannot turn it on, and over MCP `models consents set` needs `mcp.authority`. Prices for the
estimate are known for `openai/gpt-4o-mini` and `anthropic/claude-haiku-5-5`; another model gets `usd: null`.

## Search harder: a hosted model reorders `search all` (off by default)

`searchAll` with `harder` (memo's `search all --harder`) sends the question and the first 30 merged hits to the
provider and model the owner chose: Anthropic (`api.anthropic.com`, `claude-haiku-5-5` unless he names another),
OpenAI (`api.openai.com`, `gpt-4o-mini`) or an OpenAI-compatible API at a base URL he gives (OpenRouter and the like),
where he must name the model. Each hit goes as its number, date, title and at most 400 characters of the excerpt
search already shows, as untrusted data; the model answers with the numbers of the hits that answer the question, best
first, and nothing else. Those come first, then the rest of the 30 in their plain order, then everything below. Only
the first page is reordered.

What gets sent, and when:

- **Nothing without `harder`.** A search that does not ask reads neither the consent nor the key.
- **Nothing without the owner's consent**: the `search_harder` section of the shared settings file (`provider`,
  `model`, optional `base_url`, `consented_at`), separate from enrichment's, because it sends other text at another
  time. When enrichment has a provider and this has none, `show` proposes enrichment's (`proposed_from:
  "enrichment"`); the consent is still given here, with `--yes`.
- **Nothing without a key** for a public API, found as enrichment finds it (`models keys set <provider>`, then
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and the tool's own variable, then the tool's entry named after the
  provider). An API at a base URL may need none.

```sh
memo models search-consents show --json            # allowed or not, provider, model, endpoint, whether the key is found
memo models search-consents set anthropic          # what a --harder search sends; changes nothing
memo models search-consents set anthropic --yes    # allowed; each search still has to ask with --harder
memo models search-consents set openai --yes       # gpt-4o-mini
memo models search-consents set openai --base-url https://openrouter.ai/api/v1 --model deepseek/deepseek-chat --yes
memo models search-consents revoke
memo models keys set anthropic < key.txt
```

The search waits 5 s for a hosted model and 60 s for one on this computer; `set … --timeout <duration>` (1s to 10m)
sets the limit, kept as `search_harder_timeout_s` beside the section. The search never fails because of it. Without
consent or a key, with a settings section it cannot read, under local only to a hosted model, past the time limit, or
on any provider error, the plain order stays and the answer's `harder` field says why (`applied: false`,
a `reason` and a `reason_id`: `harder.no-consent`, `no-key`, `bad-setting`, `address-refused`, `local-only`, `later-page`, `too-few`, `timeout`,
`key-rejected`, `unreachable`, `rate-limited`, `bad-reply`, `error`), with `provider`, `model`, `endpoint`, `sent`
(hits sent, 0 when nothing left), `cost_usd` (`null` for a model with no known price) and `ms`.

The request is the cli-testing search lab's: its prompt, and for Anthropic the JSON list of record numbers as
structured output, thinking off, effort low. OpenAI gets its JSON mode and temperature 0; an API at a base URL gets
neither, since not every one takes them. Both are told the JSON shape in the prompt, and an answer wrapped in a code
block is still read. The question goes as typed.

Measured over memo's own `search all` (EmbeddingGemma vectors, synthetic data, 9 November 2026):

| | v3 reworded, 17: recall@10 / hit@10 | LifeBench sample, 59: recall@10 / hit@10 | median ms | $ per question |
| --- | ---: | ---: | ---: | ---: |
| plain | 0.79 / 0.82 | 0.32 / 0.78 | 1,800–2,000 | 0 |
| `claude-haiku-5-5` | 0.88 / 0.88 | 0.39 / 0.88 | 3,300–3,900 | 0.0003 |
| `gpt-4o-mini` | 0.88 / 0.88 | 0.37 / 0.85 | 3,700–4,000 | 0.0003 |
| `deepseek/deepseek-chat` (OpenRouter) | 0.88 / 0.88 | 0.37 / 0.86 | 3,900–4,200 | 0.0006 |

The delay is the whole search on a loaded machine, not the call alone. Rewriting the question with the same model before
the rerank was tried too and lowered LifeBench recall@10 (0.39 to 0.37), so it is not done
([search lab](https://github.com/WireCatLabs/cli-testing/tree/main/performance/agents/knowledge-graph-memory/search-lab)).
An agent's shell cannot give the consent, and over MCP `models search-consents set` needs `mcp.authority`.

## Local only

`memo models local-only set on` keeps every model call on this computer, in every WireCat tool: an address that is not
`localhost`, `127.x.x.x` or `[::1]` is refused before anything is sent (`permission_error`, reason
`local-only.refused`). It covers the AI model (`models ai`), enrichment, search harder, linking, reply drafts,
attachment OCR, remote embeddings and OpenAI transcription; voice messages then use only the downloaded speech model,
never the messenger's service. It is off until the owner turns it on, kept as `local_only` in the shared settings
file; a section that cannot be read counts as on. An agent may turn it on, only the owner turns it off.
`memo models local-only show --json` lists each feature with `where` (`this-computer`, `elsewhere`, `agent`, `off`)
and whether local only refuses it. The digest and MCP agents run outside WireCat: they are local only when the agent
runs a local model.

## Pictures read by your coding agent

WireCat has no picture reader of its own. `models picture-reading set request --agent claude` (or `--agent codex`,
with an optional `--model`) lets `images read <ref> --attachment <n>` give that one picture to the coding agent and
keep the text it read as the attachment's text, with the extractor `agent:claude` or `agent:codex/<model>`. The picture
goes to that agent's provider, unless the agent runs a model on this computer; local only does not stop it. The
default is `never`, kept as `picture_reading` in the shared settings file; a section that cannot be read counts as
never. Only the owner turns it on (an agent may with the owner's `--from-app`); anyone may turn it off. Nothing reads
pictures at sync, and no picture is kept: the saved copy is read when there is one, else the messenger's download.
