import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { Chat } from "../../domain/models.js"
import type { HistoryBatch, MessengerAdapter } from "../../ports/messenger.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import type { Messenger } from "./context.js"

const rekeys = vi.hoisted(() => {
  let taken = 0
  let allTaken: () => void = () => {}
  return {
    lockWaits: [] as number[],
    done: new Promise<void>((resolve) => {
      allTaken = resolve
    }),
    took: (count: number) => {
      taken += count
      if (taken >= 3) allTaken()
    },
  }
})

vi.mock("../../store/sqlite/chat-rekey.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/sqlite/chat-rekey.js")>()
  return {
    ...actual,
    rekeyChats: (...args: Parameters<typeof actual.rekeyChats>) => {
      rekeys.lockWaits.push(args[4])
      const pass = actual.rekeyChats(...args)
      rekeys.took(pass.taken)
      return pass
    },
  }
})

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "connection-waits-"))
  return {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

describe("a command run with the connection waits in its environment", () => {
  it("closes on a hung history listen within the short wait, still warning, and paces re-keys as handed in", async () => {
    const listenHistory = vi.fn((onBatch: (batch: HistoryBatch) => void) => {
      onBatch({ chats: ["1", "2", "3"].map((id) => ({ id, title: `Chat ${id}`, kind: "group" }) as Chat) })
      onBatch({ rekeys: ["1", "2", "3"].map((id) => ({ from: id, to: `${id}@lid` })) })
      return new Promise<void>(() => {})
    })
    const adapter = {
      self: () => "500",
      me: async () => {
        await rekeys.done
        return { id: "500", name: "Me", username: null, phone: null }
      },
      listenHistory,
      close: async () => {},
    } as unknown as MessengerAdapter
    const messenger: Messenger = {
      app,
      provider: "chat",
      history: "store",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: async () => adapter,
      chatArgument: "a chat",
      accountOf: () => ({ provider: "chat", account: "500" }),
    }
    const streams = captureStreams()
    const started = performance.now()

    const code = await run(
      ["account", "show", "--json"],
      { app, commands: () => [accountCommand(messenger)] },
      { streams, tty: false, env: sandbox(), closeWaitMs: 10, rekeyPacing: { lockMs: 0, pauseMs: 0 } },
    )

    expect(code).toBe(0)
    expect(listenHistory).toHaveBeenCalledOnce()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(streams.stderr.join("\n")).toContain("still handing on history batches at exit")
    expect(rekeys.lockWaits).toEqual([0, 0, 0])
  })
})
