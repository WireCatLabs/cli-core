import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { chatSendingCommand } from "../cli/chat-sending-command.js"
import type { Body } from "../cli/envelope.js"
import { storePath } from "../store/path.js"
import { sharedConfigPath } from "../store/shared-config.js"
import { chatSendingAllowed, chatSendingMode } from "./chat-sending.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1" }

const machine = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const root = mkdtempSync(join(tmpdir(), "chat-sending-"))
  return { WIRECAT_CONFIG_DIR: join(root, "wirecat"), MESSAGING_STORE: join(root, "store.db"), ...extra }
}

const command = (env: NodeJS.ProcessEnv) => {
  const answers: Body[] = []
  const run = (...words: string[]) =>
    new Command("chat")
      .addCommand(chatSendingCommand(app, { env: () => env, output: (body) => answers.push(body) }))
      .parseAsync(["chats", ...words], { from: "user" })
  const last = () => (answers.at(-1) as { item: Record<string, unknown> }).item
  return { run, last }
}

describe("`models chats`", () => {
  it("is ask until the owner sets it, and allowed or denied after", async () => {
    const env = machine()
    const { run, last } = command(env)
    await run("show")
    expect(last()).toMatchObject({ mode: "ask", since: null })
    await run("set", "allowed")
    expect(last()).toMatchObject({ mode: "allowed", changed: true })
    expect(chatSendingAllowed(env, "api.openai.com", "chat")).toBe(true)
    await run("set", "denied")
    expect(() => chatSendingAllowed(env, "api.openai.com", "chat")).toThrow(/chat models chats set ask/)
    await expect(run("set", "sometimes")).rejects.toMatchObject({ code: "validation_error" })
  })

  it("an agent may make it stricter, never looser, unless WireCat Desktop sets it", async () => {
    const env = machine({ AI_AGENT: "synthetic-agent" })
    const { run } = command(env)
    await run("set", "denied")
    await expect(run("set", "ask")).rejects.toMatchObject({ details: { reason: "chat-sending.owner-only" } })
    await expect(run("set", "allowed")).rejects.toMatchObject({ details: { reason: "chat-sending.owner-only" } })
    expect(chatSendingMode(env)).toBe("denied")
    await run("set", "allowed", "--from-app")
    expect(chatSendingMode(env)).toBe("allowed")
  })

  it("a broken setting reads as denied: a typo must not let chat text out", () => {
    const env = machine()
    const path = sharedConfigPath(storePath(env), env)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ chat_sending: { mode: "allow" } }))
    expect(chatSendingMode(env)).toBe("denied")
  })
})
