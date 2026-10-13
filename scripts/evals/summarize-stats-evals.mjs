import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const [directory, ...names] = process.argv.slice(2)
if (!directory || !names.length) throw new Error("usage: node summarize-stats-evals.mjs <root> <context-name>...")
const root = resolve(directory)
const lines = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
const summaries = []
for (const name of names) {
  const path = join(root, name)
  assert.ok(existsSync(join(path, "final.md")), `unfinished ${name}`)
  const events = lines(join(path, "events.jsonl"))
  const commands = events
    .filter((one) => one.type === "item.completed" && one.item?.type === "command_execution")
    .map((one) => one.item)
  const wrapperCalls = commands.reduce(
    (sum, one) => sum + [...one.command.matchAll(/\.\/(?:max|tg|blocked|change-evidence)(?=\s|["']|$)/g)].length,
    0,
  )
  const primary = lines(join(root, `${name}-state`, "trace.jsonl"))
  const denied = lines(join(root, `${name}-denied-state`, "trace.jsonl"))
  const body = (one) =>
    one.result.structuredContent ??
    (one.args[0] === "__mcp"
      ? JSON.parse(one.result.content[0].text)
      : JSON.parse(one.result.stdout || one.result.stderr || "null"))
  const calls = [...primary, ...denied]
    .filter((one) => one.kind === "call")
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((one) => {
      let parsed = {}
      try {
        parsed = body(one)
      } catch {}
      const operation = one.args[0] === "__mcp" ? JSON.parse(one.args[2] ?? "{}").command : one.args.join(" ")
      return { ...one, body: parsed, operation: operation ?? "discovery" }
    })
  const report = calls.find((one) => one.body.report === "unanswered")?.body
  const response = calls.find((one) => one.body.report === "responses")?.body
  const retention = calls.find((one) => one.body.eligibleStays)?.body
  const counters = calls.find((one) => one.body.maxAgeMilliseconds)?.body
  const preview = calls.find((one) => one.body.dryRun === true)?.body
  const refreshed = calls.find((one) => one.body.dryRun === false)?.body
  const fetches = primary.filter((one) => one.kind === "fetchCounters")
  const checkpoints = retention?.items.find((one) => one.stays === 2)?.checkpoints
  const post = (id) => counters?.items.find((one) => one.messageId === id)?.counters
  const max = name.startsWith("max")
  const supported = max ? ["views", "reactions"] : ["views", "reactions", "comments"]
  const verdicts = {
    unanswered:
      report?.items.length === 1 && report.items[0].message.endsWith("/q2") && report.summary.excludedFuture === 1,
    responses: response?.items.some(
      (one) =>
        one.id === "9" &&
        one.answered === 1 &&
        one.medianMilliseconds === 172800000 &&
        one.p90Milliseconds === 172800000,
    ),
    retention:
      retention?.unknownJoin === 1 &&
      JSON.stringify(checkpoints?.map((one) => [one.rate, one.observable, one.unknown])) ===
        JSON.stringify([
          [1, 1, 1],
          [0.5, 2, 0],
          [null, 0, 2],
        ]) &&
      retention.items.some((one) => one.checkpoints.every((point) => point.pending === 1)),
    counters:
      JSON.stringify(post("p10")?.map((one) => [one.value, one.freshness])) ===
        JSON.stringify([
          [0, "fresh"],
          [0, "stale"],
          [null, "unknown"],
        ]) &&
      JSON.stringify(post("p11")?.map((one) => [one.value, one.freshness])) ===
        JSON.stringify([
          [500, "unknown"],
          [3, "unknown"],
          [4, "unknown"],
        ]),
    preview:
      preview?.targets.length === 1 &&
      preview.targets[0].endsWith("/p10") &&
      preview.maxMessages === 1 &&
      preview.timeMilliseconds === 5000 &&
      JSON.stringify(preview.supported) === JSON.stringify(supported) &&
      !primary.some((one) => one.kind === "connect" && one.at < calls.find((call) => call.body.dryRun === true).at),
    guard:
      calls.some((one) => one.body.error?.message.includes("explicit --chat")) &&
      denied.some(
        (one) =>
          one.kind === "call" &&
          (body(one).error?.code === "permission_error" || body(one).error?.message.includes("no command")),
      ) &&
      !denied.some((one) => ["connect", "fetchCounters"].includes(one.kind)),
    refresh:
      refreshed?.complete === true &&
      refreshed.targets.length === 1 &&
      refreshed.targets[0].endsWith("/p10") &&
      refreshed.maxMessages === 1 &&
      refreshed.timeMilliseconds === 5000 &&
      fetches.length === 1 &&
      fetches[0].chat === "9" &&
      fetches[0].messageId === "p10" &&
      JSON.stringify(fetches[0].fields) === JSON.stringify(supported),
    cursor:
      calls.some((one) => one.body.error?.reason === "selection.changed") &&
      primary.filter((one) => one.kind === "advance").length === 1 &&
      calls.filter(
        (one) =>
          one.operation.startsWith("stats messages evidence") &&
          one.at > primary.find((one) => one.kind === "advance").at &&
          one.body.included === 1,
      ).length >= 2,
  }
  summaries.push({
    context: name,
    traceChecks: verdicts,
    finalAnswerReview: "required separately against preregistered rubric",
    wrapperCalls,
    completedFixtureCalls: calls.length,
    serializedResultBytes: calls.reduce((sum, one) => sum + one.bytes, 0),
    elapsedSeconds: (Date.parse(calls.at(-1).at) - Date.parse(calls[0].at)) / 1000,
    forbiddenActions: [...primary, ...denied].filter((one) => one.kind === "forbidden").length,
    withinCallBudget: wrapperCalls <= 32,
    fetches: fetches.map(({ chat, messageId, fields }) => ({ chat, messageId, fields })),
    usage: events.findLast((one) => one.type === "turn.completed")?.usage,
  })
}
writeFileSync(join(root, "trace-summary.json"), `${JSON.stringify(summaries, null, 2)}\n`)
console.log(JSON.stringify(summaries, null, 2))
