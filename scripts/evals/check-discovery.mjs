import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("stats-fixture.mjs", import.meta.url))
const roots = []
for (const provider of ["max", "telegram"]) {
  const root = mkdtempSync(join(tmpdir(), "stats-discovery-check-"))
  roots.push(root)
  const command = provider === "max" ? "max" : "tg"
  const env = {
    ...process.env,
    STATS_EVAL_ROOT: root,
    STATS_EVAL_PROVIDER: provider,
    STATS_EVAL_SUBJECT: process.cwd(),
    STATS_EVAL_VARIANT: "discovery",
    STATS_EVAL_CLOCK: "2026-10-08T12:00:00Z",
    STATS_EVAL_SEED: "stats-discovery-v1",
  }
  const call = (args, mcp = false) => {
    const run = spawnSync(process.execPath, [fixture, ...args], { env, encoding: "utf8", timeout: 20000 })
    const output = JSON.parse(run.stdout || run.stderr)
    return mcp ? (output.structuredContent ?? JSON.parse(output.content[0].text)) : output
  }
  for (const mode of ["cli", "mcp"]) {
    const read = (path, args, cli) =>
      mode === "cli"
        ? call([...cli, "--json"])
        : call(["__mcp", `${command}_read`, JSON.stringify({ command: path, arguments: args })], true)
    assert.equal(read("chats show", { chat: "Planning" }, ["chats", "show", "Planning"]).item.id, "8")
    assert.equal(read("chats show", { chat: "Garden" }, ["chats", "show", "Garden"]).item.id, "7")
    assert.equal(read("contacts show", { person: "@alex_rivera" }, ["contacts", "show", "@alex_rivera"]).item.id, "9")
    const people = read("contacts list", {}, ["contacts", "list"])
    assert.deepEqual(people.items.map((one) => one.id).sort(), ["10", "9"])
    const found = read("stats contacts responses", { chat: "Planning", answerer: ["Project lead"] }, [
      "stats",
      "contacts",
      "responses",
      "--chat",
      "Planning",
      "--answerer",
      "Project lead",
    ])
    assert.equal(found.item.rows[0].id, "9")
    assert.equal(found.item.rows[0].answered, 1)
    assert.equal(found.item.rows[0].identity_known, true)
    const missing = read("stats contacts responses", { answerer: ["Taylor Unknown"] }, [
      "stats",
      "contacts",
      "responses",
      "--answerer",
      "Taylor Unknown",
    ])
    assert.equal(missing.error.code, "not_found")
    const ambiguous = read("stats contacts responses", { answerer: ["Alex"] }, [
      "stats",
      "contacts",
      "responses",
      "--answerer",
      "Alex",
    ])
    assert.equal(ambiguous.error.code, "validation_error")
    assert.equal(ambiguous.error.details.candidates.length, 2)
    const unseen = read("stats contacts responses", { answerer: ["999"] }, [
      "stats",
      "contacts",
      "responses",
      "--answerer",
      "999",
    ])
    assert.equal(unseen.item.rows[0].identity_known, false)
    assert.equal(unseen.item.rows[0].status, "unknown")
  }
  const trace = readFileSync(join(root, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(trace.filter((one) => ["fetchCounters", "forbidden"].includes(one.kind)).length, 0)
}
console.log(
  JSON.stringify({
    passed: true,
    roots,
    checks:
      "CLI/MCP chat and person discovery, alias, ambiguity, unknown names and explicit unseen IDs; no counter fetch or forbidden actions",
  }),
)
