import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { defineSetup, type SetupCheckInput, type SetupKeep } from "../setup/define.js"
import { commandsCommand } from "./commands-command.js"
import { configCommand } from "./config-command.js"
import { ProfileTokenStore } from "./profile-token.js"
import { run } from "./program.js"
import { runsCommand } from "./runs/command.js"
import { settingsFor } from "./settings.js"
import { setupCommand } from "./setup-command.js"

const app = {
  command: "pbx",
  appName: "pbx-cli",
  envPrefix: "PBX",
  description: "A test",
  version: "0.7.0",
  messenger: false as const,
}
const text = v.optional(v.pipe(v.string("has to be text, in quotes"), v.trim(), v.minLength(1)))
const port = v.optional(v.pipe(v.number("has to be a port number"), v.integer(), v.minValue(1), v.maxValue(65535)))
const configuration = settingsFor(app, {
  profile: {
    cdr_source: v.optional(v.picklist(["csv", "mysql", "postgres"], "has to be csv, mysql or postgres")),
    files_from: v.optional(v.picklist(["local", "sftp"])),
    cdr_csv_path: text,
    db_host: text,
    db_port: port,
    db_name: text,
    db_user: text,
    db_tls: v.optional(v.boolean()),
    db_ssh_host: text,
    sftp_host: text,
    sftp_port: port,
    sftp_user: text,
    recordings_path: text,
    phone_region: v.optional(v.array(v.string())),
  },
})

const PASSWORD = "s3cret-pass"
const {
  format: _,
  version: __,
  tool: ___,
  toolVersion: ____,
  ...flow
} = JSON.parse(readFileSync(new URL("../../test/fixtures/setup-v1/pbx.json", import.meta.url), "utf8"))

const harness = ({
  ownerOnly,
  agent = false,
  keep,
}: {
  ownerOnly?: { settings: string[] }
  agent?: boolean
  keep?: SetupKeep
} = {}) => {
  const checks: SetupCheckInput[] = []
  const setup = defineSetup({
    ...flow,
    app,
    configuration,
    ...(ownerOnly ? { ownerOnly } : {}),
    check: async (input) => {
      checks.push(input)
      // A real check falls back to the kept password when the answers bring none.
      if ((input.secrets.db ?? PASSWORD) !== PASSWORD)
        throw new CliError("authentication_error", "the database refused the password")
      return { calls_last_hour: 3, ...(keep ? { keep } : {}) }
    },
  })
  const root = mkdtempSync(join(tmpdir(), "setup-"))
  const env = {
    PBX_CONFIG_DIR: join(root, "config"),
    PBX_STATE_DIR: join(root, "state"),
    ...(agent ? { AI_AGENT: "claude-code" } : {}),
  }
  const keyring = memoryKeyring()
  const call = async (argv: string[], { stdin, answer }: { stdin?: string; answer?: string[] } = {}) => {
    const streams = captureStreams()
    const queue = [...(answer ?? [])]
    const code = await run(
      argv,
      { app, configuration, commands: () => [setupCommand(setup), configCommand(app, configuration)] },
      {
        streams,
        tty: false,
        env,
        keyring,
        ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }),
        ...(answer ? { answer: () => queue.shift() ?? null } : {}),
      },
    )
    const out = streams.stdout.join("")
    const error = () => JSON.parse(streams.stderr.at(-1) ?? "{}").error
    return { code, out, item: out ? JSON.parse(out).item : undefined, stderr: streams.stderr.join("\n"), error }
  }
  const configPath = join(env.PBX_CONFIG_DIR, "config.json")
  const config = () => (existsSync(configPath) ? readFileSync(configPath, "utf8") : "")
  const kept = () => new ProfileTokenStore({ app, env, keyring }).readSecret("office", "db")?.secret
  return { call, checks, kept, config, env }
}

const MYSQL = {
  cdr_source: "mysql",
  files_from: "local",
  db_host: "pbx.office.local",
  db_port: 3306,
  db_user: "cdr",
  db: PASSWORD,
  phone_region: ["RU"],
}

describe("setup", () => {
  it("**show needs no profile**: the flow, every language, and each setting's own JSON Schema; no values", async () => {
    const { call, config } = harness()
    const { code, item } = await call(["setup", "show", "--json"])
    expect(code).toBe(0)
    expect(item).toMatchObject({ format: "wirecat.setup", version: 1, tool: "pbx", toolVersion: "0.7.0" })
    expect(item.values).toBeUndefined()
    expect(config()).toBe("")
    expect(Object.keys(item.texts)).toEqual(["en", "ru"])
    const row = item.steps.database.blocks.find((block: { role?: string }) => block.role === "row")
    expect(row.blocks[1]).toMatchObject({ id: "db_port", schema: { type: "integer", minimum: 1, maximum: 65535 } })
  })

  it("**apply --dry-run checks each answer on the path with its setting's schema, drops the rest, saves nothing**", async () => {
    const { call, config } = harness()
    const answers = { ...MYSQL, db_port: 70000, sftp_host: "never.example", cdr_csv_path: "/tmp/Master.csv" }
    const { code, item } = await call(["office", "setup", "apply", "--dry-run", "--json"], {
      stdin: JSON.stringify(answers),
    })
    expect(code).toBe(0)
    expect(item).toMatchObject({ valid: false, at: "database", path: ["source", "database"] })
    expect(item.errors).toEqual([{ input: "db_port", setting: "db_port", message: expect.stringMatching(/65535/) }])
    expect(item.dropped).toEqual(expect.arrayContaining(["sftp_host", "cdr_csv_path"]))
    expect(config()).toBe("")

    const good = await call(["office", "setup", "apply", "--dry-run", "--json"], { stdin: JSON.stringify(MYSQL) })
    expect(good.item).toMatchObject({ valid: true, complete: true, at: "check", errors: [] })
    expect(good.item.path).toEqual(["source", "database", "recordings", "check"])
  })

  it("**run apply saves only after the CLI's check succeeds**: a refused password keeps nothing", async () => {
    const { call, checks, kept, config } = harness()
    const wrong = await call(["office", "setup", "run", "apply", "--json", "--answer-stdin"], {
      stdin: `${JSON.stringify({ ...MYSQL, db: "nope" })}\n`,
    })
    expect(wrong.code).not.toBe(0)
    expect(wrong.error()).toMatchObject({ code: "authentication_error" })
    expect(config()).not.toContain("pbx.office.local")
    expect(kept()).toBeUndefined()

    const right = await call(["office", "setup", "run", "apply", "--json", "--answer-stdin"], {
      stdin: `${JSON.stringify(MYSQL)}\n`,
    })
    expect(right.code).toBe(0)
    expect(right.item).toMatchObject({ outcome: "ok", profile: "office", secrets: ["db"], calls_last_hour: 3 })
    expect(right.item.saved).toEqual(expect.arrayContaining(["cdr_source", "db_host", "db_port", "phone_region"]))
    expect(right.out).not.toContain(PASSWORD)
    expect(kept()).toBe(PASSWORD)
    expect(right.stderr).toContain('"event":"progress"')
    expect(checks.at(-1)?.settings.configured).toMatchObject({ db_host: "pbx.office.local", db_port: 3306 })
    expect(JSON.parse(config()).profiles.office).toMatchObject({ cdr_source: "mysql", db_host: "pbx.office.local" })

    const described = await call(["office", "setup", "show", "--json"])
    expect(described.item.values).toMatchObject({ db_host: "pbx.office.local", db: { set: true } })
    expect(described.out).not.toContain(PASSWORD)
  })

  it("**a check may say what to keep** in place of a secret as typed, and which account the profile is", async () => {
    const wrapped = JSON.stringify({ host: "pbx.office.local", password: PASSWORD })
    const { call, kept, env } = harness({ keep: { secrets: { db: wrapped }, account: "pbx.office.local:7" } })
    const right = await call(["office", "setup", "run", "apply", "--json", "--answer-stdin"], {
      stdin: `${JSON.stringify(MYSQL)}\n`,
    })
    expect(right.code).toBe(0)
    expect(kept()).toBe(wrapped)
    expect(right.item).toMatchObject({ outcome: "ok", secrets: ["db"], calls_last_hour: 3 })
    expect(right.item.keep).toBeUndefined()
    expect(right.out).not.toContain(PASSWORD)
    const remembered = readFileSync(join(env.PBX_STATE_DIR, "accounts", "office.json"), "utf8")
    expect(JSON.parse(remembered)).toEqual({ account: "pbx.office.local:7" })
  })

  it("**the terminal asks the same questions**, re-asks a wrong answer, and checks before it saves", async () => {
    const { call, config } = harness()
    const { code, item, stderr } = await call(["office", "setup"], {
      answer: ["2", "1", "pbx.office.local", "99999", "3306", "", "cdr", PASSWORD, "n", "", "", "ru"],
    })
    expect(stderr).toContain("Where are the call records?")
    expect(stderr).toMatch(/Port \(optional\).*65535/)
    expect(code).toBe(0)
    expect(item).toMatchObject({ profile: "office", finished: "done", results: { check: { outcome: "ok" } } })
    expect(JSON.parse(config()).profiles.office).toMatchObject({ db_name: "asteriskcdrdb", phone_region: ["RU"] })
  })

  it("**the terminal refuses without anyone to answer**", async () => {
    const { call } = harness()
    const { code, error } = await call(["office", "setup", "--json"], { answer: [] })
    expect(code).not.toBe(0)
    expect(error().message).toContain("run it in a terminal")
  })

  it("**run takes only apply in v1**", async () => {
    const { call } = harness()
    const { code, error } = await call(["office", "setup", "run", "oauth", "--json"], { stdin: "{}" })
    expect(code).not.toBe(0)
    expect(error().message).toContain("not a run action of v1")
  })

  it("**editing a profile in the terminal keeps its saved password** unless the owner asks to change it", async () => {
    const { call, checks, kept } = harness()
    await call(["office", "setup", "run", "apply", "--json", "--answer-stdin"], { stdin: `${JSON.stringify(MYSQL)}\n` })
    const { code, item } = await call(["office", "setup"], {
      answer: ["", "", "db2.office.local", "", "", "", "n", "", "", "", ""],
    })
    expect(code).toBe(0)
    expect(item.results).toEqual({ check: { outcome: "ok" } })
    expect(checks.at(-1)?.secrets).toEqual({})
    expect(checks.at(-1)?.settings.configured).toMatchObject({ db_host: "db2.office.local", cdr_source: "mysql" })
    expect(kept()).toBe(PASSWORD)
  })

  it("**an agent's run cannot save a setting the owner keeps for themselves**, as with config set", async () => {
    const { call, checks, config } = harness({ ownerOnly: { settings: ["db_host"] }, agent: true })
    const { code, error } = await call(["office", "setup", "apply", "--json"], { stdin: JSON.stringify(MYSQL) })
    expect(code).not.toBe(0)
    expect(error()).toMatchObject({ code: "permission_error" })
    expect(checks).toEqual([])
    expect(config()).not.toContain("pbx.office.local")
  })

  it.each([
    ["not JSON", "{db_host:"],
    ["not an object", "[1]"],
  ])("**answers that are %s are refused**", async (_, stdin) => {
    const { call } = harness()
    const { code, error } = await call(["office", "setup", "apply", "--dry-run", "--json"], { stdin })
    expect(code).not.toBe(0)
    expect(error()).toMatchObject({ code: "validation_error" })
  })

  // Every CLI that registers a flow lints its tree; a violation here lands in all of them.
  it("**the setup group passes the command lint with no overrides**", async () => {
    const setup = defineSetup({ ...flow, app, configuration })
    const streams = captureStreams()
    const definition = {
      app,
      configuration,
      commands: () => [commandsCommand(app), runsCommand(app), setupCommand(setup)],
    }
    expect(await run(["commands", "--json"], definition, { streams, tty: false, env: {} })).toBe(0)
    const folder = mkdtempSync(join(tmpdir(), "setup-lint-"))
    writeFileSync(join(folder, "commands.json"), streams.stdout.join(""))
    writeFileSync(join(folder, "overrides.json"), "[]")
    const lint = spawnSync(
      "node_modules/.bin/cli-dev",
      [
        "lint",
        "--commands",
        join(folder, "commands.json"),
        "--overrides",
        join(folder, "overrides.json"),
        "--allow-stale",
      ],
      { encoding: "utf8" },
    )
    expect(`${lint.stdout}${lint.stderr}`).toMatch(/lint: ok|, 0 new/)
    expect(lint.status).toBe(0)
  })
})
