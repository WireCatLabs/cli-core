### Changed — may break callers

- **No MCP server offers `chats delete` or `chats clear`.** Over MCP an `ask` level goes ahead without a question, so
  an agent could delete a whole chat or its history from the account. Both stay on the command line, where `ask` still
  asks first.
