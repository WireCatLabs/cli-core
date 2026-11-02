import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openStore } from "../store/store.js"
import { linkedChatsOf } from "./stored-project-gathering.js"

const note = (chatId: string): Message => ({
  id: "1",
  chatId,
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-01-01T10:00:00.000Z",
  editedAt: null,
  text: "hello",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

it("lists the confirmed linked chats with their account and role", async () => {
  const root = mkdtempSync(join(tmpdir(), "linked-chats-"))
  const store = await openStore({ env: { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") } })
  try {
    for (const [account, chat] of [
      ["500", "7"],
      ["501", "8"],
      ["500", "9"],
    ] as const)
      await store.messages.saveMessages({ provider: "chat", account }, chat, [note(chat)], { via: "test" })
    const project = await store.knowledge.addProject({ name: "Harbour" })
    const link = (from: string, extra: { role?: string; confirmed: boolean }) =>
      store.knowledge.relate(null, { from, to: project.ref, kind: "member-of", ...extra })
    await link("chat:chat/500/7", { role: "source report", confirmed: true })
    await link("chat:chat/501/8", { confirmed: true })
    await link("chat:chat/500/9", { confirmed: false })

    const chats = await linkedChatsOf(store, project.ref)

    expect(chats).toHaveLength(2)
    expect(chats).toContainEqual({ provider: "chat", account: "500", chat: "7", role: "source report" })
    expect(chats).toContainEqual({ provider: "chat", account: "501", chat: "8", role: null })
  } finally {
    await store.close()
  }
})
