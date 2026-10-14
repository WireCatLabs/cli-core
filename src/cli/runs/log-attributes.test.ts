import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NOT_ALLOWED } from "@wirecat/cli-base"
import { isContentKey, logRecordSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { agentActionRecord } from "../../mcp/agent-log.js"
import { LOG_ATTRIBUTES } from "./log-attributes.js"
import { crashOf } from "./recording.js"
import { startRun } from "./run.js"

describe("the log allow-list", () => {
  it("names no message text, token or phone number", () => {
    expect(LOG_ATTRIBUTES.filter(isContentKey)).toEqual([])
  })

  it("lets every field of a run's events through, the crash included", async () => {
    const run = startRun({
      runsDir: join(mkdtempSync(join(tmpdir(), "log-keys-")), "runs"),
      command: "messages send",
      profile: "default",
      service: "tg",
      cliVersion: "0.0.0",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    })
    run.logger.info({
      event: "response",
      operation: "messages.send",
      opcode: 64,
      seq: 3,
      status: 200,
      bytes: 120,
      ids: { chat: "7" },
      counts: { messages: 1 },
      durationMs: 40,
      outcome: "error",
      errorCode: "rate_limited",
      providerError: "FLOOD_WAIT",
    })
    run.logger.warn({ event: "warning", code: "slow", operation: "chats.list", detail: "items[]: object" })
    run.logger.error(crashOf(new TypeError("private words")))
    await run.finish("failed")

    const text = readFileSync(join(run.dir, "events.jsonl"), "utf8")
    const records = text
      .trimEnd()
      .split("\n")
      .map((line) => v.parse(logRecordSchema, JSON.parse(line)))
    expect(records).toHaveLength(3)
    expect(records.every((record) => record.trace_id === "4bf92f3577b34da6a3ce929d0e0e4736")).toBe(true)
    expect(text).not.toContain(NOT_ALLOWED)
    expect(text).not.toContain("private words")
    expect(records[2]?.attributes).toMatchObject({ event: "command.crashed", error_class: "TypeError" })
  })

  it("maps an agent's audit row to a record with ids and codes only", () => {
    const record = agentActionRecord(
      {
        id: "12",
        actor: { type: "bot", id: "3", name: "tg-mcp" },
        tool: "messages_send",
        tier: "write-public",
        target: { type: "chat", id: "9" },
        status: "refused",
        error: "permission_error",
        startedAt: "2026-10-13T08:00:00.000Z",
        finishedAt: "2026-10-13T08:00:00.250Z",
      },
      { service: "tg", version: "1.0.0" },
    )

    expect(v.parse(logRecordSchema, record)).toEqual({
      time: "2026-10-13T08:00:00.000Z",
      severity: "warn",
      body: "agent.action",
      run_id: "20261013T080000Z-agent-action-12",
      command: "mcp messages send",
      attributes: {
        event: "agent.action",
        tool: "messages_send",
        tier: "write-public",
        outcome: "refused",
        actor_type: "bot",
        actor_id: "3",
        agent: "tg-mcp",
        target_type: "chat",
        target_id: "9",
        error_code: "permission_error",
        duration_ms: 250,
      },
      resource: { service: "tg", version: "1.0.0" },
    })
  })
})
