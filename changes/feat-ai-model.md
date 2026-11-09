### Added

- **One AI model for every WireCat tool, `models ai show|set|off|forget|check`** (memo). The owner picks Anthropic,
  OpenAI or a service that works like it (OpenRouter and others, through `--base-url`), or Ollama on this computer
  (beta). The choice lives in the `ai` section of `~/.config/WireCat/config.json`. The key is read from stdin, kept
  in the system keyring under service `WireCat`, account `ai:<origin>`, and sent only to that address. The address
  must be https, or http only on this computer. `set`, `off`, `forget` and `check` refuse an agent's shell unless
  `--from-app`, and stay out of MCP. `check` sends one short paid request and names what is wrong: a refused key,
  no credit (HTTP 402 only: OpenAI's empty-balance 429 still reads as a rate limit), an unknown model, an
  unreachable address or the provider's own failure.
- **Images can be read by that model.** `models ai set … --images` records that the owner agreed images go to this
  address and model. Any later change of either closes it, and `--no-images` withdraws it. `aiImageReader` and `ocrImage` are exported from
  `@wirecat/cli-core/documents` for `memo sources add`.
- **A failed model call carries its HTTP status** in `details.status`, never the provider's text.
