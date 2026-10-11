import { CliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { onlineDeps } from "./deps.js"
import { messagesService } from "./messages.js"

const discussion = { chatId: "-1002", messageId: "900" }
const comment = { id: "901", chatId: "-1002", text: "synthetic comment" }

const fixture = (capable = true) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (request: GuardRequest) => checked.push(request),
    record: (entry: Omit<SendEntry, "at" | "profile">) => records.push(entry),
  } as unknown as SendGuard
  const discussionOf = vi.fn(async () => discussion)
  const comments = vi.fn(async () => ({ items: [comment], hasMore: true }))
  const send = vi.fn(async (chatId: string, text: string, options: { sendId: string }) => ({
    sendId: options.sendId,
    message: { id: "902", chatId, text } as never,
  }))
  const adapter = {
    resolve: async () => ({ id: "-1001", title: "Synthetic channel", kind: "channel" }),
    send,
    ...(capable ? { discussionOf, comments } : {}),
  } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { deps, service: messagesService(deps), discussionOf, comments, send, records, checked }
}

describe("channel comments", () => {
  it("reads a post's comments with where they live", async () => {
    const f = fixture()
    expect(await f.service.comments("Synthetic channel", " 42 ", { limit: 20, before: "950" })).toEqual({
      discussion,
      items: [comment],
      hasMore: true,
    })
    expect(f.discussionOf).toHaveBeenCalledWith("-1001", "42")
    expect(f.comments).toHaveBeenCalledWith("-1001", "42", { limit: 20, before: "950" })
  })

  it("comments as a reply in the discussion group, which the guard and the journal see", async () => {
    const f = fixture()
    await f.service.send({ chat: "Synthetic channel", text: "nice", commentTo: "42" })
    expect(f.send).toHaveBeenCalledWith("-1002", "nice", expect.objectContaining({ replyTo: "900" }))
    expect(f.checked[0]).toMatchObject({ chatId: "-1002", replyTo: "900" })
    expect(f.records).toMatchObject([{ chatId: "-1002", replyTo: "900", outcome: "sent" }])
  })

  it("keeps a post without comments not_found, and sends nothing", async () => {
    const f = fixture()
    f.discussionOf.mockRejectedValueOnce(new CliError("not_found", "this post takes no comments"))
    await expect(f.service.send({ chat: "c", text: "nice", commentTo: "42" })).rejects.toMatchObject({
      code: "not_found",
    })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.checked).toEqual([])
  })

  it("refuses a comment with --reply-to or --topic, offline reads, a blank post and a messenger without comments", async () => {
    const f = fixture()
    for (const extra of [{ replyTo: "1" }, { threadId: "2" }]) {
      await expect(f.service.send({ chat: "c", text: "x", commentTo: "42", ...extra })).rejects.toThrow(
        "answers the post itself",
      )
    }
    await expect(messagesService({ ...f.deps, offline: true }).comments("c", "42", { limit: 5 })).rejects.toThrow(
      "not with --offline",
    )
    await expect(f.service.comments("c", " ", { limit: 5 })).rejects.toThrow("which post")
    const lacking = fixture(false)
    await expect(lacking.service.comments("c", "42", { limit: 5 })).rejects.toThrow("cannot read comments")
    await expect(lacking.service.send({ chat: "c", text: "x", commentTo: "42" })).rejects.toThrow(
      "cannot comment on a channel post",
    )
    expect(lacking.send).not.toHaveBeenCalled()
  })
})
