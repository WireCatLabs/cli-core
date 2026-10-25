import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveAISettings } from "../analysis/settings.js"
import { settingsFor } from "../cli/settings.js"
import { modelTarget } from "./settings.js"

describe("purpose model settings", () => {
  it("resolves each field, default fallback and explicit off with sources", () => {
    const resolved = resolveAISettings(
      "APP",
      [
        ["profile", { models: { replies: { provider: "off" }, analysis: { provider: "anthropic", model: "chosen" } } }],
        [
          "defaults",
          { models: { default: { provider: "openai", model: "default-model", base_url: "https://example.test/v1" } } },
        ],
      ],
      { APP_MODELS_REPLIES_MODEL: "reply-model" },
    )
    expect(modelTarget(resolved.values, "replies")).toBeUndefined()
    expect(modelTarget(resolved.values, "analysis")).toMatchObject({ provider: "anthropic", model: "chosen" })
    expect(modelTarget(resolved.values, "other")).toEqual({
      provider: "openai",
      model: "default-model",
      baseUrl: "https://example.test/v1",
    })
    expect(resolved.sources["models.replies.provider"]).toBe("profile: models.replies.provider")
    expect(resolved.sources["models.replies.model"]).toBe("APP_MODELS_REPLIES_MODEL")
    expect(modelTarget({}, "analysis")).toBeUndefined()
    expect(() => modelTarget({ models: { replies: { provider: "openai" } } }, "replies")).toThrow("model")
  })

  it("handles default environment and per-purpose settings, rejecting bad provider or endpoint", () => {
    expect(
      resolveAISettings("APP", [], {
        APP_MODELS_DEFAULT_PROVIDER: "openai",
        APP_MODELS_DEFAULT_MODEL: "test",
        APP_MODELS_MEMO_PROVIDER: "anthropic",
      }).values.models?.memo,
    ).toEqual({ provider: "anthropic", model: "test" })
    expect(() => resolveAISettings("APP", [], { APP_MODELS_REPLIES_PROVIDER: "bad" })).toThrow(
      "models.replies.provider",
    )
    expect(() =>
      resolveAISettings("APP", [], { APP_MODELS_REPLIES_BASE_URL: "https://user:secret@example.test" }),
    ).toThrow("models.replies.base_url")
  })

  it("sets and unsets dotted model config fields through validated configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "model-settings-"))
    const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "1" }
    const config = settingsFor(app)
    const path = join(root, "config.json")
    const change = (setting: string, value?: string) =>
      config.changeSetting(path, { profile: "default", setting, value })
    for (const [field, value] of [
      ["provider", "openai"],
      ["model", "test"],
      ["base_url", "https://example.test/v1"],
    ])
      change(`models.replies.${field}`, value)
    expect(
      modelTarget(config.resolveSettings({}, { configDir: root, env: { APP_PROFILE: "default" } }), "replies"),
    ).toEqual({
      provider: "openai",
      model: "test",
      baseUrl: "https://example.test/v1",
    })
    expect(() => change("models.replies.provider", "bad")).toThrow()
    expect(() => change("models.replies.token", "secret")).toThrow("no setting")
    for (const field of ["provider", "model", "base_url"]) change(`models.replies.${field}`)
    expect(
      modelTarget(config.resolveSettings({}, { configDir: root, env: { APP_PROFILE: "default" } }), "replies"),
    ).toBeUndefined()
  })
})
