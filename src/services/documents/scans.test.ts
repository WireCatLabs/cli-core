import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { PNG } from "pngjs"
import { describe, expect, it, vi } from "vitest"
import { aiKeys, aiSettingOf, aiSettingPath, writeAiSetting } from "../../models/ai.js"
import { fakeTesseract } from "../../testing/tesseract.js"
import { scanReader, scanRetry } from "./scans.js"

const app = { command: "box", appName: "box-cli", envPrefix: "BOX", description: "", version: "1" }
const picture = PNG.sync.write(new PNG({ width: 4, height: 4 }))

const machine = () => {
  const root = mkdtempSync(join(tmpdir(), "scans-"))
  return {
    WIRECAT_STATE_DIR: root,
    WIRECAT_CONFIG_DIR: join(root, "wirecat"),
    MESSAGING_STORE: join(root, "store.db"),
  } as NodeJS.ProcessEnv
}

describe("scanReader with a model", () => {
  it("sends no picture to an OpenAI-shaped address other than OpenAI's own", async () => {
    const env = machine()
    writeAiSetting(
      aiSettingPath(env),
      aiSettingOf({ provider: "openai", model: "gpt-5", baseUrl: "https://openrouter.ai/api/v1", allowImages: true }),
    )
    const fetch = vi.fn()
    const reader = await scanReader("openai", { app, env, keyring: memoryKeyring(), fetch, command: "box" })
    expect(reader?.extractor).toBeUndefined()
    await expect(reader?.read(async () => picture, { name: "a.png", mime: "image/png" })).rejects.toThrow(
      "not openai at https://api.openai.com",
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it("asks for the owner's consent before a picture goes to the model", async () => {
    const env = machine()
    writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "anthropic", model: "claude-opus-5-5" }))
    const reader = await scanReader("anthropic", { app, env, keyring: memoryKeyring(), command: "box" })
    await expect(reader?.read(async () => picture, { name: "a.png", mime: "image/png" })).rejects.toThrow(
      /allow them|key/,
    )
  })

  it("leaves a picture for the next sync when the model is rate limited", async () => {
    const env = machine()
    const keyring = memoryKeyring()
    writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "openai", model: "gpt-5", allowImages: true }))
    aiKeys(app, env, keyring).write("https://api.openai.com", "sk-synthetic-scans-1")
    const fetch = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "1" } }))
    const reader = await scanReader("openai", { app, env, keyring, fetch, command: "box" })
    const refused = await reader?.read(async () => picture, { name: "a.png", mime: "image/png" }).catch((e) => e)
    expect(fetch).toHaveBeenCalled()
    expect(refused.message).toMatch(/^OCR is unavailable for now/)
    expect(scanRetry(reader, refused.message)).toBe(true)
  })

  it("reads nothing when read_scans is off", async () => {
    expect(await scanReader("off", { app, env: machine(), command: "box" })).toBeUndefined()
  })
})

describe("scanReader on this computer", () => {
  it("downloads nothing once the sync's page limit is reached", async () => {
    const tesseract = fakeTesseract()
    const env = { ...machine(), PATH: `${tesseract.bin}:${dirname(process.execPath)}` }
    const reader = await scanReader("local", { app, env, command: "box" }, undefined, 1)
    expect(reader?.extractor).toBe("ocr:v2:tesseract@5.3.0:rus+eng")
    const bytes = vi.fn(async () => picture)
    expect(await reader?.read(bytes, { name: "a.png", mime: "image/png" })).toBe("scanneedle words")
    expect(reader?.full?.()).toBe(true)
    await expect(reader?.read(bytes, { name: "b.png", mime: "image/png" })).rejects.toThrow(/page limit/)
    expect(bytes).toHaveBeenCalledTimes(1)
  })
})
