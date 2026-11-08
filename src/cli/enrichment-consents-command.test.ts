import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { readEnrichmentSetting } from "../services/enrichment-setting.js"
import { openStore } from "../store/store.js"
import type { Body } from "./envelope.js"
import { modelCatalogueCommand } from "./model-catalogue-command.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }

const fixture = async (extra: NodeJS.ProcessEnv = {}) => {
  const root = mkdtempSync(join(tmpdir(), "enrichment-consents-"))
  const env: NodeJS.ProcessEnv = { WIRECAT_STATE_DIR: root, MESSAGING_STORE: join(root, "store.db"), ...extra }
  const store = await openStore({ env })
  await store.notes.addNote({ text: "the hosting agreement renews in March" })
  await store.close()
  const answers: Body[] = []
  const lines: string[] = []
  const models = modelCatalogueCommand(app, {
    kinds: ["text"],
    env: () => env,
    keyring: memoryKeyring(),
    output: (body) => answers.push(body),
    diagnostic: (line) => lines.push(line),
  })
  const run = (...words: string[]) =>
    new Command("fixture").addCommand(models).parseAsync(["models", "consents", ...words], { from: "user" })
  const item = (at: number) =>
    answers[at] && "item" in answers[at] ? (answers[at].item as Record<string, unknown>) : {}
  return { env, run, item, lines }
}

describe("models consents", () => {
  it("is off until the owner says yes, and the preview names the provider, the records and the cost", async () => {
    const { env, run, item, lines } = await fixture()

    await run("show")
    await run("set", "openai", "--model", "gpt-4o-mini")

    expect(item(0)).toMatchObject({
      on: false,
      provider: null,
      records: 1,
      pending: 1,
      per_sync: 600,
      syncs_needed: 1,
      target: {
        provider: "openai",
        model: "gpt-4o-mini",
        endpoint_host: "api.openai.com",
        key: { present: false, source: null, env_var: "OPENAI_API_KEY" },
      },
      offered: expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", model: "claude-haiku-5-5", default: false }),
      ]),
      off_command: "fixture models consents revoke",
    })
    expect((item(0).estimate as { usd: number }).usd).toBeGreaterThan(0)
    expect(item(1)).toMatchObject({ on: false, changed: false })
    expect(String(item(1).consent)).toMatch(/to openai \(api\.openai\.com\), model gpt-4o-mini: 1 records now/)
    expect(String(item(1).consent)).toMatch(/in the record's own words gets that record first a little less often/)
    expect(lines.join("\n")).toMatch(/Nothing changed — add --yes/)
    expect(readEnrichmentSetting(env)).toBeUndefined()
  })

  it("previews the proposed provider as fields, and says when its key is found, never the key", async () => {
    const { run, item } = await fixture({ ANTHROPIC_API_KEY: "test-key" })

    await run("set", "anthropic", "--model", "claude-haiku-5-5")

    expect(item(0)).toMatchObject({
      on: false,
      provider: null,
      target: {
        provider: "anthropic",
        model: "claude-haiku-5-5",
        endpoint_host: "api.anthropic.com",
        key: { present: true, source: "env", env_var: "ANTHROPIC_API_KEY" },
        price_known: true,
      },
    })
    expect(JSON.stringify(item(0))).not.toContain("test-key")
  })

  it("turns on with --yes, and revoke turns it off", async () => {
    const { env, run, item } = await fixture()

    await run("set", "openai", "--model", "gpt-4o-mini", "--yes")
    expect(item(0)).toMatchObject({ on: true, provider: "openai", model: "gpt-4o-mini", changed: true })
    expect(readEnrichmentSetting(env)).toMatchObject({ provider: "openai", model: "gpt-4o-mini" })

    await run("revoke")
    expect(item(1)).toMatchObject({ on: false, changed: true, deleted: 0 })
    expect(readEnrichmentSetting(env)).toBeUndefined()
  })

  it("refuses an agent and an unknown provider", async () => {
    const { run } = await fixture({ AI_AGENT: "claude-code" })

    await expect(run("set", "openai", "--model", "gpt-4o-mini", "--yes")).rejects.toThrow(/only the owner/)
    await expect(run("set", "mistral", "--model", "x")).rejects.toThrow(/openai or anthropic/)
  })
})
