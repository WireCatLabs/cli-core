import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { matchDownloads } from "../domain/attachments.js"
import type { Attachment, Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "tg", account: "1" }
const fresh = () => join(mkdtempSync(join(tmpdir(), "downloads-")), "messages.db")

const message = (attachments: Attachment[]): Message => ({
  id: "42",
  chatId: "-1",
  senderId: "7",
  senderName: "Person",
  timestamp: "2026-01-01T10:00:00.000Z",
  editedAt: null,
  text: "files",
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const paths = async (path: string) => {
  const database = await openCache(path)
  try {
    return database
      .prepare("SELECT position, local_path AS path FROM attachments ORDER BY position")
      .all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

describe("matching saved files to stored attachments", () => {
  const stored = [
    { position: 0, kind: "photo", name: null },
    { position: 1, kind: "poll", name: null },
    { position: 2, kind: "file", name: "a.pdf" },
  ]

  it("**trusts the order only when the file attachments agree one to one by kind**", () => {
    expect(
      matchDownloads(stored, [
        { kind: "photo", path: "/p" },
        { kind: "file", path: "/f" },
      ]),
    ).toEqual([0, 2])
  })

  it("**falls back to a unique name, and names nothing it cannot tell apart**", () => {
    expect(matchDownloads(stored, [{ kind: "file", name: "a.pdf", path: "/f" }])).toEqual([2])
    expect(matchDownloads(stored, [{ kind: "photo", path: "/p" }])).toEqual([undefined])
    const twins = [
      { position: 0, kind: "file", name: "same.txt" },
      { position: 1, kind: "file", name: "same.txt" },
      { position: 2, kind: "file", name: "other.txt" },
    ]
    expect(matchDownloads(twins, [{ kind: "file", name: "same.txt", path: "/s" }])).toEqual([undefined])
  })

  it("uses the adapter's position when every file has one, and only where the kind agrees", () => {
    expect(
      matchDownloads(stored, [
        { kind: "file", position: 2, path: "/f" },
        { kind: "file", position: 0, path: "/p" },
      ]),
    ).toEqual([2, undefined])
  })
})

describe("where downloads went", () => {
  it("**records the path on the matching attachment, and a later sync keeps it**", async () => {
    const path = fresh()
    const store = await openStore({ path })
    const attachments: Attachment[] = [{ kind: "photo" }, { kind: "poll" }, { kind: "file", name: "a.pdf" }]
    await store.messages.saveMessages(OWNER, "-1", [message(attachments)], { via: "history" })

    const kept = await store.attachments.keepDownloads(OWNER, "-1", "42", [
      { kind: "photo", path: "/saved/42-1.jpg" },
      { kind: "file", name: "a.pdf", path: "/saved/a.pdf" },
    ])
    await store.messages.saveMessages(OWNER, "-1", [message(attachments)], { via: "history" })
    await store.close()

    expect(kept).toBe(2)
    expect(await paths(path)).toEqual([
      { position: 0, path: "/saved/42-1.jpg" },
      { position: 1, path: null },
      { position: 2, path: "/saved/a.pdf" },
    ])
  })

  it("records nothing for a message or chat the store does not hold", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.messages.saveMessages(OWNER, "-1", [message([{ kind: "file" }])], { via: "history" })

    expect(await store.attachments.keepDownloads(OWNER, "-2", "42", [{ kind: "file", path: "/x" }])).toBe(0)
    expect(await store.attachments.keepDownloads(OWNER, "-1", "43", [{ kind: "file", path: "/x" }])).toBe(0)
    await store.close()
    expect(await paths(path)).toEqual([{ position: 0, path: null }])
  })
})
