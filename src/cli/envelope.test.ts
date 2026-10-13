import { captureStreams, createRenderer } from "@wirecat/cli-base"
import { itemEnvelopeSchema, listEnvelopeSchema } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES } from "../entities/index.js"
import { itemOf, listOf, renderAnswer, sealed } from "./envelope.js"
import { inRun } from "./runs/scope.js"
import { nextStep } from "./steps.js"

const at = "2026-10-13T10:00:00.000Z"
const chat = {
  ref: "chat:telegram/1/2",
  id: "2",
  title: "Synthetic",
  kind: "group",
  unread_count: 0,
  last_message_at: at,
  participants_count: 3,
}
const sync = nextStep("messages.sync", { args: { chat: "2" } })
const download = nextStep("models.download", { args: { model: "e5-small" } })

const program = () => {
  const root = new Command("chat")
  const messages = root.command("messages")
  messages.command("sync").argument("[chat]")
  const list = root.command("chats").command("list")
  return { root, list }
}

describe("the answer envelope", () => {
  it("says where the next page starts first when more rows exist, and keeps three steps at most", () => {
    const body = listOf("chats list", { items: [chat], limit: 1, has_more: true, page: 1, next: [sync, sync, sync] })
    expect(body.page).toEqual({ limit: 1, has_more: true })
    expect(body.next?.[0]).toMatchObject({ step: "page.next", command: "chats list", args: { page: 2, limit: 1 } })
    expect(body.next).toHaveLength(3)
    const cursor = listOf("chats list", { items: [chat], limit: 1, has_more: true, cursor: "abc" })
    expect(cursor.next?.[0]?.args).toEqual({ cursor: "abc", limit: 1 })
    expect(listOf("chats list", { items: [], limit: 20, has_more: false })).not.toHaveProperty("next")
  })

  it("gets meta from the run it belongs to and fits the entity's envelope schema", () => {
    const list = inRun({ runId: "run-1", command: "chats list", startedAt: Date.now() - 5 }, () =>
      sealed(listOf("chats list", { items: [chat], limit: 20, has_more: false })),
    )
    expect(list.meta?.run_id).toBe("run-1")
    expect(list.meta?.duration_ms).toBeGreaterThanOrEqual(5)
    expect(v.safeParse(listEnvelopeSchema(ENTITIES.chat), list).issues).toBeUndefined()
    const item = sealed(itemOf(chat, { next: [sync] }))
    expect(v.safeParse(itemEnvelopeSchema(ENTITIES.chat), item).issues).toBeUndefined()
  })

  it("leaves an answer in its old shape alone", () => {
    const old = { items: [chat], page: 1, limit: 20, hasMore: false }
    expect(sealed(old)).toBe(old)
  })

  it("prints the whole envelope for a machine, with only the steps this CLI has", () => {
    const { root, list } = program()
    const streams = captureStreams()
    const body = itemOf(chat, { next: [download, sync] })
    renderAnswer(
      list,
      { renderer: createRenderer({ format: "json", color: false, streams }), format: "json", streams },
      body,
    )
    const printed = JSON.parse(streams.stdout[0] ?? "")
    expect(printed.next).toEqual([sync])
    expect(printed.meta.run_id).toEqual(expect.any(String))
    expect(streams.stderr).toEqual([])
    expect(root.name()).toBe("chat")
  })

  it("shows a person the items and each step as a line on stderr", () => {
    const { list } = program()
    const streams = captureStreams()
    const output = { renderer: createRenderer({ format: "pretty", color: false, streams }), format: "pretty", streams }
    renderAnswer(list, output as Parameters<typeof renderAnswer>[1], itemOf(chat, { next: [sync] }), () => "Synthetic")
    expect(streams.stdout).toEqual(["Synthetic"])
    expect(streams.stderr.join("\n")).toContain(
      "→ the local copy is missing messages; syncing brings them in: chat messages sync 2",
    )
  })
})
