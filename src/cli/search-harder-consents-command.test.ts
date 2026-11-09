import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { writeEnrichmentSetting } from "../services/enrichment-setting.js"
import { readHarderSetting } from "../services/search-harder.js"
import type { Body } from "./envelope.js"
import { modelCatalogueCommand } from "./model-catalogue-command.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }

const fixture = (extra: NodeJS.ProcessEnv = {}) => {
  const root = mkdtempSync(join(tmpdir(), "search-consents-"))
  const env: NodeJS.ProcessEnv = { WIRECAT_STATE_DIR: root, MESSAGING_STORE: join(root, "store.db"), ...extra }
  const answers: Body[] = []
  const lines: string[] = []
  const models = modelCatalogueCommand(app, {
    kinds: ["text"],
    enrichment: true,
    env: () => env,
    keyring: memoryKeyring(),
    output: (body) => answers.push(body),
    diagnostic: (line) => lines.push(line),
  })
  const run = (...words: string[]) =>
    new Command("fixture").addCommand(models).parseAsync(["models", "search-consents", ...words], { from: "user" })
  const item = (at: number) =>
    answers[at] && "item" in answers[at] ? (answers[at].item as Record<string, unknown>) : {}
  return { env, run, item, lines }
}

describe("models search-consents", () => {
  it("previews what a --harder search sends, and changes nothing without --yes", async () => {
    const { env, run, item, lines } = fixture()

    await run("set", "anthropic")

    expect(item(0)).toMatchObject({
      on: false,
      changed: false,
      model: "claude-haiku-5-5",
      endpoint: "https://api.anthropic.com",
      candidates: 30,
      key: { present: false },
    })
    expect(lines.join("\n")).toContain("sends the question and its first 30 hits")
    expect(lines.join("\n")).toContain("one costs about $0.0003")
    expect(readHarderSetting(env)).toBeUndefined()
  })

  it("allows it with --yes, and revoke takes it back", async () => {
    const { env, run, item } = fixture()

    await run("set", "anthropic", "--yes")
    expect(item(0)).toMatchObject({ on: true, changed: true })
    expect(readHarderSetting(env)).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" })

    await run("revoke")
    expect(item(1)).toMatchObject({ on: false, changed: true })
    expect(readHarderSetting(env)).toBeUndefined()
  })

  it("refuses an agent, a provider it cannot call, and another API without a model", async () => {
    const { run } = fixture({ AI_AGENT: "claude-code" })

    await expect(run("set", "anthropic", "--yes")).rejects.toThrow(/only the owner/)
    await expect(run("set", "mistral")).rejects.toThrow(/openai or anthropic, not mistral/)
    await expect(run("set", "openai", "--base-url", "https://openrouter.ai/api/v1")).rejects.toThrow(/needs --model/)
  })

  it("takes OpenAI with its own default model, or an OpenAI-compatible API with the model named", async () => {
    const { env, run, item, lines } = fixture()

    await run("set", "openai", "--yes")
    expect(readHarderSetting(env)).toMatchObject({ provider: "openai", model: "gpt-4o-mini" })
    expect(item(0).consent).toContain(
      "model gpt-4o-mini, which puts the hits that answer it first. Only a search with --harder sends anything; one costs about $0.0005",
    )
    expect(item(0)).toMatchObject({ endpoint: "https://api.openai.com/v1", usd_per_million: { input: 0.15 } })

    await run("set", "openai", "--base-url", "https://openrouter.ai/api/v1", "--model", "deepseek/deepseek-chat")
    expect(item(1)).toMatchObject({ model: "deepseek/deepseek-chat", usd_per_million: null, changed: false })
    expect(lines.join("\n")).toContain("openrouter.ai), model deepseek/deepseek-chat")
    expect(lines.join("\n")).toContain("the cost of one is unknown (no price for this model)")
  })

  it("proposes enrichment's provider without giving the consent", async () => {
    const { env, run, item } = fixture()
    writeEnrichmentSetting(env, { provider: "openai", model: "gpt-4o-mini", consented_at: "2026-11-09T10:00:00.000Z" })

    await run("show")
    expect(item(0)).toMatchObject({ on: false, provider: "openai", model: "gpt-4o-mini", proposed_from: "enrichment" })
    expect(readHarderSetting(env)).toBeUndefined()
  })
})
