### Fixed

- **A release passes parity again while four CLIs adopt `schedule exec` leaving MCP.** #3258 stopped offering
  `schedule exec` to agents; cli-memo, mail-cli and bitrix24-cli test that it is offered, and max-cli's docs/mcp.md
  does not list it among the commands kept off MCP. They are on the parity known-broken list until 2026-11-30 and
  update those tests and docs when they bump cli-core.
