### Added

- **Local only: one switch that keeps every model call on this computer.** `models local-only set on|off` and
  `models local-only show` (in memo): with it on, the model gateway, remote embeddings and OpenAI transcription refuse
  any address that is not `localhost`, `127.x.x.x` or `[::1]` before anything is sent (`local-only.refused`), and the
  setting commands refuse to save one. `show` lists each feature, where its data goes and whether it is refused. Off by
  default; only the owner turns it off. See
  [ai-providers.md, "Local only"](../docs/search/ai-providers.md#local-only).
- **Linking, reply drafts and attachment OCR use the shared AI model** when `models.analysis`, `models.replies` or
  `models.ocr` are not set (`off` stays off), with the key kept for its address (`purposeModel`, `sharedModel`).
- **`models search-consents set --timeout <duration>`.** Search harder waits 60 s for a model on this computer and 5 s
  for a hosted one unless the owner sets the limit; `show` gives `timeout_s`.

### Changed — may break callers

- **Plain http is allowed only to this computer,, for every model call.** Enrichment, search harder,
  linking, reply drafts, attachment OCR and remote embeddings refused nothing but credentials in the address, so a
  `http://` address on another machine sent records across the network unencrypted. They now refuse it, as `models ai`
  already did (`model.address-refused`); use https, or run the model on this computer. A saved setting with such an
  address still reads, and its feature says why it sends nothing.
- **Voice messages are heard by the downloaded model first.** `auto` asked the messenger's speech service first; it now
  uses the local model when it is downloaded and asks the messenger only when it is not, and never under local only.
- **An OpenAI-compatible server on this computer needs no key** in `models ai`; one may still be stored for it.
