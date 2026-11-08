# AI providers for search

Search uses the local embedding model chosen with `models set`, `e5-small` until one is chosen (see
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

Custom endpoints never inherit the public OpenAI/Anthropic key. URLs must be HTTP/S without embedded credentials, query or fragment. Anthropic is analysis only: [Anthropic offers no embedding model](https://platform.claude.com/docs/en/build-with-claude/embeddings). OpenAI-style analysis uses Chat Completions; custom servers use the compatible `max_tokens` field, while api.openai.com uses `max_completion_tokens`. [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) covers a subset of that API. Choose a model that returns JSON and token usage; there is no automatic provider fallback or retry.

Before analysis sends its first batch, the CLI explains the endpoint/model, messages, characters, estimated message tokens, and run cap. Machine mode requires `--yes` for a new consent. A yes is remembered for **this account, native chat ID, provider and endpoint path**, across model changes at that endpoint, until revoked. A different chat/account/provider/endpoint requires another yes. This applies to explicitly configured local endpoints too. `conversations embed` still asks for remote message batches on every run; configuring a provider does not waive it. Search with a remote embedding provider sends the query text to that endpoint; MCP search/related/status honor the profile's embedding choice. Bulk refresh stays local.

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

| Id | Size | On disk | Licence | Speed (chunks a second, one session) |
|---|---|---|---|---|
| `e5-small` (default) | small | 135 MB | MIT | about 31 |
| `embeddinggemma` | medium | 218 MB | Gemma Terms of Use (`--accept-terms`) | about 2 |
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
```

With it on, `embedNotes` and `embedMail` (every `sync` that embeds) first enrich up to 600 records that have no
enrichment of their current text, 20 to a request and four requests at once, then embed. A record is sent once per
text: an edit sends it again, a re-sync does not. A batch the model answers wrongly leaves its records for the next
sync; a rate limit or a missing key stops the run. The records go as untrusted data, never as instructions; each
record adds at most five facts and three questions of at most 400 characters.

The key is read from the tool's keyring entry `embeddings:<provider>` when the tool passes its identity
(`models keys set openai` in tg and MAX), else from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
An agent's shell cannot turn it on, and over MCP `models consents set` needs `mcp.authority`. Prices for the
estimate are known for `openai/gpt-4o-mini` and `anthropic/claude-haiku-5-5`; another model gets `usd: null`.
