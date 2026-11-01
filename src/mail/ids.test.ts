import { describe, expect, it } from "vitest"
import { mailIds } from "./ids.js"

const at = { folder: "INBOX", validity: "7", uid: "42" }
const ROOT = "imap:f7f0c35ba6b570d01fae2234737d53012bfbf0ca33cc0d07e91ba1bbf0f13060"
const PARENT = "imap:49f1389612fe9486cbbd859c4786a7c43eee9e8e2e526a171def8b18a95d5259"
const ONLY = "imap:9081d839fa0b466b173e544b68ea2b95f033ec03bd917928b1c20208fd18b5f3"
const BY_UID = "imap:da01a56d8029baaea8b4252deb7c61092b449a43ac30879817171a907a240464"

describe("mailIds", () => {
  it("keeps the ids mail 0.5 and memo stored: sha256 of the Message-ID with its angle brackets", () => {
    expect(mailIds({ ...at, messageId: "<only@example.com>", head: "" })).toEqual({ messageId: ONLY, threadId: ONLY })
    expect(mailIds({ ...at, head: "Subject: hi\r\nMessage-ID:  <only@example.com> \r\n" })).toEqual({
      messageId: ONLY,
      threadId: ONLY,
    })
  })

  it("threads on the first References id, folded or not, before In-Reply-To", () => {
    const head = "In-Reply-To: <parent@example.com>\r\nReferences:\r\n <root@example.com>\r\n <parent@example.com>\r\n"
    expect(mailIds({ ...at, messageId: "<only@example.com>", head }).threadId).toBe(ROOT)
  })

  it("takes In-Reply-To's id even after a display name", () => {
    const head = 'In-Reply-To: "Ann" <parent@example.com>\r\n'
    expect(mailIds({ ...at, messageId: "<only@example.com>", head }).threadId).toBe(PARENT)
  })

  it("falls back to the folder, UIDVALIDITY and UID when the Message-ID is missing or empty", () => {
    expect(mailIds({ ...at, head: "Subject: hi\r\n" })).toEqual({ messageId: BY_UID, threadId: BY_UID })
    expect(mailIds({ ...at, messageId: "", head: "" }).messageId).toBe(BY_UID)
  })
})
