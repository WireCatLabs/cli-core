import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logRecordSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { expect, it } from "vitest"
import { inRun } from "../cli/runs/scope.js"
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
  expect(JSON.parse(lines[0] as string)).toEqual({
    time: "2026-10-13T08:00:00.000Z",
    severity: "info",
    body: "message",
    run_id: "20261013T080000Z-messages-send-a81f2c",
    command: "messages send",
    attributes: { profile: "default", chat_id: "1", outcome: "sent", length: 5 },
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
