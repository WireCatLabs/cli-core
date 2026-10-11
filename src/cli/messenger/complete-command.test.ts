import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { type CompletionOptions, completeCommand } from "./complete-command.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1" }
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "complete-"))
  const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "messages.db") }
  const connect = vi.fn(async (): Promise<never> => {
    throw new Error("completion must not connect")
  })
  const messenger: Messenger = {
    app,
    provider: "chat",
    chatArgument: "a chat",
    connect,
    resolveSettings: settingsFor(app).resolveSettings,
    partnerOf: (chat) =>
      typeof chat.providerMetadata?.partnerId === "string" ? chat.providerMetadata.partnerId : undefined,
  }
  const call = async (words: string[], options: CompletionOptions = {}) => {
    const streams = captureStreams()
    const code = await run(
      ["complete", "--", ...words],
      {
        app,
        commands: () => [
          completeCommand(messenger, { configuredProfiles: () => ["home"] }, options),
          new Command("contacts").addCommand(new Command("show").argument("<person>")),
          new Command("messages").addCommand(new Command("list").argument("<chat>")),
        ],
      },
      { env, streams },
    )
    expect(code).toBe(0)
    expect(streams.stderr).toEqual([])
    expect(connect).not.toHaveBeenCalled()
    return streams.stdout.join("\n")
  }
  return { env, call }
}

describe("local completion", () => {
  it("uses stored person ids rather than dialog ids, scoped to the recalled account", async () => {
    const { env, call } = setup()
    rememberAccount(app, "home", "500", env)
    const store = await openStore({ env })
    try {
      await store.savePeople({ provider: "chat", account: "500" }, [{ id: "7", name: "Friend" }])
      await store.savePeople({ provider: "chat", account: "600" }, [{ id: "8", name: "Other account" }])
      await store.saveChats({ provider: "chat", account: "500" }, [
        { id: "101", title: "Dialog", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
      ])
    } finally {
      await store.close()
    }
    expect(await call(["home", "contacts", "show", ""])).toBe("7\tFriend\n:4")
    expect(await call(["home", "messages", "list", ""])).toBe("101\tDialog\n:4")
  })

  it("takes the consumer's account over a stale shared pointer without creating state", async () => {
    const { env, call } = setup()
    rememberAccount(app, "home", "600", env)
    const store = await openStore({ env })
    try {
      await store.savePeople({ provider: "chat", account: "500" }, [{ id: "7", name: "Friend" }])
      await store.savePeople({ provider: "chat", account: "600" }, [{ id: "8", name: "Stale account" }])
    } finally {
      await store.close()
    }
    expect(await call(["home", "contacts", "show", ""], { account: () => "500" })).toBe("7\tFriend\n:4")
    expect(await call(["home", "contacts", "show", ""], { account: () => undefined })).toBe(":4")
  })

  it("takes custom sources before opening a personal store and keeps profile completion", async () => {
    const { env, call } = setup()
    rememberAccount(app, "home", "500", env)
    expect(
      await call(["home", "messages", "list", ""], {
        sources: () => ({ arguments: { chat: () => [{ value: "-900", description: "Bot group" }] } }),
      }),
    ).toBe("-900\tBot group\n:4")
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
    expect(await call([""])).toContain("home")
  })

  it("does not create a store for a profile without an account", async () => {
    const { env, call } = setup()
    expect(await call(["home", "messages", "list", ""])).toBe(":4")
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })
})
