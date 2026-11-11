import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openAnalysis } from "../analysis/provider.js"
import { gatewayOcr } from "../attachments/gateway-ocr.js"
import { analysisChoice } from "../cli/analysis-choice.js"
import type { Body } from "../cli/envelope.js"
import { localOnlyCommand } from "../cli/local-only-command.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { Settings } from "../cli/settings.js"
import type { Message } from "../domain/models.js"
import { openRemote, remoteModel } from "../embeddings/remote.js"
import { replyConsentPathFor, replyModelIdentity, writeReplyConsent } from "../replies/consents.js"
import { replyRenderer } from "../replies/rendering.js"
import { defaultRule, parseReplyRules, type ReplyRule } from "../replies/rules.js"
import { choose } from "../speech/transcribe.js"
import { aiKeys, aiNeedsKey, aiSettingOf, aiSettingPath, aiTextReader, writeAiSetting } from "./ai.js"
import { modelGateway } from "./index.js"
import { localOnly, writeLocalOnly } from "./local-only.js"
import { purposeModel } from "./purpose.js"

afterEach(() => vi.unstubAllGlobals())

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1" }
const REMOTE_HTTP = "http://192.0.2.10:11434/v1"
const HOSTED = "https://models.example.test/v1"
const LOCAL = "http://127.0.0.1:11434/v1"
const PIXEL = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" }

const machine = () => {
  const root = mkdtempSync(join(tmpdir(), "local-only-"))
  return {
    WIRECAT_STATE_DIR: root,
    WIRECAT_CONFIG_DIR: join(root, "wirecat"),
    MESSAGING_STORE: join(root, "store.db"),
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
  } as NodeJS.ProcessEnv
}

const chatAnswer = () =>
  new Response(
    JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "OK" } }], usage: { total_tokens: 3 } }),
  )

const settingsWith = (purpose: string, baseUrl: string) =>
  ({ models: { [purpose]: { provider: "openai", model: "synthetic", base_url: baseUrl } } }) as unknown as Settings

const call = (env: NodeJS.ProcessEnv, baseUrl: string, fetch: typeof globalThis.fetch) =>
  modelGateway({
    resolve: () => ({ provider: "openai", model: "synthetic", baseUrl }),
    consent: () => true,
    env,
    fetch,
  }).complete({ purpose: "check", prompt: "OK?", maxTokens: 10 })

describe("plain http only on this computer (SEC-184)", () => {
  it("the gateway refuses plain http to another computer before anything is sent", async () => {
    const fetch = vi.fn(async () => chatAnswer())
    await expect(call(machine(), REMOTE_HTTP, fetch)).rejects.toMatchObject({
      details: { reason: "model.address-refused" },
    })
    await call(machine(), LOCAL, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("chat linking refuses it when chosen and when called", async () => {
    const env = machine()
    expect(() =>
      analysisChoice(
        { analysisProvider: "openai", model: "synthetic", baseUrl: REMOTE_HTTP },
        app,
        {} as Settings,
        env,
      ),
    ).toThrow("not allowed")
    const fetch = vi.fn(async () => chatAnswer())
    vi.stubGlobal("fetch", fetch)
    await expect(
      openAnalysis({ provider: "openai", model: "synthetic", baseUrl: REMOTE_HTTP }, undefined, env)("s", "i", 10),
    ).rejects.toMatchObject({ details: { reason: "model.address-refused" } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reply drafts send nothing to it, even with the profile's consent", async () => {
    const env = machine()
    writeReplyConsent(replyConsentPathFor(app, "default", env), {
      provider: replyModelIdentity("openai", REMOTE_HTTP),
      deniedChats: [],
    })
    const fetch = vi.fn(async () => chatAnswer())
    vi.stubGlobal("fetch", fetch)
    const rule = parseReplyRules(
      {
        rules: [
          {
            ...defaultRule("away"),
            on: true,
            reply: { template: "{% ai %}Greet{% else %}Later{% endai %}", asReply: true },
          },
        ],
      },
      "rules.json",
    )[0] as ReplyRule
    const render = replyRenderer(app, "default", () => settingsWith("replies", REMOTE_HTTP), env, vi.fn(), {
      ai: true,
      keyring: memoryKeyring(),
    })
    const message = { id: "1", chatId: "11", senderId: "12", senderName: "Ana", text: "synthetic" } as Message
    expect((await render(rule, message, { id: "11", kind: "dialog" }, Date.now())).text).toBe("Later")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("attachment OCR sends no picture to it", async () => {
    const fetch = vi.fn(async () => chatAnswer())
    const ocr = gatewayOcr({
      app,
      settings: settingsWith("ocr", REMOTE_HTTP),
      env: machine(),
      keyring: memoryKeyring(),
      enabled: true,
      fetch,
    })
    await expect(ocr.transcribe(PIXEL)).rejects.toMatchObject({ details: { reason: "model.address-refused" } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("remote embeddings refuse it", () => {
    const remote = remoteModel({ model: "synthetic", baseUrl: REMOTE_HTTP, dims: 4 })
    expect(() => openRemote(remote, undefined, { env: machine() })).toThrow("not allowed")
  })
})

describe("local only", () => {
  it("is off until the owner turns it on", () => {
    const env = machine()
    expect(localOnly(env)).toBe(false)
    writeLocalOnly(env, true)
    expect(localOnly(env)).toBe(true)
  })

  it("refuses a hosted address in the gateway and lets this computer through", async () => {
    const env = machine()
    writeLocalOnly(env, true)
    const fetch = vi.fn(async () => chatAnswer())
    await expect(call(env, HOSTED, fetch)).rejects.toMatchObject({ details: { reason: "local-only.refused" } })
    await call(env, LOCAL, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("refuses OpenAI and the messenger for voice messages", () => {
    const env = machine()
    writeLocalOnly(env, true)
    const messenger = { app: { command: "chat", appName: "chat", envPrefix: "CHAT" }, provider: "chat" } as Messenger
    const none = { configured: {}, shared: {} }
    for (const given of ["openai", "messenger"] as const)
      expect(choose(messenger, none, { with: given }, env).refusal).toMatchObject({
        details: { reason: "local-only.refused" },
      })
    expect(choose(messenger, none, {}, env)).toMatchObject({ with: "auto", localOnly: true })
    expect(choose(messenger, none, {}, env).refusal).toBeUndefined()
  })

  it("refuses a hosted AI model when it is chosen", async () => {
    const env = machine()
    writeLocalOnly(env, true)
    const fetch = vi.fn(async () => chatAnswer())
    writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "openai", model: "synthetic", baseUrl: HOSTED }))
    const keyring = memoryKeyring()
    aiKeys(app, env, keyring).write("https://models.example.test", "synthetic-key")
    const reader = aiTextReader({ app, env, keyring, fetch })
    if ("refused" in reader) throw new Error("no reader")
    await expect(reader.complete({ purpose: "check", system: "", prompt: "OK?", maxTokens: 10 })).rejects.toMatchObject(
      { details: { reason: "local-only.refused" } },
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  const command = (env: NodeJS.ProcessEnv) => {
    const answers: Body[] = []
    const run = (...words: string[]) =>
      new Command("chat")
        .addCommand(
          localOnlyCommand(app, { env: () => env, output: (body) => answers.push(body), diagnostic: () => {} }),
        )
        .parseAsync(["local-only", ...words], { from: "user" })
    const last = () => (answers.at(-1) as { item: Record<string, unknown> }).item
    return { run, last }
  }

  it("`models local-only` turns it on and lists where each feature sends data", async () => {
    const env = machine()
    writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "openai", model: "synthetic", baseUrl: HOSTED }))
    const { run, last } = command(env)
    await run("show")
    expect(last()).toMatchObject({ on: false })
    await run("set", "on")
    expect(last()).toMatchObject({ on: true, changed: true })
    const features = last().features as { id: string; where: string; refused: boolean }[]
    expect(features.find((one) => one.id === "ai_model")).toMatchObject({ where: "elsewhere", refused: true })
    expect(features.find((one) => one.id === "voice_messages")).toMatchObject({ where: "this-computer" })
    expect(features.find((one) => one.id === "digest")).toMatchObject({ where: "agent", refused: false })
  })

  it("an agent may turn it on but not off", async () => {
    const env = { ...machine(), AI_AGENT: "synthetic-agent" }
    const { run } = command(env)
    await run("set", "on")
    await expect(run("set", "off")).rejects.toMatchObject({ details: { reason: "local-only.owner-only" } })
    expect(localOnly(env)).toBe(true)
  })
})

describe("the shared AI model", () => {
  it("an OpenAI-compatible server on this computer needs no key", () => {
    expect(aiNeedsKey(aiSettingOf({ provider: "openai", model: "synthetic", baseUrl: LOCAL }))).toBe(false)
    expect(aiNeedsKey(aiSettingOf({ provider: "openai", model: "synthetic", baseUrl: HOSTED }))).toBe(true)
    const env = machine()
    writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "openai", model: "synthetic", baseUrl: LOCAL }))
    expect("refused" in aiTextReader({ app, env, keyring: memoryKeyring() })).toBe(false)
  })

  it("serves chat linking, replies and OCR when they have no model of their own, and never replaces off", () => {
    const env = machine()
    writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "ollama", model: "synthetic" }))
    const deps = { app, env, keyring: memoryKeyring() }
    for (const purpose of ["analysis", "replies", "ocr"])
      expect(purposeModel({}, purpose, deps)).toMatchObject({ target: { provider: "openai", baseUrl: LOCAL } })
    expect(analysisChoice({}, app, {} as Settings, env, deps.keyring)).toMatchObject({ baseUrl: LOCAL })
    expect(purposeModel({ models: { replies: { provider: "off" } } }, "replies", deps)).toBeUndefined()
    expect(purposeModel(settingsWith("ocr", HOSTED), "ocr", deps)?.target.baseUrl).toBe(HOSTED)
  })
})
