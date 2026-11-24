import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { PNG } from "pngjs"
import { describe, expect, it, vi } from "vitest"
import { aiSettingOf, aiSettingPath, writeAiSetting } from "../../models/ai.js"
import { scanReader } from "./scans.js"

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
    await expect(reader?.read(picture, { name: "a.png", mime: "image/png" })).rejects.toThrow(
      "not openai at https://api.openai.com",
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it("asks for the owner's consent before a picture goes to the model", async () => {
    const env = machine()
    writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "anthropic", model: "claude-opus-5-5" }))
    const reader = await scanReader("anthropic", { app, env, keyring: memoryKeyring(), command: "box" })
    await expect(reader?.read(picture, { name: "a.png", mime: "image/png" })).rejects.toThrow(/allow them|key/)
  })

  it("reads nothing when read_scans is off", async () => {
    expect(await scanReader("off", { app, env: machine(), command: "box" })).toBeUndefined()
  })
})
