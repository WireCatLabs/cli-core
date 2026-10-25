import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { app, sharedCommands } from "../testing/shared-program.js"
import { provide } from "./context.js"
import { honoursDryRun } from "./dry-run-guard.js"
import { changesAuthority } from "./effects.js"
import { run } from "./program.js"
import { settingsFor } from "./settings.js"
import { configCommand, modelCatalogueCommand, skillCommand, upgradeCommand } from "./shared-command-exports.js"

/** A CLI with its own program, as drive builds one: a global --dry-run and nothing of `run`'s preview. */
const foreignHost = (commands: readonly Command[], env: NodeJS.ProcessEnv = process.env) => {
  const streams = captureStreams()
  const program = new Command("host").option("--dry-run").option("--json").exitOverride()
  for (const command of commands) program.addCommand(command)
  const quiet = (command: Command) => {
    command.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
    for (const child of command.commands) quiet(child)
  }
  quiet(program)
  provide(program, { streams, env, tty: false })
  return { program, streams }
}

const leaves = (command: Command, path: string[] = []): { path: string[]; command: Command }[] =>
  command.commands.length === 0
    ? [{ path, command }]
    : command.commands.flatMap((child) => leaves(child, [...path, child.name()]))

const MANDATORY: Record<string, string> = { "--type": "question" }

const argvFor = (command: Command): string[] => [
  ...command.registeredArguments
    .filter((argument) => argument.required)
    .map((argument) => argument.argChoices?.[0] ?? "1"),
  ...command.options
    .filter((option) => option.mandatory)
    .flatMap((option) => [option.long as string, option.argChoices?.[0] ?? MANDATORY[option.long as string] ?? "1"]),
]

describe("a shared command mounted in another CLI's program", () => {
  const all = honoursDryRun(sharedCommands)()
  const host = foreignHost(all)
  const cases = leaves(host.program)
    .filter(({ command }) => writes(metaOf(command).effects) || changesAuthority(command))
    .filter(({ command }) => !command.options.some((option) => option.long === "--dry-run"))
    .map(({ path, command }) => [path.join(" "), path, command] as const)

  it("covers the shared commands that write", () => {
    expect(cases.length).toBeGreaterThan(100)
  })

  it.each(cases)("previews %s under --dry-run and does not run it", async (_name, path, command) => {
    const { program, streams } = foreignHost(honoursDryRun(sharedCommands)())
    await program.parseAsync([...path, ...argvFor(command), "--dry-run", "--json"], { from: "user" })
    const answer = JSON.parse(streams.stdout.join(""))
    expect(answer.item).toMatchObject({
      preview: true,
      path,
      effects: { action_invoked: false, write_reserved: false, service_contacted: false },
      validation: { permissions: "not-checked" },
    })
  })
})

describe("the exported shared commands in another CLI's program", () => {
  it("previews skill install and writes no SKILL.md", async () => {
    const home = mkdtempSync(join(tmpdir(), "guard-skill-"))
    const env = { ...process.env, HOME: home }
    vi.stubEnv("HOME", home)
    const { program, streams } = foreignHost(
      [skillCommand(app, new URL("../../skills/follow-ups/SKILL.md", import.meta.url))],
      env,
    )
    await program.parseAsync(["skill", "install", "--for", "all", "--dry-run", "--json"], { from: "user" })
    vi.unstubAllEnvs()
    expect(JSON.parse(streams.stdout.join("")).item.preview).toBe(true)
    expect(readdirSync(home)).toEqual([])
  })

  it("previews config set --defaults and saves nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "guard-config-"))
    const env = { ...process.env, HOME: home, CHAT_CONFIG_DIR: join(home, "config") }
    const { program, streams } = foreignHost([configCommand(app, settingsFor(app))], env)
    await program.parseAsync(["config", "set", "permissions.messages", '"readonly"', "--defaults", "--dry-run"], {
      from: "user",
    })
    expect(streams.stdout.join("")).toContain("preview")
    expect(existsSync(join(home, "config"))).toBe(false)
  })

  it("previews upgrade and never asks the package manager", async () => {
    const context = vi.fn()
    const { program, streams } = foreignHost([upgradeCommand(app, "@wirecat/chat-cli", context)])
    await program.parseAsync(["upgrade", "--dry-run", "--json"], { from: "user" })
    expect(context).not.toHaveBeenCalled()
    expect(JSON.parse(streams.stdout.join("")).item.effects.action_invoked).toBe(false)
  })

  it("previews models download and downloads nothing", async () => {
    const output = vi.fn()
    const models = modelCatalogueCommand(
      { ...app, messenger: false },
      { kinds: ["audio", "text"], env: () => process.env, output, diagnostic: () => {} },
    )
    const { program, streams } = foreignHost([models])
    await program.parseAsync(["models", "download", "parakeet-v3", "--dry-run", "--json"], { from: "user" })
    expect(output).not.toHaveBeenCalled()
    const { effects } = JSON.parse(streams.stdout.join("")).item
    expect(effects).toEqual({
      action_invoked: false,
      write_reserved: false,
      service_contacted: false,
      configuration_read: false,
    })
  })

  it("previews models download moved under the CLI's own group, as drive mounts it", async () => {
    const output = vi.fn()
    const shared = modelCatalogueCommand(app, { kinds: ["text"], env: () => process.env, output, diagnostic: () => {} })
    const own = new Command("models")
    for (const command of shared.commands) own.addCommand(command)
    const { program, streams } = foreignHost([own])
    await program.parseAsync(["models", "download", "e5-small", "--dry-run", "--json"], { from: "user" })
    expect(output).not.toHaveBeenCalled()
    expect(JSON.parse(streams.stdout.join("")).item.preview).toBe(true)
  })

  it("hands the global --dry-run to a command's own --dry-run, as run does", async () => {
    const seen = vi.fn()
    const store = honoursDryRun(() =>
      new Command("store").addCommand(
        new Command("repair").option("--dry-run").action((options: { dryRun?: boolean }) => seen(options.dryRun)),
      ),
    )()
    const { program } = foreignHost([store])
    await program.parseAsync(["--dry-run", "store", "repair"], { from: "user" })
    expect(seen).toHaveBeenCalledWith(true)
  })

  it("still runs a reading command under --dry-run", async () => {
    const output = vi.fn()
    const models = modelCatalogueCommand(app, { kinds: ["text"], env: () => process.env, output, diagnostic: () => {} })
    const { program } = foreignHost([models])
    await program.parseAsync(["models", "list", "--dry-run"], { from: "user" })
    expect(output).toHaveBeenCalledOnce()
  })
})

describe("run under --dry-run", () => {
  it("names the tool's own permission key and a neutral contacted field, and keeps the messenger's", async () => {
    const preview = async (messenger: boolean) => {
      const streams = captureStreams()
      const code = await run(
        ["work", "watch", "--dry-run", "--json"],
        {
          app: { ...app, messenger },
          commands: () => [new Command("watch").action(() => {})],
          configuration: {
            ...settingsFor(app),
            permissionKey: (path) => path.join("."),
          },
        },
        { streams, tty: false },
      )
      expect(code, streams.stderr.join("")).toBe(0)
      return JSON.parse(streams.stdout.join("")).item
    }
    const zoom = await preview(false)
    expect(zoom.permission.key).toBe("watch")
    expect(zoom.effects).toEqual({
      action_invoked: false,
      write_reserved: false,
      service_contacted: false,
      configuration_read: true,
    })
    expect((await preview(true)).effects).toMatchObject({ messenger_contacted: false, service_contacted: false })
  })
})
