import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { outputBudget } from "./output-budget.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1" }
const setup = (contents: string) => {
  const configDir = mkdtempSync(join(tmpdir(), "output-budget-"))
  writeFileSync(join(configDir, "config.json"), contents)
  return { configDir, env: {} }
}

describe("output budget", () => {
  it("uses flags, environment and the selected kind/profile without validating provider-only settings", () => {
    const options = setup(
      JSON.stringify({
        defaultProfile: "work",
        defaults: { region: "eu", maxOutputBytes: 10 },
        profiles: { work: { maxOutputBytes: 20 } },
        bot: { profiles: { work: { maxOutputBytes: 30 } } },
      }),
    )
    expect(outputBudget(app, {}, options)).toBe(20)
    expect(outputBudget(app, {}, { ...options, kind: "bot" })).toBe(30)
    expect(outputBudget(app, {}, { ...options, env: { CHAT_MAX_OUTPUT_BYTES: "40" } })).toBe(40)
    expect(outputBudget(app, { maxOutputBytes: "0" }, options)).toBe(0)
  })
  it("allows discovery and repair to run when a config cannot be parsed", () => {
    expect(outputBudget(app, {}, setup("not JSON"))).toBe(64 * 1024 * 1024)
    expect(outputBudget(app, {}, setup("null"))).toBe(64 * 1024 * 1024)
    expect(outputBudget(app, {}, { ...setup('{"defaults":{"maxOutputBytes":-1}}'), configuration: false })).toBe(
      64 * 1024 * 1024,
    )
  })
})
