import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { rememberAccount } from "../cli/messenger/accounts.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { MessengerAdapter, Transcript } from "../ports/messenger.js"
import { hearVoices, isVoice, type Kept, keyOf, openKept, spoken, withTranscript } from "./hearing.js"
import { speechModel } from "./models.js"

const messenger = {
  app: { command: "chat", appName: "chat-cli", envPrefix: "CHAT" },
  provider: "chat",
} as unknown as Messenger

const voice = (id: string): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-29T10:00:00.000Z",
  editedAt: null,
  text: "",
  outgoing: false,
  attachments: [{ kind: "voice", mime: "audio/ogg", duration: 3 }],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const memory = (): Kept & { rows: Map<string, string> } => {
  const rows = new Map<string, string>()
  return {
    rows,
    get: async (one) => {
      const text = rows.get(keyOf(one))
      return text === undefined ? undefined : { text, source: "memory" }
    },
    keep: async (one, text) => {
      if (text.trim() !== "") rows.set(keyOf(one), text)
    },
    close: async () => {},
  }
}

const telegram = (answer: (id: string) => Transcript | Error) =>
  ({
    transcribe: async (_chat: string, id: string) => {
      const found = answer(id)
      if (found instanceof Error) throw found
      return found
    },
  }) as unknown as MessengerAdapter

const choice = {
  with: "messenger" as const,
  model: speechModel("parakeet-v3"),
  directory: mkdtempSync(join(tmpdir(), "models-")),
}

describe("hearing voice messages in a list", () => {
  it("**shows a kept transcript without asking anyone**", async () => {
    const kept = memory()
    kept.keep({ chatId: "7", messageId: "1" }, "kept before", "telegram")

    const hearing = await hearVoices(messenger, [voice("1"), voice("2")], kept)

    expect(hearing).toEqual({
      transcripts: new Map([["7/1", "kept before"]]),
      unheard: [{ chatId: "7", messageId: "2" }],
    })
  })

  it("**hears the rest with --transcribe and keeps only finished text**; pending and refused ones are unheard", async () => {
    const kept = memory()
    const adapter = telegram((id) =>
      id === "1"
        ? { text: "hello", pending: false }
        : id === "2"
          ? { text: "", pending: true }
          : new CliError("provider_error", "no voice"),
    )

    const hearing = await hearVoices(messenger, [voice("1"), voice("2"), voice("3")], kept, {
      choice,
      connect: (work) => work(adapter),
    })

    expect(hearing.transcripts.get("7/1")).toBe("hello")
    expect(hearing.unheard).toEqual([
      { chatId: "7", messageId: "2" },
      { chatId: "7", messageId: "3" },
    ])
    expect(hearing.problem).toBe("no voice")
    expect([...kept.rows.keys()]).toEqual(["7/1"])
  })

  it("**shows a kept transcript of an audio file, but never hears one with --transcribe**", async () => {
    const kept = memory()
    const audio = (id: string): Message => ({ ...voice(id), attachments: [{ kind: "audio", mime: "audio/mp4" }] })
    kept.keep({ chatId: "7", messageId: "1" }, "heard with messages transcribe", "parakeet-v3")
    const adapter = telegram(() => new CliError("provider_error", "asked"))

    const hearing = await hearVoices(messenger, [audio("1"), audio("2")], kept, {
      choice,
      connect: (work) => work(adapter),
    })

    expect(hearing).toEqual({ transcripts: new Map([["7/1", "heard with messages transcribe"]]), unheard: [] })
  })

  it("stops asking when the time is up, and says what is left", async () => {
    const hearing = await hearVoices(messenger, [voice("1")], memory(), {
      choice,
      connect: (work) => work(telegram(() => ({ text: "late", pending: false }))),
      budgetMs: 0,
    })

    expect(hearing.unheard).toEqual([{ chatId: "7", messageId: "1" }])
  })

  it("puts the transcript beside the text for a script, and under it for a person", () => {
    const hearing = { transcripts: new Map([["7/1", "hello"]]), unheard: [] }

    expect(withTranscript(voice("1"), hearing)).toMatchObject({ text: "", transcript: "hello" })
    expect(spoken(withTranscript({ ...voice("1"), text: "listen" }, hearing)).text).toBe("listen\n🎤 hello")
    expect(isVoice({ ...voice("1"), attachments: [{ kind: "photo" }] })).toBe(false)
  })

  it("**keeps transcripts in the shared store, for the account the profile logged in as**", async () => {
    const root = mkdtempSync(join(tmpdir(), "kept-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "messages.db") }
    rememberAccount(messenger.app, "work", "100", env)
    rememberAccount(messenger.app, "home", "200", env)
    const kept = await openKept(messenger, "work", env)
    await kept.keep({ chatId: "7", messageId: "1" }, "hello", "gigaam-v3")
    await kept.keep({ chatId: "7", messageId: "2" }, "  ", "telegram")
    await kept.close()

    const again = await openKept(messenger, "work", env)
    expect(await again.get({ chatId: "7", messageId: "1" })).toEqual({ text: "hello", source: "gigaam-v3" })
    expect(await again.get({ chatId: "7", messageId: "2" })).toBeUndefined()
    await again.close()
    const other = await openKept(messenger, "home", env)
    expect(await other.get({ chatId: "7", messageId: "1" })).toBeUndefined()
    await other.close()
  })

  it("keeps nothing for a profile that has never been online, so the message is heard again", async () => {
    const root = mkdtempSync(join(tmpdir(), "kept-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "messages.db") }
    const kept = await openKept(messenger, "new", env)
    await kept.keep({ chatId: "7", messageId: "1" }, "hello", "gigaam-v3")

    expect(await kept.get({ chatId: "7", messageId: "1" })).toBeUndefined()
    await kept.close()
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })
})
