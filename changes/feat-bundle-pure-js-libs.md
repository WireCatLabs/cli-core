### Fixed

- **The install is about 26 MB smaller: the MCP SDK with zod, LiquidJS, tldts and psl are bundled, and the Russian
  dictionary ships gzipped.** The packed cli-core installs in 153 MB on disk instead of 178 MB, with 9 packages fewer.
  `dist/bundled/` (under 1 MB) holds the libraries; MCP servers, templates, mail scoring and mention parsing answer as
  before. `@modelcontextprotocol/server` and `liquidjs` stay as optional peer dependencies, because cli-core's
  declarations name their types (`McpServer`, `CallToolResult`): an app that has the SDK, as cli-memo does, gets
  them, and an app without it sees `any` there under `skipLibCheck`. An app that builds its own `McpServer` and serves
  it with `serveOverHttp` keeps working. An app that imported one of these libraries itself, counting on cli-core to
  install it, now lists it in its own dependencies. The licence notices are in `THIRD_PARTY_NOTICES`
  ([architecture](../docs/dev/ARCHITECTURE.md)).
