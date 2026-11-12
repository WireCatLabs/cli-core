import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { commandPermissions } from "../../cli/permission-keys.js"
import { createProgram, type ProgramDefinition, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import { commandAt } from "../../cli/steps.js"
import { openStore } from "../../store/store.js"
import { syncCrm } from "../sync.js"
import { exampleDeal, fakeCrmSource } from "../testing/index.js"
import { addCrmCommands } from "./index.js"

const app = {
  command: "crm",
  appName: "crm-cli",
  envPrefix: "CRM",
  description: "x",
  version: "1.0.0",
  messenger: false,
}

const definition: ProgramDefinition = {
  app,
  configuration: settingsFor(app, { permissions: commandPermissions() }),
  commands: () => {
    const holder = new Command("crm")
    addCrmCommands(holder, {
      app,
      open: async () => {
        throw new CliError("network_error", "the store's own commands never open the CRM")
      },
    })
    return [...holder.commands]
  },
}

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-store-file-"))
  const env: NodeJS.ProcessEnv = {
    MESSAGING_STORE: join(root, "wirecat.db"),
    CRM_STATE_DIR: join(root, "state"),
    CRM_CONFIG_DIR: join(root, "config"),
  }
  const store = await openStore({ env })
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1", { title: "Example website" }))
  await syncCrm(source, store, { provider: "example-crm", account: "portal" })
  await store.close()
  const cli = async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(["work", "store", ...argv, "--json"], definition, { streams, tty: false, env })
    return { code, item: JSON.parse(streams.stdout[0] ?? "{}").item, stderr: streams.stderr.join("\n") }
  }
  return { root, env, cli }
}

describe("the shared store file, from a CRM CLI", () => {
  it("backs the store up, checks it and restores the backup, keeping the store it replaces", async () => {
    const { root, cli } = await setup()
    const backup = join(root, "backup.db")
    expect((await cli("backup", backup)).code).toBe(0)
    expect(existsSync(backup)).toBe(true)
    const checked = await cli("check")
    expect(checked.code).toBe(0)
    expect(checked.item).toMatchObject({ exists: true, ok: true })
    const restored = await cli("restore", backup)
    expect(restored.code, restored.stderr).toBe(0)
    expect(restored.item).toMatchObject({ restored_from: backup, kept_at: expect.stringContaining("before-restore") })
    const deals = await openStore({ path: join(root, "wirecat.db"), readOnly: true })
    try {
      expect(await deals.deals.list()).toHaveLength(1)
    } finally {
      await deals.close()
    }
  })

  it("repair --dry-run changes nothing, and the commands speak of a store, not of chats", async () => {
    const { cli } = await setup()
    const repaired = await cli("repair", "--dry-run")
    expect(repaired.code).toBe(0)
    expect(repaired.item).toMatchObject({ dry_run: true })
    const store = commandAt(createProgram(definition), "store") as Command
    const said = store.commands.map((one) => `${one.summary()} ${one.description()}`).join("\n")
    expect(said.split("\n").filter((line) => /\bchats\b|archive/.test(line))).toEqual([])
    expect(store.commands.map((one) => one.name())).toEqual(
      expect.arrayContaining(["status", "apply", "info", "check", "backup", "restore", "repair", "migrate"]),
    )
  })

  it("a read-only lock or a profile's deny stops reset, restore and repair, and the file stays as it was", async () => {
    const { root, env, cli } = await setup()
    const backup = join(root, "backup.db")
    expect((await cli("backup", backup)).code).toBe(0)
    const before = readFileSync(join(root, "wirecat.db"))
    env.CRM_READ_ONLY = "1"
    for (const argv of [["reset", "--yes"], ["restore", backup], ["repair"]]) {
      const refused = await cli(...argv)
      expect(refused.code, argv.join(" ")).not.toBe(0)
      expect(refused.stderr).toContain("CRM_READ_ONLY")
    }
    delete env.CRM_READ_ONLY
    mkdirSync(env.CRM_CONFIG_DIR as string, { recursive: true })
    writeFileSync(
      join(env.CRM_CONFIG_DIR as string, "config.json"),
      JSON.stringify({ profiles: { work: { permissions: { "store.reset": "deny" } } } }),
    )
    const denied = await cli("reset", "--yes")
    expect(denied.code).not.toBe(0)
    expect(denied.stderr).toContain("store.reset")
    expect(readFileSync(join(root, "wirecat.db")).equals(before)).toBe(true)
  })
})
