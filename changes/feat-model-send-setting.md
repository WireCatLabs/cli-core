### Added

- **`models chats show|set allowed|ask|denied`: one setting for chat text sent to a model outside this
  computer.** It decides what `conversations embed` and `conversations links rebuild --analyze` do with a model that
  is not on this computer. `allowed` sends without a yes, in a terminal and over MCP. `ask`, the default, needs a yes
  as before. `denied` refuses. The setting is shared by every WireCat tool. Messenger CLIs mount it under `models`,
  and so does the model catalogue for the tool that turns on enrichment. Only the owner makes it less strict: `set`
  is no MCP tool, and an agent's run is refused unless it passes `--from-app`.
- **`conversations embed` and `conversations links rebuild` take their own `--yes`**, so an agent can pass `yes`
  over MCP under `ask`. Before, they read only the root program's `--yes`, which a tool call cannot pass, so an
  agent got `confirmation_required … add --yes` and could not go on.

### Changed — may break callers

- **Under `models chats denied`, `conversations embed` and `--analyze` to a model outside this computer refuse even
  with `--yes`** and even with a consent remembered for the chat: `permission_error`, reason `chat-sending.denied`.
  The message names the owner's command, `<cli> models chats set ask`. Without the setting nothing changes.
- **`--analyze` with a model on this computer no longer asks for consent or remembers one**, the same as
  `conversations embed` with a local model. A caller that expected `confirmation_required` there now gets the
  analysis.
- **The refusal under `ask` without a yes** now has reason `chat-sending.ask`, and its message says an agent may
  pass yes or ask the owner to run `<cli> models chats set allowed`.
