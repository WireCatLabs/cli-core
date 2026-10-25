import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it } from "vitest"
import { endpoint } from "../analysis/settings.js"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import { analysisChoice } from "./analysis-choice.js"
import { embeddingChoice } from "./embedding-choice.js"
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
  return { env, config, settings, root, keyring: memoryKeyring() }
}
describe("AI settings and provider selection", () => {
  it("custom hosts named like public providers do not inherit their public keys", () => {
    const { settings, env, keyring } = setup()
    env.APP_OPENAI_API_KEY = "synthetic-public-key"
    env.APP_ANTHROPIC_API_KEY = "synthetic-anthropic-key"
    for (const host of ["openai", "anthropic"]) {
      const baseUrl = `http://${host}/v1`
      expect(endpointKeyName(baseUrl)).toBe(`endpoint:${host}`)
      expect(
        analysisChoice({ analysisProvider: "openai", model: "test", baseUrl }, app, settings(), env, keyring).apiKey,
      ).toBeUndefined()
    }
    expect(endpointKeyName("http://localhost:11434/v1")).toBe("localhost:11434")
  })
  it("defaults locally, validates config values, and reports all sources", () => {
    const { config, settings, env, root, keyring } = setup()
    expect(embeddingChoice({}, app, settings(), env, { keyring })).toBe("e5-small")
    expect(settings().models?.analysis).toBeUndefined()
    for (const [key, value] of [
      ["embedding_provider", "anthropic"],
      ["models.analysis.provider", "unknown"],
      ["embedding_dims", "0"],
      ["models.analysis.model", '""'],
      ["models.analysis.base_url", "https://user:secret@example.test"],
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
      setting: "embedding_provider",
      value: "openai",
    })
    config.changeSetting(join(root, "config.json"), {
      profile: "default",
      setting: "models.analysis.provider",
      value: "anthropic",
    })
    config.changeSetting(join(root, "config.json"), {
      profile: "default",
      setting: "models.analysis.model",
      value: "test-model",
    })
    expect(settings()).toMatchObject({
      embeddingProvider: "openai",
      models: { analysis: { provider: "anthropic", model: "test-model" } },
      sources: {
        embeddingProvider: "config file",
        "models.analysis.provider": "config file: models.analysis.provider",
      },
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
      config.resolveSettings({}, { env: { ...env, APP_MODELS_ANALYSIS_PROVIDER: "bad" }, configDir: root }),
    ).toThrow("invalid")
  })
  it("keeps custom endpoints isolated from public keys and flags override configured providers", () => {
    const { settings, env, keyring } = setup()
    env.OPENAI_API_KEY = "fake-openai"
    env.ANTHROPIC_API_KEY = "fake-anthropic"
    const configured = {
      ...settings(),
      embeddingProvider: "openai" as const,
      embeddingModel: "custom",
      embeddingBaseUrl: "https://example.test/v1",
      embeddingDims: 128,
      models: { analysis: { provider: "openai" as const, model: "custom", base_url: "https://example.test/v1" } },
    }
    expect(embeddingChoice({}, app, configured, env, { keyring })).toMatchObject({
      remote: { model: "custom", dims: 128 },
    })
    expect(embeddingChoice({}, app, configured, env, { keyring })).not.toHaveProperty("apiKey")
    expect(analysisChoice({}, app, configured, env, keyring)).not.toHaveProperty("apiKey")
    embeddingKeys(app, env, keyring).write("example.test", "fake-host")
    expect(analysisChoice({}, app, configured, env, keyring)).toMatchObject({ apiKey: "fake-host" })
    expect(embeddingChoice({}, app, configured, env, { keyring })).toMatchObject({ apiKey: "fake-host" })
    expect(embeddingChoice({ embeddingProvider: "local", model: "e5-base" }, app, configured, env, { keyring })).toBe(
      "e5-base",
    )
    expect(embeddingChoice({ embeddingProvider: "openai" }, app, configured, env, { keyring })).toMatchObject({
      remote: { model: "custom", dims: 128 },
      apiKey: "fake-host",
    })
    expect(embeddingChoice({ embeddingProvider: "openai" }, app, settings(), env, { keyring })).toMatchObject({
      remote: { model: "text-embedding-3-small" },
      apiKey: "fake-openai",
    })
    expect(embeddingChoice({ model: "override-model" }, app, configured, env, { keyring })).toMatchObject({
      remote: { model: "override-model", dims: 128, baseUrl: "https://example.test/v1" },
    })
    expect(
      analysisChoice({ analysisProvider: "openai", model: "override-model" }, app, configured, env, keyring),
    ).toMatchObject({
      model: "override-model",
      baseUrl: "https://example.test/v1",
    })
    expect(
      analysisChoice({ analysisProvider: "anthropic", model: "explicit" }, app, configured, env, keyring),
    ).toMatchObject({
      model: "explicit",
      baseUrl: "https://api.anthropic.com",
      apiKey: "fake-anthropic",
    })
    expect(embeddingKeys(app, env, keyring).read("anthropic")).toMatchObject({ key: "fake-anthropic" })
    embeddingKeys(app, env, keyring).remove("example.test")
    expect(embeddingKeys(app, env, keyring).read("example.test")).toBeUndefined()
  })
  it("**reads no analysis_* setting**: each is unknown, with no word of what replaced it", () => {
    const { config, root } = setup()
    for (const key of ["analysis_provider", "analysis_model", "analysis_base_url"]) {
      expect(() =>
        config.changeSetting(join(root, "config.json"), { profile: "default", setting: key, value: "openai" }),
      ).toThrow(`no setting called "${key}"`)
      writeFileSync(join(root, "config.json"), JSON.stringify({ profiles: { default: { [key]: "openai" } } }))
      const refused = () => config.resolveSettings({}, { env: { APP_PROFILE: "default" }, configDir: root })
      expect(refused).toThrow(
        `setting ${key} is not a setting of app — remove it with \`app default config unset ${key}\``,
      )
      expect(refused).not.toThrow(/models/)
    }
  })
  it("refuses missing provider/model/key and malformed endpoints before any call", () => {
    const { settings, env, keyring } = setup()
    expect(() => analysisChoice({}, app, settings(), env, keyring)).toThrow("linking skill")
    expect(() => analysisChoice({ analysisProvider: "bad" }, app, settings(), env, keyring)).toThrow("provider")
    expect(() => analysisChoice({ analysisProvider: "anthropic" }, app, settings(), env, keyring)).toThrow(
      "models.analysis.model",
    )
    expect(() =>
      analysisChoice({ analysisProvider: "anthropic", model: "test" }, app, settings(), env, keyring),
    ).toThrow("key")
    expect(() =>
      analysisChoice(
        { analysisProvider: "openai", model: "test", baseUrl: "file:///tmp/test" },
        app,
        settings(),
        env,
        keyring,
      ),
    ).toThrow("HTTP/S")
    expect(() => embeddingChoice({ embeddingProvider: "bad" }, app, settings(), env, { keyring })).toThrow("provider")
    expect(() => embeddingChoice({ embeddingProvider: "openai" }, app, settings(), env, { keyring })).toThrow("key")
    expect(() => embeddingChoice({ embeddingProvider: "local", dims: 128 }, app, settings(), env, { keyring })).toThrow(
      "local",
    )
    expect(() =>
      embeddingChoice({ baseUrl: "https://example.test?key=secret", dims: 128 }, app, settings(), env, { keyring }),
    ).toThrow("HTTP/S")
    expect(
      embeddingChoice({ embeddingProvider: "openai" }, app, settings(), env, { needKey: false, keyring }),
    ).toHaveProperty("remote")
    expect(endpoint("not a URL")).toBe(false)
  })
})
