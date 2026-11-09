### Changed — may break callers

- **The CRM's `deals` and `leads` commands name their argument `<deal>` and `<lead>`, not `<ref>`** (WC-CMD-13).
  `show`, `update`, `move`, `close` and `delete` take the same `deal:<id>` or `lead:<id>` as before; only the name
  changes. Through MCP the argument is now `deal` or `lead`, so a call that sends `ref` is refused. Under
  `<PREFIX>_GROUP_LOCK` a bare id such as `deals show 12` is now read as `deal:12` and checked against the group. A
  CRM CLI runs `pnpm generate` and `pnpm exec cli-contract contracts/plan.json --update` on the bump that brings this.
