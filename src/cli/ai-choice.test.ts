import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { endpoint } from "../analysis/settings.js"
import { analysisChoice } from "./analysis-choice.js"
import { embeddingChoice } from "./embedding-choice.js"
import { embeddingKeys, endpointKeyName } from "./embedding-keys.js"
import { settingsFor } from "./settings.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "1.0.0" }
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "ai-config-"))
  const env = {
    ...process.env,
    APP_CONFIG_DIR: root,
    APP_PROFILE: "default",
    APP_STATE_DIR: join(root, "state"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    APP_OPENAI_API_KEY: "",
    APP_ANTHROPIC_API_KEY: "",
  }
  const config = settingsFor(app)
  const settings = () => config.resolveSettings({}, { env, configDir: root })
  return { env, config, settings, root }
}
describe("AI settings and provider selection", () => {
  it("custom hosts named like public providers do not inherit their public keys", () => {
    const { settings, env } = setup()
    env.APP_OPENAI_API_KEY = "synthetic-public-key"
    env.APP_ANTHROPIC_API_KEY = "synthetic-anthropic-key"
    for (const host of ["openai", "anthropic"]) {
      const baseUrl = `http://${host}/v1`
      expect(endpointKeyName(baseUrl)).toBe(`endpoint:${host}`)
      expect(
        analysisChoice({ provider: "openai", model: "test", baseUrl }, app, settings(), env).apiKey,
      ).toBeUndefined()
    }
    expect(endpointKeyName("http://localhost:11434/v1")).toBe("localhost:11434")
  })
  it("defaults locally, validates config values, and reports all sources", () => {
    const { config, settings, env, root } = setup()
    expect(embeddingChoice({}, app, settings(), env)).toBe("e5-small")
    expect(settings().analysisProvider).toBe("agent")
    for (const [key, value] of [
      ["embeddingProvider", "anthropic"],
      ["analysisProvider", "unknown"],
      ["embeddingDims", "0"],
      ["analysisModel", '""'],
      ["analysisBaseUrl", "https://user:secret@example.test"],
    ])
      expect(() =>
        config.changeSetting(join(root, "config.json"), {
          profile: "default",
          setting: key as string,
          value: value as string,
        }),
      ).toThrow()
    config.changeSetting(join(root, "config.json"), {
      profile: "default",
      setting: "embeddingProvider",
      value: "openai",
    })
    config.changeSetting(join(root, "config.json"), {
      profile: "default",
      setting: "analysisProvider",
      value: "anthropic",
    })
    config.changeSetting(join(root, "config.json"), {
      profile: "default",
      setting: "analysisModel",
      value: "test-model",
    })
    expect(settings()).toMatchObject({
      embeddingProvider: "openai",
      analysisProvider: "anthropic",
      analysisModel: "test-model",
      sources: { embeddingProvider: "config file", analysisProvider: "config file" },
    })
    const fromEnv = config.resolveSettings(
      {},
      {
        env: { ...env, APP_EMBEDDING_PROVIDER: "local", APP_EMBEDDING_MODEL: "e5-base", APP_EMBEDDING_DIMS: "384" },
        configDir: root,
      },
    )
    expect(fromEnv).toMatchObject({
      embeddingProvider: "local",
      embeddingModel: "e5-base",
      embeddingDims: 384,
      sources: { embeddingProvider: "APP_EMBEDDING_PROVIDER" },
    })
    expect(() =>
      config.resolveSettings({}, { env: { ...env, APP_ANALYSIS_PROVIDER: "bad" }, configDir: root }),
    ).toThrow("invalid")
  })
  it("keeps custom endpoints isolated from public keys and flags override configured providers", () => {
    const { settings, env } = setup()
    env.OPENAI_API_KEY = "fake-openai"
    env.ANTHROPIC_API_KEY = "fake-anthropic"
    const configured = {
      ...settings(),
      embeddingProvider: "openai" as const,
      embeddingModel: "custom",
      embeddingBaseUrl: "https://example.test/v1",
      embeddingDims: 128,
      analysisProvider: "openai" as const,
      analysisModel: "custom",
      analysisBaseUrl: "https://example.test/v1",
    }
    expect(embeddingChoice({}, app, configured, env)).toMatchObject({ remote: { model: "custom", dims: 128 } })
    expect(embeddingChoice({}, app, configured, env)).not.toHaveProperty("apiKey")
    expect(analysisChoice({}, app, configured, env)).not.toHaveProperty("apiKey")
    embeddingKeys(app, env).write("example.test", "fake-host")
    expect(analysisChoice({}, app, configured, env)).toMatchObject({ apiKey: "fake-host" })
    expect(embeddingChoice({}, app, configured, env)).toMatchObject({ apiKey: "fake-host" })
    expect(embeddingChoice({ provider: "local", model: "e5-base" }, app, configured, env)).toBe("e5-base")
    expect(embeddingChoice({ provider: "openai" }, app, configured, env)).toMatchObject({
      remote: { model: "custom", dims: 128 },
      apiKey: "fake-host",
    })
    expect(embeddingChoice({ provider: "openai" }, app, settings(), env)).toMatchObject({
      remote: { model: "text-embedding-3-small" },
      apiKey: "fake-openai",
    })
    expect(embeddingChoice({ model: "override-model" }, app, configured, env)).toMatchObject({
      remote: { model: "override-model", dims: 128, baseUrl: "https://example.test/v1" },
    })
    expect(analysisChoice({ provider: "openai", model: "override-model" }, app, configured, env)).toMatchObject({
      model: "override-model",
      baseUrl: "https://example.test/v1",
    })
    expect(analysisChoice({ provider: "anthropic", model: "explicit" }, app, configured, env)).toMatchObject({
      model: "explicit",
      baseUrl: "https://api.anthropic.com",
      apiKey: "fake-anthropic",
    })
    expect(embeddingKeys(app, env).read("anthropic")).toMatchObject({ key: "fake-anthropic" })
    embeddingKeys(app, env).remove("example.test")
    expect(embeddingKeys(app, env).read("example.test")).toBeUndefined()
  })
  it("refuses missing provider/model/key and malformed endpoints before any call", () => {
    const { settings, env } = setup()
    expect(() => analysisChoice({}, app, settings(), env)).toThrow("agent")
    expect(() => analysisChoice({ provider: "bad" }, app, settings(), env)).toThrow("provider")
    expect(() => analysisChoice({ provider: "anthropic" }, app, settings(), env)).toThrow("analysisModel")
    expect(() => analysisChoice({ provider: "anthropic", model: "test" }, app, settings(), env)).toThrow("key")
    expect(() =>
      analysisChoice({ provider: "openai", model: "test", baseUrl: "file:///tmp/test" }, app, settings(), env),
    ).toThrow("HTTP/S")
    expect(() => embeddingChoice({ provider: "bad" }, app, settings(), env)).toThrow("provider")
    expect(() => embeddingChoice({ provider: "openai" }, app, settings(), env)).toThrow("key")
    expect(() => embeddingChoice({ provider: "local", dims: 128 }, app, settings(), env)).toThrow("local")
    expect(() =>
      embeddingChoice({ baseUrl: "https://example.test?key=secret", dims: 128 }, app, settings(), env),
    ).toThrow("HTTP/S")
    expect(embeddingChoice({ provider: "openai" }, app, settings(), env, { needKey: false })).toHaveProperty("remote")
    expect(endpoint("not a URL")).toBe(false)
  })
})
