import { expect, it } from "vitest"
import { sendAttemptItem } from "./guard-commands.js"

it("exposes one operation id while reading legacy and current journal entries", () => {
  const entry = { at: "2026-10-01T12:00:00Z", profile: "synthetic", chatId: "7", outcome: "sent" as const }
  expect(sendAttemptItem({ ...entry, sendId: "old-1" })).toMatchObject({ operation_id: "old-1" })
  expect(sendAttemptItem({ ...entry, sendId: "old-1", operationId: "new-1" })).toMatchObject({ operation_id: "new-1" })
  expect(sendAttemptItem({ ...entry, sendId: "old-1" })).not.toHaveProperty("send_id")
  expect(sendAttemptItem(entry)).not.toHaveProperty("operation_id")
})
