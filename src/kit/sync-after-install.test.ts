import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { outputFor } from "../cli/context.js"
import { FETCH, LOCAL_WRITE } from "../cli/effects.js"
import { itemOf, renderAnswer } from "../cli/envelope.js"
import { commandPermissions } from "../cli/permission-keys.js"
import { type ProgramDefinition, run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { syncAfterInstallCases } from "./index.js"

const app = { command: "fresh", appName: "fresh-cli", envPrefix: "FRESH", description: "A test CLI", version: "1.0.0" }

const definition = (): ProgramDefinition => {
  const answer = (command: Command) => renderAnswer(command, outputFor(command), itemOf({ synced: true }))
  const sync = annotate(new Command("sync"), { effects: FETCH }).action(function (this: Command) {
    answer(this)
  })
  const tag = annotate(new Command("tag"), { effects: LOCAL_WRITE }).action(function (this: Command) {
    answer(this)
  })
  const pull = annotate(new Command("pull"), { effects: FETCH }).action(function (this: Command) {
    answer(this)
  })
  return {
    app,
    configuration: settingsFor(app, { permissions: commandPermissions() }),
    commands: () => [sync, new Command("notes").addCommand(tag).addCommand(pull)],
  }
}

const runner = (ownConfig?: string) => async (argv: string[], env: NodeJS.ProcessEnv) => {
  const err: string[] = []
  const code = await run(argv, definition(), {
    tty: false,
    env: { ...process.env, ...(ownConfig ? { FRESH_CONFIG_DIR: ownConfig } : {}), ...env },
    streams: { data: () => {}, diagnostic: (text) => err.push(text) },
  })
  return { code, err: err.join("") }
}

describe("a sync right after install, whatever the shared config holds", () => {
  for (const one of syncAfterInstallCases({
    sync: ["work", "sync"],
    run: runner(),
    refusedUnderReadOnly: ["work", "notes", "tag"],
    profileLevels: { variable: "FRESH_CONFIG_DIR", keys: ["sync"] },
  }))
    it(one.name, () => one.run())

  for (const one of syncAfterInstallCases({
    sync: ["work", "notes", "pull"],
    run: runner(),
    refusedUnderReadOnly: ["work", "notes", "tag"],
    profileLevels: { variable: "FRESH_CONFIG_DIR", keys: ["notes", "notes.pull"] },
  }).filter((one) => one.name.includes("profile")))
    it(`by a group key: ${one.name}`, () => one.run())

  it("still refuses a local edit at a profile's readonly, by its own key or its group's", async () => {
    for (const key of ["notes", "notes.tag"]) {
      const own = mkdtempSync(join(tmpdir(), "fresh-config-"))
      writeFileSync(
        join(own, "config.json"),
        JSON.stringify({ profiles: { work: { permissions: { [key]: "readonly" } } } }),
      )
      const { code, err } = await runner(own)(["work", "notes", "tag", "--json"], {})
      expect(code).not.toBe(0)
      expect(err).toContain("permission_error")
    }
  })

  it("fails a CLI whose sync is refused", async () => {
    const own = mkdtempSync(join(tmpdir(), "fresh-config-"))
    writeFileSync(join(own, "config.json"), JSON.stringify({ profiles: { work: { permissions: { sync: "deny" } } } }))
    const [first] = syncAfterInstallCases({
      sync: ["work", "sync"],
      run: runner(own),
    })
    await expect(first?.run()).rejects.toThrow(/sync was refused/)
  })
})
