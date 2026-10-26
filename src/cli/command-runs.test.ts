import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { wasSettled } from "../runs/recording.js"
import { findRun, KEEP_RUNS_FOR_DAYS, listRuns, readEvents, runsDirFor } from "../runs/run.js"
import { type CommandRunOptions, commandRuns, providerRequest, recordRuns, runSettings } from "./command-runs.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }

const sandbox = (): NodeJS.ProcessEnv => ({
  APP_STATE_DIR: join(mkdtempSync(join(tmpdir(), "command-runs-")), "state"),
})

const order = ({ command, profile, status }: { command: string; profile?: string; status: string }) =>
  [command, profile ?? "", status].join("\u0000")

// Runs started in the same millisecond list in no fixed order.
const kept = (env: NodeJS.ProcessEnv) =>
  listRuns(runsDirFor(app, env))
    .map(({ command, status, profile }) => ({ command, status, profile }))
    .sort((a, b) => (order(a) < order(b) ? -1 : 1))

const eventsOf = (env: NodeJS.ProcessEnv) => {
  const dir = runsDirFor(app, env)
  const [run] = listRuns(dir)
  const found = run ? findRun(dir, run.runId) : undefined
  if (!found) throw new Error("no run kept")
  return readEvents(found.dir).map(({ event, operation, status, outcome, error_code }) => ({
    event,
    operation,
    status,
    outcome,
    error_code,
  }))
}

const cli = async (
  env: NodeJS.ProcessEnv,
  args: string[],
  options: Partial<CommandRunOptions> = {},
  action: (name: string) => Promise<void> = async () => {},
) => {
  const program = new Command("app").exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
  program.option("--json")
  const notes = program.command("notes")
  notes.command("show <id>").action(async (id: string) => action(id))
  program.command("runs").action(async () => {
    throw new CliError("not_found", "reading the runs failed")
  })
  recordRuns(program, {
    app,
    settings: () => ({}),
    env,
    streams: captureStreams(),
    ...options,
  })
  return program.parseAsync(args, { from: "user" }).then(
    () => undefined,
    (error: unknown) => error,
  )
}

const failing = async () => {
  throw new CliError("not_found", "no note:9")
}

describe("recordRuns", () => {
  it("keeps a failed command without being asked, and a successful one only under --record", async () => {
    const env = sandbox()
    await cli(env, ["notes", "show", "note:1"])
    expect(kept(env)).toEqual([])
    await cli(env, ["notes", "show", "note:1", "--record"])
    await cli(env, ["notes", "show", "note:9"], {}, failing)
    expect(kept(env)).toEqual([
      { command: "notes show", status: "failed", profile: undefined },
      { command: "notes show", status: "success", profile: undefined },
    ])
  })

  it("keeps nothing under --no-record or a saved record: false, even a failure", async () => {
    const env = sandbox()
    await cli(env, ["notes", "show", "note:9", "--no-record"], {}, failing)
    await cli(env, ["notes", "show", "note:9"], { settings: () => ({ record: false }) }, failing)
    await cli(env, ["notes", "nonsense", "--no-record"])
    expect(kept(env)).toEqual([])
  })

  it("keeps every command when the config says record, and the defaults when it will not load", async () => {
    const env = sandbox()
    await cli(env, ["notes", "show", "note:1"], { settings: () => ({ record: true }) })
    await cli(
      env,
      ["notes", "show", "note:9"],
      {
        settings: () => {
          throw new Error("broken config")
        },
      },
      failing,
    )
    expect(kept(env).map(({ status }) => status)).toEqual(["failed", "success"])
  })

  it("keeps a usage mistake under the words that name a command, never its arguments", async () => {
    const env = sandbox()
    const failure = await cli(env, ["notes", "show", "Family Secrets", "--no-such-flag"])
    expect(failure).toMatchObject({ code: "commander.unknownOption" })
    await cli(env, ["notes", "nonsense-word"])
    expect(kept(env).map(({ command }) => command)).toEqual(["notes", "notes show"])
    expect(JSON.stringify(listRuns(runsDirFor(app, env)))).not.toContain("Family Secrets")
  })

  it("skips a leading profile word when the CLI takes one, and names the run for the selected profile", async () => {
    const env = sandbox()
    await cli(env, ["work", "notes", "show", "--nope"], { profile: () => "work" })
    await cli(env, ["notes", "show", "note:9"], { profile: () => "work" }, failing)
    await cli(
      env,
      ["notes", "show", "note:9"],
      {
        profile: () => {
          throw new Error("no such profile")
        },
      },
      failing,
    )
    await cli(env, ["work", "notes", "--nope"])
    expect(kept(env)).toEqual([
      { command: "app", status: "failed", profile: undefined },
      { command: "notes show", status: "failed", profile: undefined },
      { command: "notes show", status: "failed", profile: "work" },
      { command: "notes show", status: "failed", profile: "work" },
    ])
  })

  it("names an agent's run mcp <command>", async () => {
    const env = sandbox()
    await cli(env, ["notes", "show", "note:9"], { agent: true }, failing)
    expect(kept(env).map(({ command }) => command)).toEqual(["mcp notes show"])
  })

  it("never records reading the runs, nor help", async () => {
    const env = sandbox()
    await cli(env, ["runs", "--record"])
    await cli(env, ["--help"])
    await cli(env, ["notes", "--help"])
    expect(kept(env)).toEqual([])
  })

  it("keeps the error as the CLI recognises it, and settles it", async () => {
    const env = sandbox()
    const failure = await cli(env, ["notes", "show", "--nope"], {
      recognise: () => new CliError("validation_error", "unknown option"),
    })
    expect(wasSettled(failure)).toBe(false)
    expect(listRuns(runsDirFor(app, env))[0]).toMatchObject({ errorCode: "validation_error" })
  })

  it("writes provider calls into the command's run — the operation, never what the call carried", async () => {
    const env = sandbox()
    providerRequest("outside.any.run")({ status: 200 })
    await cli(env, ["notes", "show", "Family Secrets", "--record"], {}, async () => {
      providerRequest("mail.list")({ status: 0 })
      providerRequest("mail.read")({ error: new CliError("rate_limited", "Family Secrets") })
      providerRequest("files.get")({ status: 404, errorCode: "provider_error" })
      providerRequest("files.raw")({ error: new Error("socket hang up") })
    })
    expect(eventsOf(env)).toEqual([
      { event: "provider.request", operation: "mail.list" },
      { event: "provider.response", operation: "mail.list", status: 0, outcome: "ok" },
      { event: "provider.request", operation: "mail.read" },
      { event: "provider.response", operation: "mail.read", outcome: "error", error_code: "rate_limited" },
      { event: "provider.request", operation: "files.get" },
      {
        event: "provider.response",
        operation: "files.get",
        status: 404,
        outcome: "error",
        error_code: "provider_error",
      },
      { event: "provider.request", operation: "files.raw" },
      { event: "provider.response", operation: "files.raw", outcome: "error", error_code: "provider_error" },
    ])
  })
})

describe("commandRuns", () => {
  it("gives the run's id before it ends, settles a failure, and keeps the events it is handed", async () => {
    const env = sandbox()
    const runs = commandRuns({ app, settings: () => ({}), profile: () => "", env, streams: captureStreams() })
    const program = new Command("app").option("--record")
    const action = program.command("meetings").command("sync")
    program.parse(["meetings", "sync"], { from: "user" })
    expect(runs.runId()).toBeUndefined()
    runs.start(action)
    expect(runs.runId()).toMatch(/meetings-sync/)
    const sink = (event: Parameters<typeof runs.events>[0]) => runs.events(event)
    providerRequest("GET /v2/users/:id/recordings", sink)({ status: 500, errorCode: "provider_error" })
    const error = new CliError("provider_error", "Zoom refused")
    await runs.fail(error)
    expect(wasSettled(error)).toBe(true)
    expect(runs.runId()).toBeUndefined()
    expect(kept(env)).toEqual([{ command: "meetings sync", status: "failed", profile: undefined }])
    expect(eventsOf(env).map(({ operation }) => operation)).toEqual([
      "GET /v2/users/:id/recordings",
      "GET /v2/users/:id/recordings",
    ])
    await runs.succeed()
    expect(kept(env)).toHaveLength(1)
  })
})

describe("runSettings", () => {
  it("takes the flag first, then the config; keeps a failure unless either says no", () => {
    const days = KEEP_RUNS_FOR_DAYS
    expect(runSettings(undefined)).toEqual({ record: false, keepFailedRuns: true, keepRunsForDays: days })
    expect(runSettings(true, { record: false })).toEqual({ record: true, keepFailedRuns: true, keepRunsForDays: days })
    expect(runSettings(false, { record: true })).toEqual({
      record: false,
      keepFailedRuns: false,
      keepRunsForDays: days,
    })
    expect(runSettings(undefined, { record: false, keepRunsForDays: 7 })).toEqual({
      record: false,
      keepFailedRuns: false,
      keepRunsForDays: 7,
    })
    expect(runSettings(undefined, { record: true })).toMatchObject({ record: true, keepFailedRuns: true })
  })
})
