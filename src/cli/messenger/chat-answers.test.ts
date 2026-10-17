import { describe, expect, it } from "vitest"
import { auditAnswer } from "./chat-answers.js"

const partial = {
  chatId: "7",
  state: "partial" as const,
  upToDate: false,
  gaps: false,
  reachesStart: false,
  fetchedAt: null,
}
const audit = {
  chatId: "7",
  read: 0,
  participantsCount: null,
  more: false,
  unknown: [],
  items: [],
  completeness: partial,
}

describe("auditAnswer", () => {
  it("**UX-59: keeps the never_wrote caveat without a sync step where the service named no fetch**", () => {
    expect(auditAnswer(audit)).toMatchObject({ missing: [{ field: "reasons" }] })
    expect(auditAnswer(audit).missing?.[0]).not.toHaveProperty("step")
    expect(auditAnswer(audit)).not.toHaveProperty("next")
    expect(auditAnswer({ ...audit, fetch: "chat messages sync 7" })).toMatchObject({
      missing: [{ field: "reasons", step: "messages.sync" }],
      next: [{ step: "messages.sync", args: { chat: "7" } }],
    })
  })
})
