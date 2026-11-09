import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { memoryKeyring } from "@wirecat/cli-base"
import { Command } from "commander"
import { PNG } from "pngjs"
import { describe, expect, it, vi } from "vitest"
import { ocrImage } from "../attachments/ocr.js"
import { aiImageReader, aiKeys, aiSettingPath } from "../models/ai.js"
import { aiModelCommand } from "./ai-model-command.js"
import type { Body } from "./envelope.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }
const KEY = "synthetic-owner-key"

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const chat = (text: string) =>
  answer(200, { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { total_tokens: 7 } })

const fixture = (extra: NodeJS.ProcessEnv = {}, fetch?: typeof globalThis.fetch) => {
  const root = mkdtempSync(join(tmpdir(), "ai-model-"))
  const env: NodeJS.ProcessEnv = {
    WIRECAT_STATE_DIR: root,
    WIRECAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "store.db"),
    ...extra,
  }
  const answers: Body[] = []
  const lines: string[] = []
  const keyring = memoryKeyring()
  let piped: string | undefined
  const run = (stdin: string | undefined, ...words: string[]) => {
    piped = stdin
    const ai = aiModelCommand(app, {
      env: () => env,
      keyring,
      stdin: () => (piped === undefined ? undefined : Readable.from([piped])),
      ...(fetch ? { fetch } : {}),
      output: (body) => answers.push(body),
      diagnostic: (line) => lines.push(line),
    })
    return new Command("fixture").addCommand(ai).parseAsync(["ai", ...words], { from: "user" })
  }
  const last = () => {
    const body = answers.at(-1)
    return body && "item" in body ? (body.item as Record<string, unknown>) : {}
  }
  return { env, run, last, lines, answers, keyring, root }
}

describe("models ai", () => {
  it("shows nothing chosen until the owner sets a model", async () => {
    const { run, last } = fixture()

    await run(undefined, "show")

    expect(last()).toMatchObject({ provider: null, model: null, images: false, key: { stored: false } })
  })

  it("keeps the key for the address it was set with, and never prints it", async () => {
    const { run, last, lines, answers, env, keyring } = fixture()

    await run(
      KEY,
      "set",
      "openai",
      "--model",
      "openai/gpt-4o-mini",
      "--base-url",
      "https://openrouter.ai/api/v1/",
      "--key-stdin",
    )

    expect(last()).toMatchObject({
      provider: "openai",
      base_url: "https://openrouter.ai/api/v1",
      origin: "https://openrouter.ai",
      key: { stored: true, source: "keyring" },
      changed: true,
    })
    expect(aiKeys(app, env, keyring).read("https://openrouter.ai")?.key).toBe(KEY)
    expect(aiKeys(app, env, keyring).read("http://openrouter.ai")).toBeUndefined()
    expect(aiKeys(app, env, keyring).read("https://api.openai.com")).toBeUndefined()
    expect(JSON.stringify(answers) + lines.join("\n")).not.toContain(KEY)
  })

  it("refuses plain http to another computer, and allows it on this one", async () => {
    const { run, last } = fixture()

    for (const address of ["http://192.168.1.5:11434/v1", "http://localhost.evil.com/v1", "http://127.0.0.1.nip.io/v1"])
      await expect(run(undefined, "set", "openai", "--model", "m", "--base-url", address)).rejects.toMatchObject({
        details: { reason: "ai.address-refused" },
      })
    await run(undefined, "set", "openai", "--model", "m", "--base-url", "http://localhost:1234/v1")
    expect(last()).toMatchObject({ origin: "http://localhost:1234" })
  })

  it("lets images go only to the model the owner agreed to, and says they leave the computer", async () => {
    const { run, last, lines } = fixture()

    await run(undefined, "set", "anthropic", "--model", "claude-haiku-4-5", "--images")
    expect(last()).toMatchObject({ images: true })
    expect(lines.join("\n")).toContain("leave this computer")

    await run(KEY, "set", "anthropic", "--model", "claude-haiku-4-5", "--key-stdin")
    expect(last()).toMatchObject({ images: true, changed: false })

    await run(undefined, "set", "anthropic", "--model", "claude-sonnet-4-5")
    expect(last()).toMatchObject({ images: false, changed: true })

    await run(undefined, "set", "anthropic", "--model", "claude-sonnet-4-5", "--images")
    await run(undefined, "set", "anthropic", "--model", "claude-sonnet-4-5", "--no-images")
    expect(last()).toMatchObject({ images: false, changed: true })
  })

  it("replaces a broken section instead of refusing to touch it", async () => {
    const { run, last, env } = fixture()
    mkdirSync(dirname(aiSettingPath(env)), { recursive: true })
    writeFileSync(aiSettingPath(env), JSON.stringify({ ai: { provider: "gemini", model: "x" } }))

    await expect(run(undefined, "show")).rejects.toMatchObject({ details: { reason: "ai.setting-invalid" } })
    await run(undefined, "set", "anthropic", "--model", "m")
    expect(last()).toMatchObject({ provider: "anthropic" })
  })

  it("forgets a key, and says when an older one still answers for that address", async () => {
    const { run, last, lines } = fixture({ FIXTURE_ANTHROPIC_API_KEY: "synthetic-env-key" })
    await run(KEY, "set", "anthropic", "--model", "m", "--key-stdin")

    await run(undefined, "forget")

    expect(last()).toMatchObject({ origin: "https://api.anthropic.com", removed: true, still_found: "environment" })
    expect(lines.join("\n")).toContain("still found in environment")
    await expect(run(undefined, "forget", "localhost:11434")).rejects.toMatchObject({ code: "validation_error" })
  })

  it("refuses an agent, unless Desktop says the owner clicked", async () => {
    const { run, last } = fixture({ CLAUDECODE: "1" })

    await expect(run(undefined, "set", "anthropic", "--model", "m")).rejects.toMatchObject({
      details: { reason: "ai.owner-only" },
    })
    await run(undefined, "set", "anthropic", "--model", "m", "--from-app")
    expect(last()).toMatchObject({ provider: "anthropic" })
  })

  it("turns off and keeps the key", async () => {
    const { run, last, env, keyring } = fixture()
    await run(KEY, "set", "anthropic", "--model", "m", "--key-stdin")

    await run(undefined, "off")

    expect(last()).toMatchObject({ changed: true, key_kept: true })
    expect(aiKeys(app, env, keyring).read("https://api.anthropic.com")?.key).toBe(KEY)
    expect(JSON.parse(readFileSync(aiSettingPath(env), "utf8")).ai).toBeUndefined()
  })

  it.each([
    [401, "ai.key-rejected"],
    [402, "ai.no-credit"],
    [404, "ai.model-unknown"],
    [429, "ai.rate-limited"],
    [503, "ai.provider-error"],
    [400, "ai.failed"],
  ])("check reads a %i as %s, without the provider's text", async (status, reason) => {
    const fetch = vi.fn(async () => answer(status, { error: { message: `echo ${KEY}` } }))
    const { run, last, answers } = fixture({}, fetch)
    await run(KEY, "set", "openai", "--model", "gpt-4o-mini", "--key-stdin")

    await run(undefined, "check")

    expect(last()).toMatchObject({ ok: false, reason })
    expect(JSON.stringify(answers)).not.toContain(KEY)
  })

  it("check says the key is missing before it sends anything, and ok when the model answers", async () => {
    const fetch = vi.fn(async () => chat("OK"))
    const { run, last } = fixture({}, fetch)
    await run(undefined, "set", "openai", "--model", "gpt-4o-mini")

    await run(undefined, "check")
    expect(last()).toMatchObject({ ok: false, reason: "ai.key-missing" })
    expect(fetch).not.toHaveBeenCalled()

    await run(undefined, "set", "ollama", "--model", "llava")
    await run(undefined, "check")
    expect(last()).toMatchObject({ ok: true, reason: "ai.ok", origin: "http://127.0.0.1:11434" })
  })
})

describe("aiImageReader", () => {
  const png = () => PNG.sync.write(new PNG({ width: 2, height: 2 }))

  it("says why it cannot read before any model is chosen or agreed to", async () => {
    const { run, env, keyring } = fixture()

    expect(aiImageReader({ app, env, keyring })).toEqual({ refused: "ai.not-set" })
    await run(undefined, "set", "openai", "--model", "gpt-4o-mini")
    expect(aiImageReader({ app, env, keyring })).toEqual({ refused: "ai.images-not-allowed" })
    await run(undefined, "set", "openai", "--model", "gpt-4o-mini", "--images")
    expect(aiImageReader({ app, env, keyring })).toEqual({ refused: "ai.key-missing" })
  })

  it("reads an image's text through the chosen model, sending the key only there", async () => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => chat("Invoice 42"))
    const { run, env, keyring } = fixture()
    await run(KEY, "set", "openai", "--model", "gpt-4o-mini", "--images", "--key-stdin")

    const reader = aiImageReader({ app, env, keyring, fetch })
    if (!("pipeline" in reader)) throw new Error("no reader")
    const read = await ocrImage(png(), reader.pipeline)

    expect(reader.by).toBe("openai/gpt-4o-mini")
    expect(read).toMatchObject({ status: "extracted", text: "Invoice 42" })
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/chat/completions")
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  })
})
