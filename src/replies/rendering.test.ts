import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Message } from "../domain/models.js"
import type { ModelSettings } from "../models/index.js"
import { mayModelReply, replyConsentPathFor, writeReplyConsent } from "./consents.js"
import { replyRenderer } from "./rendering.js"
import { defaultRule, parseReplyRules, type ReplyRule } from "./rules.js"

afterEach(() => vi.unstubAllGlobals())
const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1" }
const message = { id: "1", chatId: "11", senderId: "12", senderName: "Ana", text: "Synthetic incoming data" } as Message
const rule = parseReplyRules(
  {
    rules: [
      {
        ...defaultRule("away"),
        on: true,
        reply: { template: "{% ai %}Greet {{ sender.firstName }}{% else %}Later{% endai %}", asReply: true },
      },
    ],
  },
  "rules.json",
)[0] as ReplyRule
const identity = "openai:https://example.test/v1"

describe("profile reply rendering", () => {
  it("requires purpose configuration and profile consent before any request, then honors opt-outs and revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "reply-rendering-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    const path = replyConsentPathFor(app, "default", env)
    let models: ModelSettings = {}
    const warn = vi.fn()
    const rendering = replyRenderer(app, "default", () => ({ models }), env, warn, {
      ai: true,
      keyring: memoryKeyring(),
    })
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "Hello Ana" } }],
            usage: { total_tokens: 3 },
          }),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    const render = () => rendering(rule, message, { id: "11", kind: "dialog" }, Date.now())
    expect((await render()).text).toBe("Later")
    models = { replies: { provider: "openai", model: "test-model", base_url: "https://example.test/v1" } }
    expect((await render()).text).toBe("Later")
    expect(fetcher).not.toHaveBeenCalled()
    writeReplyConsent(path, { provider: identity, deniedChats: [] })
    expect((await render()).text).toBe("Hello Ana")
    expect(fetcher).toHaveBeenCalledTimes(1)
    writeReplyConsent(path, { provider: identity, deniedChats: ["11"] })
    expect((await render()).text).toBe("Later")
    expect(fetcher).toHaveBeenCalledTimes(1)
    writeReplyConsent(path, { provider: null, deniedChats: [] })
    expect((await render()).text).toBe("Later")
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mayModelReply(path, identity, "11")).toBe(false)
  })

  it("rechecks consent and target after a request; previews never call and legacy syntax warns", async () => {
    const root = mkdtempSync(join(tmpdir(), "reply-rendering-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    const path = replyConsentPathFor(app, "default", env)
    let models: ModelSettings = {
      replies: { provider: "openai", model: "test-model", base_url: "https://example.test/v1" },
    }
    writeReplyConsent(path, { provider: identity, deniedChats: [] })
    const fetcher = vi.fn(async () => {
      writeReplyConsent(path, { provider: null, deniedChats: [] })
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "Hello Ana" } }],
          usage: { total_tokens: 3 },
        }),
      )
    })
    vi.stubGlobal("fetch", fetcher)
    const rendering = replyRenderer(app, "default", () => ({ models }), env, vi.fn(), {
      ai: true,
      keyring: memoryKeyring(),
    })
    expect((await rendering(rule, message, { id: "11", kind: "dialog" }, Date.now())).text).toBe("Later")
    writeReplyConsent(path, { provider: identity, deniedChats: [] })
    fetcher.mockImplementation(async () => {
      models = { replies: { provider: "off" } }
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "Hello Ana" } }],
          usage: { total_tokens: 3 },
        }),
      )
    })
    expect((await rendering(rule, message, { id: "11", kind: "dialog" }, Date.now())).text).toBe("Later")
    const warn = vi.fn()
    const preview = replyRenderer(app, "default", () => ({ models }), env, warn, {
      preview: true,
      keyring: memoryKeyring(),
    })
    const legacy = { ...rule, reply: { ...rule.reply, template: "Hi {firstName}", model: "may-reword" as const } }
    expect((await preview(legacy, message, { id: "11", kind: "dialog" }, Date.now())).text).toBe("Hi Ana")
    expect(warn).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
