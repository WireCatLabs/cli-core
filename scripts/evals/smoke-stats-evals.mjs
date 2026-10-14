import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = mkdtempSync(join(tmpdir(), "stats-eval-smoke-"))
const fixture = fileURLToPath(new URL("stats-fixture.mjs", import.meta.url))
const invoke = (args) => {
  const result = spawnSync(process.execPath, [fixture, ...args], {
    env: { ...process.env, STATS_EVAL_ROOT: root },
    encoding: "utf8",
    timeout: 30000,
  })
  assert.equal(result.error, undefined)
  return { code: result.status, body: JSON.parse(result.stdout || result.stderr) }
}
const read = (...args) => {
  const result = invoke([...args, "--json"])
  assert.equal(result.code, 0)
  return result.body
}
const report = read("stats", "chats", "retention", "7", "--timezone", "UTC").item
assert.equal(report.unknown_join, 1)
assert.deepEqual(
  report.rows[0].checkpoints.map(({ rate }) => rate),
  [1, 0.5, null],
)
const row = report.rows[0]
const evidenceArgs = [
  "stats",
  "messages",
  "evidence",
  row.cohort,
  "--selection",
  JSON.stringify(row.selection),
  "--component",
  "report",
  "--limit",
  "1",
]
const first = read(...evidenceArgs)
assert.ok(first.page.cursor)
assert.equal(invoke(["__advance"]).body.changed, true)
assert.equal(invoke([...evidenceArgs, "--cursor", first.page.cursor, "--json"]).body.error.reason, "selection.changed")
const counters = read("stats", "messages", "counters", "show", "--chat", "9").item
assert.equal(counters.rows.find(({ ref }) => ref.endsWith("/p10")).counters[0].value, 0)
const selection = JSON.stringify({
  ...counters.selection,
  locators: counters.selection.locators.filter((locator) => locator.endsWith("/p10")),
})
const args = [
  "stats",
  "messages",
  "counters",
  "refresh",
  "--selection",
  selection,
  "--max-messages",
  "1",
  "--sync-time",
  "5s",
]
assert.equal(read(...args, "--dry-run").item.targets.length, 1)
assert.equal(read(...args, "--counters", "views,reactions").item.complete, true)
const mcp = invoke(["__mcp", "list"])
assert.equal(mcp.code, 0)
assert.deepEqual(
  mcp.body.tools.map(({ name }) => name),
  ["max_tools_search", "max_read", "max_write"],
)
const ledger = readFileSync(join(root, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
assert.equal(ledger.filter(({ kind }) => kind === "fetchCounters").length, 1)
assert.equal(ledger.filter(({ kind }) => kind === "forbidden").length, 0)
console.log(
  JSON.stringify({
    ok: true,
    root,
    checks: "real CLI/MCP, retention, changed cursor, zero, bounded preview and refresh, forbidden-action ledger",
  }),
)
