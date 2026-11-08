import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { placedText, textModelsDirectory } from "../embeddings/embed.js"
import { textModel } from "../embeddings/models.js"
import { model } from "../entities/model.js"
import type { Body } from "./envelope.js"
import { modelCatalogueCommand } from "./model-catalogue-command.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }
const fixture = (kinds: ("audio" | "text")[]) => {
  const home = mkdtempSync(join(tmpdir(), "model-contract-"))
  const env = { HOME: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, "config") }
  const answers: Body[] = []
  const models = modelCatalogueCommand(app, {
    kinds,
    env: () => env,
    output: (body) => answers.push(body),
    diagnostic: () => {},
    offline: () => true,
  })
  return { root: new Command("fixture").addCommand(models), answers, env }
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
  it("a text tool's models set makes a downloaded model the one models list marks, and add is refused offline", async () => {
    const { root, answers, env } = fixture(["text"])
    for (const [file, path] of placedText(textModel("e5-large"), textModelsDirectory(env))) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "")
      truncateSync(path, file.bytes)
    }

    await root.parseAsync(["models", "set", "e5-large"], { from: "user" })
    await root.parseAsync(["models", "list", "kind:text"], { from: "user" })

    expect(answers[0] && "item" in answers[0] && answers[0].item).toMatchObject({
      id: "e5-large",
      previous: "e5-small",
    })
    const listed = answers[1] && "items" in answers[1] ? answers[1].items : []
    expect(
      listed.filter((one) => (one as { default: boolean }).default).map((one) => (one as { id: string }).id),
    ).toEqual(["e5-large"])
    await expect(root.parseAsync(["models", "add", "mine", "--payload", "{}"], { from: "user" })).rejects.toThrow(
      "--offline",
    )
  })
})
