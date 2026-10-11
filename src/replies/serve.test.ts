import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { Message } from "../domain/models.js"
import { defaultRule } from "./rules.js"
import { NO_TASKS, NOT_ALLOWED, ONLY_TASK, type Replier, replyTo } from "./serve.js"
import { paused, readRepliesState, writeRepliesState } from "./state.js"

const NOW = Date.parse("2026-10-07T18:30:00Z")

const said = (id: string, changes: Partial<Message> = {}): Message => ({
  id,
  chatId: "c1",
  senderId: "friend",
  senderName: "Ana Example",
  timestamp: new Date(NOW - 60_000).toISOString(),
  editedAt: null,
  text: "are you there?",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...changes,
})

const FRIEND_ONLY = { reply: "listed", allow: { people: ["friend"] } }

const setUp = ({
  allowed = true,
  perChat = "5/1d",
  does = ["reply"],
  tasks = true,
  audience = FRIEND_ONLY,
  testers,
}: {
  allowed?: boolean
  perChat?: string
  does?: string[]
  tasks?: boolean
  audience?: unknown
  /** An older file's list, written beside the audience. */
  testers?: { id: string; provider?: string }[]
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "replies-serve-"))
  const rule = {
    ...defaultRule("away"),
    on: true,
    do: does,
    reply: { template: "Thanks, {firstName}.", model: "fill-only", asReply: true },
    limits: { perChat, perPerson: "5/1d" },
  }
  const rulesPath = join(root, "replies.json")
  writeFileSync(rulesPath, JSON.stringify({ ...(testers === undefined ? {} : { testers }), audience, rules: [rule] }))
  const sent: { chat: string; text: string; sendId: string; origin: string }[] = []
  const opened: { message: string; origin: string }[] = []
  let fails = 0
  const deps: Replier = {
    rulesPath,
    statePath: join(root, "state.json"),
    provider: "chat",
    owner: { id: "me" },
    since: NOW - 3_600_000,
    allowed: () => allowed,
    chatOf: async (id) => ({ id, kind: "dialog" }),
    senderOf: async () => ({ isBot: false, isContact: true }),
    send: async (reply) => {
      if (reply.chat !== "c1") throw new Error("never anyone but the allowed chat")
      if (fails > 0) {
        fails -= 1
        throw new CliError("network_error", "dropped")
      }
      sent.push(reply)
    },
    newSendId: () => `send-${sent.length}`,
    ...(tasks
      ? {
          openTask: async (message: Message, origin: string) => {
            opened.push({ message: message.id, origin })
            return true
          },
        }
      : {}),
    now: () => NOW,
  }
  return { deps, sent, opened, failNext: (times: number) => (fails = times) }
}

describe("serve's reply rules", () => {
  it("never invokes the renderer outside the audience and send permission gates", async () => {
    for (const options of [
      { audience: { reply: "listed" } },
      { allowed: false },
      { audience: { deny: { people: ["friend"] } } },
    ]) {
      const { deps } = setUp(options)
      const render = vi.fn(async () => ({ text: "Hello", warnings: [], blocks: [] }))
      deps.render = render
      await replyTo(deps, said("gated"))
      expect(render).not.toHaveBeenCalled()
    }
  })
  it("opens tasks even if a template cannot render, and checks pause and rule changes before sending async output", async () => {
    const { deps, sent, opened } = setUp({ does: ["reply", "task"] })
    deps.render = async () => ({ text: null, warnings: [], blocks: [], reason: "no model and no fallback" })
    expect(await replyTo(deps, said("failed"))).toEqual({ skip: "no model and no fallback", task: "away" })
    expect(opened).toHaveLength(1)
    deps.render = async () => {
      writeRepliesState(deps.statePath, paused(readRepliesState(deps.statePath), true))
      return { text: "Hello", warnings: [], blocks: [] }
    }
    expect(await replyTo(deps, said("paused"))).toMatchObject({
      skip: "replies paused or permission revoked during rendering",
    })
    expect(sent).toHaveLength(0)
    writeRepliesState(deps.statePath, paused(readRepliesState(deps.statePath), false))
    deps.render = async () => {
      writeFileSync(deps.rulesPath, JSON.stringify({ rules: [] }))
      return { text: "Hello", warnings: [], blocks: [] }
    }
    expect(await replyTo(deps, said("changed"))).toMatchObject({
      skip: "reply rule or audience changed during rendering",
    })
    expect(sent).toHaveLength(0)
  })
  it("**answers an allowed person once, and nobody else at all**", async () => {
    const { deps, sent } = setUp()

    const stranger = await replyTo(deps, said("1", { senderId: "real-person" }))
    const friend = await replyTo(deps, said("2"))
    const again = await replyTo(deps, said("2"))

    expect(stranger).toEqual({ skip: "not on the allow list" })
    expect(friend).toEqual({ sent: "away" })
    expect(again).toEqual({ skip: "already answered" })
    expect(sent).toEqual([{ chat: "c1", text: "Thanks, Ana.", replyTo: "2", sendId: "send-0", origin: "rule:away" }])
  })

  it("answers anyone a rule matches from a file that names no audience", async () => {
    const { deps, sent } = setUp()
    const rules = JSON.parse(readFileSync(deps.rulesPath, "utf8")).rules
    writeFileSync(deps.rulesPath, JSON.stringify({ rules }))

    expect(await replyTo(deps, said("1", { senderId: "someone" }))).toEqual({ sent: "away" })
    expect(sent).toHaveLength(1)
  })

  it("**answers an older file's testers exactly as before, and nobody else**", async () => {
    const everyone = { reply: "all", allow: { people: [], chats: ["c1"] } }
    const open = setUp({ audience: everyone, testers: [{ id: "friend" }, { id: "other", provider: "max" }] })
    const none = setUp({ audience: everyone, testers: [] })
    const narrowed = setUp({
      audience: { reply: "listed", allow: { people: ["someone"] } },
      testers: [{ id: "friend" }],
    })

    expect(await replyTo(open.deps, said("1"))).toEqual({ sent: "away" })
    expect(await replyTo(open.deps, said("2", { senderId: "someone" }))).toEqual({ skip: "not on the allow list" })
    expect(await replyTo(open.deps, said("3", { senderId: "other" }))).toEqual({ skip: "not on the allow list" })
    expect(await replyTo(none.deps, said("1"))).toEqual({ skip: "not on the allow list" })
    expect(await replyTo(narrowed.deps, said("1"))).toEqual({ skip: "not on the allow list" })
    expect(await replyTo(narrowed.deps, said("2", { senderId: "someone" }))).toEqual({ skip: "not on the allow list" })
    expect(open.sent).toHaveLength(1)
  })

  it("sends nothing unless replies.send is allow", async () => {
    const { deps, sent } = setUp({ allowed: false })

    expect(await replyTo(deps, said("1"))).toEqual({ skip: NOT_ALLOWED })
    expect(sent).toEqual([])
  })

  it("stops at once when paused, without a restart", async () => {
    const { deps, sent } = setUp()

    await replyTo(deps, said("1"))
    writeRepliesState(deps.statePath, paused(readRepliesState(deps.statePath), true))
    const after = await replyTo(deps, said("2"))

    expect(after).toEqual({ skip: "replies are paused" })
    expect(sent).toHaveLength(1)
  })

  it("leaves what came in before serve started", async () => {
    const { deps, sent } = setUp()

    const old = await replyTo(deps, said("1", { timestamp: new Date(deps.since - 1).toISOString() }))

    expect(old).toEqual({ skip: "older than the catch-up start" })
    expect(sent).toEqual([])
  })

  it("tries a failed send once more with the same send id", async () => {
    const { deps, sent, failNext } = setUp()
    failNext(1)

    expect(await replyTo(deps, said("1"))).toEqual({ sent: "away" })
    expect(sent.map((one) => one.sendId)).toEqual(["send-0"])
  })

  it("stops two auto-repliers answering each other at the first limit", async () => {
    const { deps, sent } = setUp({ perChat: "1/1h" })

    await replyTo(deps, said("1"))
    const echo = await replyTo(deps, said("2", { text: "Thanks — auto-reply" }))

    expect(echo).toEqual({ skip: "the chat's limit is reached" })
    expect(sent).toHaveLength(1)
  })

  it("**opens a task for anyone a rule matches**, and sends nothing without replies.send", async () => {
    const { deps, sent, opened } = setUp({ does: ["reply", "task"], allowed: false })

    const stranger = await replyTo(deps, said("m1", { senderId: "someone" }))
    const friend = await replyTo(deps, said("m2"))

    expect(stranger).toEqual({ skip: ONLY_TASK, task: "away" })
    expect(friend).toEqual({ skip: NOT_ALLOWED, task: "away" })
    expect(opened).toEqual([
      { message: "m1", origin: "rule:away" },
      { message: "m2", origin: "rule:away" },
    ])
    expect(sent).toEqual([])
  })

  it("answers and opens a task in one go, and still answers where tasks cannot open", async () => {
    const both = setUp({ does: ["reply", "task"] })
    const noTasks = setUp({ does: ["reply", "task"], tasks: false })
    const onlyTask = setUp({ does: ["task"], tasks: false })

    expect(await replyTo(both.deps, said("m1"))).toEqual({ sent: "away", task: "away" })
    expect(await replyTo(noTasks.deps, said("m1"))).toEqual({ sent: "away" })
    expect(await replyTo(onlyTask.deps, said("m1"))).toEqual({ skip: NO_TASKS })
    expect(both.sent).toHaveLength(1)
  })

  it("opens one task per message, however many times it arrives", async () => {
    const { deps, opened } = setUp({ does: ["task"] })

    await replyTo(deps, said("m1", { senderId: "someone" }))
    const again = await replyTo(deps, said("m1", { senderId: "someone" }))

    expect(again).toEqual({ skip: "already answered" })
    expect(opened).toHaveLength(1)
  })

  it("**answers by the audience in every mode**", async () => {
    const everyone = setUp({ audience: { reply: "all" } })
    const listedIn = setUp()
    const listedChat = setUp({ audience: { reply: "listed", allow: { chats: ["c1"] } } })
    const listedOut = setUp({ audience: { reply: "listed", allow: { chats: ["other"] } } })
    const denied = setUp({ audience: { reply: "all", deny: { people: ["friend"] } } })
    const deniedChat = setUp({ audience: { reply: "all", deny: { chats: ["c1"] } } })
    const conflict = setUp({
      audience: { reply: "listed", allow: { people: ["friend"] }, deny: { people: ["friend"] } },
    })

    expect(await replyTo(everyone.deps, said("m1"))).toEqual({ sent: "away" })
    expect(await replyTo(listedIn.deps, said("m1"))).toEqual({ sent: "away" })
    expect(await replyTo(listedChat.deps, said("m1", { senderId: "someone" }))).toEqual({ sent: "away" })
    expect(await replyTo(listedOut.deps, said("m1"))).toEqual({ skip: "not on the allow list" })
    expect(await replyTo(denied.deps, said("m1"))).toEqual({ skip: "a person on the deny list" })
    expect(await replyTo(deniedChat.deps, said("m1"))).toEqual({ skip: "a chat on the deny list" })
    expect(await replyTo(conflict.deps, said("m1"))).toEqual({ skip: "a person on the deny list" })
    expect(await replyTo(listedIn.deps, said("m2", { senderId: "someone" }))).toEqual({ skip: "not on the allow list" })
  })

  it("opens a task for someone the audience will not answer", async () => {
    const { deps, sent, opened } = setUp({
      does: ["reply", "task"],
      audience: { reply: "all", deny: { people: ["friend"] } },
    })

    expect(await replyTo(deps, said("m1"))).toEqual({ skip: ONLY_TASK, task: "away" })
    expect(opened).toHaveLength(1)
    expect(sent).toEqual([])
  })
})
