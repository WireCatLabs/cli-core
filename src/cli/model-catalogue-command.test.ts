import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { model } from "../entities/model.js"
import type { Body } from "./envelope.js"
import { modelCatalogueCommand } from "./model-catalogue-command.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }
const fixture = (kinds: ("audio" | "text")[]) => {
  const home = mkdtempSync(join(tmpdir(), "model-contract-"))
  const answers: Body[] = []
  const models = modelCatalogueCommand(app, {
    kinds,
    env: () => ({ HOME: home, XDG_DATA_HOME: home }),
    output: (body) => answers.push(body),
    diagnostic: () => {},
    offline: () => true,
  })
  return { root: new Command("fixture").addCommand(models), answers }
}

describe("provider model commands share the canonical contract", () => {
  it("lists supported kinds through native queries with the shared model schema", async () => {
    const { root, answers } = fixture(["audio", "text"])
    await root.parseAsync(["models", "list", "kind:text", "id:e5-small", "downloaded:false"], { from: "user" })
    const answer = answers[0]
    expect(answer && "items" in answer && answer.items).toHaveLength(1)
    if (!answer || !("items" in answer)) throw new Error("missing list")
    for (const item of answer.items) expect(v.safeParse(model, item).success).toBe(true)
  })
  it("a text-only tool returns no audio rows and refuses downloads in offline mode before network work", async () => {
    const { root, answers } = fixture(["text"])
    await root.parseAsync(["models", "list", "kind:audio"], { from: "user" })
    expect(answers[0] && "items" in answers[0] && answers[0].items).toEqual([])
    await expect(root.parseAsync(["models", "download", "e5-small"], { from: "user" })).rejects.toThrow("--offline")
  })
})
