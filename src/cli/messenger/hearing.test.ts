import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { inboxCommand } from "./inbox.js"
import { messagesCommand } from "./messages-command.js"
import { reviewCommand } from "./review.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1.0.0" }
const question = "Can we meet tomorrow?"
const voice = (id = "1"): Message => ({
  id,
  chatId: "9",
  senderId: "2",
  senderName: null,
  timestamp: new Date(Date.now() - 3_600_000).toISOString(),
  editedAt: null,
  text: "",
  outgoing: false,
  attachments: [{ kind: "voice", mime: "audio/ogg" }],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const fixture = (
  messages = [voice()],
  { pending = false, answered = false, failure = false, closeFails = false } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "hearing-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "messages.db"),
  }
  const chat: Chat = {
    id: "9",
    title: "Synthetic group",
    kind: "group",
    unreadCount: 1,
    lastMessageAt: messages.at(-1)?.timestamp ?? null,
    participantsCount: 3,
  }
  const events: string[] = []
  const adapter = (): MessengerAdapter => {
    let closed = false
    const check = () => {
      if (closed) throw new Error("read after close")
    }
    return {
      self: () => "500",
      me: async () => ({ id: "500", name: "Owner", username: null }),
      resolve: async () => {
        check()
        return chat
      },
      chats: async () => {
        check()
        return { items: [chat], hasMore: false }
      },
      history: async () => {
        check()
        return { items: messages, hasMore: false }
      },
      admins: async () => {
        check()
        events.push("admins")
        return answered ? ["7"] : []
      },
      chat: async () => ({ ...chat, members: [] }),
      send: async () => {
        throw new Error("hearing never sends")
      },
      logout: async () => {},
      markRead: async () => {
        check()
        events.push("mark-read")
      },
      transcribe: async () => {
        check()
        events.push("transcribe")
        if (failure) throw new Error("synthetic hearing failed")
        return { text: pending ? "" : question, pending }
      },
      close: async () => {
        closed = true
        events.push("closed")
        if (closeFails) throw new Error("synthetic close failed")
      },
    }
  }
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    chatArgument: "a chat",
    connect: async () => {
      events.push("connect")
      return adapter()
    },
  }
  const execute = async (argv: string[]) => {
    const streams = captureStreams()
    const code = await run(
      [...argv, "--json", "--no-record"],
      { app, commands: () => [messagesCommand(messenger), inboxCommand(messenger), reviewCommand(messenger)] },
      { env, streams, tty: false },
    )
    return { code, body: JSON.parse(streams.stdout[0] ?? "null"), stderr: streams.stderr.join("\n") }
  }
  return { env, events, messenger, adapter, execute }
}

const review = ["review", "chat:9", "date>1d", "--unanswered", "1m"]

describe("read hearing lifecycle", () => {
  it.each([
    ["messages", "list", "9"],
    ["inbox", "date>1d"],
    ["review", "chat:9", "date>1d"],
  ])("uses one connection for %j and hearing", async (...argv) => {
    const test = fixture([voice("1"), voice("2")])
    const answer = await test.execute([...argv, "--transcribe"])
    expect(answer.code).toBe(0)
    expect(test.events.filter((event) => event === "connect")).toHaveLength(1)
    expect(test.events.filter((event) => event === "closed")).toHaveLength(1)
    expect(test.events.filter((event) => event === "transcribe")).toHaveLength(2)
  })

  it("hears a voice question before unanswered filtering", async () => {
    const test = fixture()
    const answer = await test.execute([...review, "--transcribe"])
    expect(answer.code).toBe(0)
    expect(answer.body.items).toMatchObject([{ text: "", transcript: question }])
    expect(test.events.indexOf("admins")).toBeLessThan(test.events.indexOf("transcribe"))
    expect(test.events.filter((event) => event === "connect")).toHaveLength(1)
  })

  it("uses a retained voice question without requesting transcription", async () => {
    const test = fixture()
    const store = await openStore({ env: test.env })
    try {
      await store.messages.keepTranscript({ provider: "chat", account: "500" }, "9", "1", question, "chat")
    } finally {
      await store.close()
    }
    const answer = await test.execute(review)
    expect(answer.code).toBe(0)
    expect(answer.body.items).toMatchObject([{ text: "", transcript: question }])
    expect(test.events).not.toContain("transcribe")
  })

  it("does not advance a complete review past an unheard voice question", async () => {
    const test = fixture([voice()], { pending: true })
    const answer = await test.execute([...review, "--transcribe"])
    expect(answer.code).toBe(0)
    expect(answer.body.missing).toContainEqual({
      field: "transcript",
      why: "1 voice message(s) not heard yet: 1",
      step: "messages.transcribe",
    })
  })

  it("names an unheard voice message as missing without --transcribe, and hears nothing", async () => {
    const test = fixture()
    const answer = await test.execute(["messages", "list", "9"])
    expect(answer.code).toBe(0)
    expect(test.events).not.toContain("transcribe")
    expect(answer.body.missing).toContainEqual({
      field: "transcript",
      why: "1 voice message(s) not heard: 1 — --transcribe hears them",
      step: "messages.transcribe",
    })
  })

  it("under --offline, --transcribe keeps stored transcripts, never connects, and names the command for the rest", async () => {
    const test = fixture([voice("1"), voice("2")])
    await test.execute(["messages", "list", "9"])
    const store = await openStore({ env: test.env })
    try {
      await store.messages.keepTranscript({ provider: "chat", account: "500" }, "9", "1", question, "chat")
    } finally {
      await store.close()
    }
    const before = test.events.length
    const answer = await test.execute(["messages", "list", "9", "--offline", "--transcribe"])
    expect(answer.code).toBe(0)
    expect(test.events.slice(before)).toEqual([])
    expect(answer.body.items.map((item: { id: string; transcript?: string }) => [item.id, item.transcript])).toEqual([
      ["1", question],
      ["2", undefined],
    ])
    expect(answer.body.missing).toEqual([
      {
        field: "transcript",
        why: "--offline reads only transcripts already stored; 1 voice message(s) have none: chat default messages transcribe 9 2",
        step: "messages.transcribe",
      },
    ])
  })

  it("excludes a voice question answered by an admin", async () => {
    const response = {
      ...voice("2"),
      senderId: "7",
      attachments: [],
      text: "Yes",
      timestamp: new Date(Date.now() - 1_800_000).toISOString(),
    }
    const test = fixture([voice(), response], { answered: true })
    const answer = await test.execute([...review, "--transcribe"])
    expect(answer.code).toBe(0)
    expect(test.events).toContain("transcribe")
    expect(answer.body.items).toEqual([])
  })

  it("hears without sending a read receipt", async () => {
    const test = fixture()
    const answer = await test.execute(["messages", "list", "9", "--transcribe"])
    expect(answer.code).toBe(0)
    expect(test.events).toEqual(["connect", "transcribe", "closed"])
    expect(answer.body.items.at(-1).id).toBe("1")
  })

  it("keeps a failed transcription incomplete and closes its connection", async () => {
    const test = fixture([voice()], { failure: true })
    const answer = await test.execute([...review, "--transcribe"])
    expect(answer.code).toBe(0)
    expect(answer.body.missing).toContainEqual({
      field: "transcript",
      why: "not transcribed: synthetic hearing failed",
      step: "messages.transcribe",
    })
    expect(test.events.filter((event) => event === "closed")).toHaveLength(1)
  })

  it("does not close the held connection twice when closing rejects", async () => {
    const test = fixture([voice()], { closeFails: true })
    const answer = await test.execute(["messages", "list", "9", "--transcribe"])
    expect(answer.code).not.toBe(0)
    expect(test.events.filter((event) => event === "closed")).toHaveLength(1)
  })
})
