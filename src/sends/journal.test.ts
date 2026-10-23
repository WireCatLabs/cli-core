import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logRecordSchema } from "@wirecat/cli-base/standards"
import { expectRegisteredEvents } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { expect, it } from "vitest"
import { CORE_LOG_EVENTS } from "../runs/log-events.js"
import { inRun } from "../runs/scope.js"
import { SendJournal } from "./journal.js"

const journalFile = () => join(mkdtempSync(join(tmpdir(), "send-journal-")), "default.jsonl")

it("writes each entry as a log record of the run that sent it", () => {
  const path = journalFile()
  const journal = new SendJournal(path, { service: "tg", version: "1.0.0" })
  inRun({ runId: "20261013T080000Z-messages-send-a81f2c", command: "messages send" }, () => {
    journal.append({ at: "2026-10-13T08:00:00.000Z", profile: "default", chatId: "1", outcome: "sent", length: 5 })
    journal.append({ at: "2026-10-13T08:00:01.000Z", profile: "default", chatId: "1", outcome: "refused" })
  })

  const lines = readFileSync(path, "utf8").trimEnd().split("\n")
  for (const line of lines) v.parse(logRecordSchema, JSON.parse(line))
  expectRegisteredEvents(lines, CORE_LOG_EVENTS)
  expect(JSON.parse(lines[0] as string)).toEqual({
    time: "2026-10-13T08:00:00.000Z",
    severity: "info",
    body: "send.recorded",
    run_id: "20261013T080000Z-messages-send-a81f2c",
    command: "messages send",
    attributes: { event: "send.recorded", profile: "default", chat_id: "1", outcome: "sent", length: 5 },
    resource: { service: "tg", version: "1.0.0" },
  })
  expect(JSON.parse(lines[1] as string)).toMatchObject({ severity: "warn" })
  expect(journal.entries()).toEqual([
    { at: "2026-10-13T08:00:00.000Z", profile: "default", chatId: "1", outcome: "sent", length: 5 },
    { at: "2026-10-13T08:00:01.000Z", profile: "default", chatId: "1", outcome: "refused" },
  ])
})

it("still counts a line written before the journal held records", () => {
  const path = journalFile()
  appendFileSync(
    path,
    `${JSON.stringify({ at: "2026-10-13T07:00:00.000Z", profile: "default", chatId: "1", outcome: "sent" })}\n`,
  )
  const journal = new SendJournal(path, { service: "tg", version: "1.0.0" })
  journal.append({ at: "2026-10-13T08:00:00.000Z", profile: "default", chatId: "2", outcome: "sent" })

  expect(journal.entries().map((entry) => entry.chatId)).toEqual(["1", "2"])
})

it("names one run for the whole process when nothing is running", () => {
  const path = journalFile()
  const journal = new SendJournal(path, { service: "tg", version: "1.0.0" })
  journal.append({ at: "2026-10-13T08:00:00.000Z", profile: "default", chatId: "1", outcome: "sent" })
  journal.append({ at: "2026-10-13T08:00:01.000Z", profile: "default", chatId: "1", outcome: "sent" })

  const [first, second] = readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(first.run_id).toMatch(/-process-/)
  expect(second.run_id).toBe(first.run_id)
})

it("filters settled attempts without reviving reservations and leaves the journal unchanged", () => {
  const path = journalFile()
  const journal = new SendJournal(path)
  const base = { at: "2026-10-13T08:00:00.000Z", profile: "work", chatId: "7", operationId: "op-1" }
  journal.append({ ...base, outcome: "reserved", reservation: "reserve-1" })
  journal.append({ ...base, outcome: "failed", reservation: "reserve-1", errorCode: "timeout", key: "messages.send" })
  journal.append({ ...base, chatId: "8", operationId: "op-2", outcome: "sent" })
  const before = readFileSync(path, "utf8")
  expect(journal.entries({ outcome: "reserved" })).toEqual([])
  expect(journal.entries({ outcome: "failed", chatId: "7", key: "messages.send", errorCode: "timeout" })).toMatchObject(
    [{ operationId: "op-1", outcome: "failed" }],
  )
  expect(journal.entries({ operationId: "op-2" })).toMatchObject([{ chatId: "8", outcome: "sent" }])
  expect(journal.entries({ outcome: "failed", chatId: "8" })).toEqual([])
  expect(readFileSync(path, "utf8")).toBe(before)
})
