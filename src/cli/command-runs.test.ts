import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { wasSettled } from "../runs/recording.js"
import {
  findRun,
  KEEP_RUNS_FOR_DAYS,
  KEEP_SUCCESSFUL_RUNS_FOR_DAYS,
  listRuns,
  RUNS_SIZE_LIMIT_MB,
  readEvents,
  runsDirFor,
} from "../runs/run.js"
import { type CommandRunOptions, commandRuns, providerRequest, recordRuns, runSettings } from "./command-runs.js"
import { run } from "./program.js"

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
  it("keeps the words typed to a CLI's own program, and masks them when the config will not load", async () => {
    const argvOf = async (settings: CommandRunOptions["settings"]) => {
      const env = sandbox()
      await cli(env, ["notes", "show", "Fake meeting notes"], { settings }, failing)
      const dir = runsDirFor(app, env)
      const [file] = readdirSync(dir, { recursive: true }).filter((one) => String(one).endsWith("run.json"))
      return JSON.parse(readFileSync(join(dir, String(file)), "utf8")).argv
    }
    const broken = () => {
      throw new Error("unknown key no_such_key")
    }

    expect(await argvOf(() => ({}))).toEqual(["notes", "show", "Fake meeting notes"])
    expect(await argvOf(broken)).toEqual(["notes", "show", "[redacted]"])
  })

  it("keeps every command without being asked, a success with no events as an index line only", async () => {
    const env = sandbox()
    await cli(env, ["notes", "show", "note:1"])
    await cli(env, ["notes", "show", "note:9"], {}, failing)
    expect(kept(env)).toEqual([
      { command: "notes show", status: "failed", profile: undefined },
      { command: "notes show", status: "success", profile: undefined },
    ])
    const dir = runsDirFor(app, env)
    const success = listRuns(dir).find((one) => one.status === "success")
    expect(readdirSync(dir, { recursive: true }).filter((one) => String(one).endsWith("run.json"))).toHaveLength(1)
    expect(findRun(dir, success?.runId ?? "")?.metadata).toMatchObject({ command: "notes show", status: "success" })
  })

  it("keeps only failures under a saved record: false, and nothing under --no-record", async () => {
    const env = sandbox()
    await cli(env, ["notes", "show", "note:9", "--no-record"], {}, failing)
    await cli(env, ["notes", "nonsense", "--no-record"])
    expect(kept(env)).toEqual([])
    await cli(env, ["notes", "show", "note:1"], { settings: () => ({ record: false }) })
    await cli(env, ["notes", "show", "note:9"], { settings: () => ({ record: false }) }, failing)
    expect(kept(env)).toEqual([{ command: "notes show", status: "failed", profile: undefined }])
  })

  it("keeps only failures of the commands WireCat Desktop runs for its own pages, unless --record", async () => {
    const env = { ...sandbox(), WIRECAT_CALLER: "desktop" }
    await cli(env, ["notes", "show", "note:1"])
    await cli(env, ["notes", "show", "note:9"], {}, failing)
    expect(kept(env)).toEqual([{ command: "notes show", status: "failed", profile: undefined }])
    expect(listRuns(runsDirFor(app, env))[0]?.via).toBe("desktop")
    await cli(env, ["notes", "show", "note:1", "--record"])
    expect(kept(env)).toHaveLength(2)
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

  it("names a usage mistake's run by the words that name a command; its arguments stay only in argv", async () => {
    const env = sandbox()
    const failure = await cli(env, ["notes", "show", "Family Secrets", "--no-such-flag"])
    expect(failure).toMatchObject({ code: "commander.unknownOption" })
    await cli(env, ["notes", "nonsense-word"])
    expect(kept(env).map(({ command }) => command)).toEqual(["notes", "notes show"])
    expect(listRuns(runsDirFor(app, env)).find(({ command }) => command === "notes show")?.argv).toEqual([
      "notes",
      "show",
      "Family Secrets",
      "--no-such-flag",
    ])
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

  it("**keeps the command line as typed under run()**, a secret hidden, and masks it when record_input is off", async () => {
    const argvKept = async (recordInput?: boolean) => {
      const env = { ...sandbox(), APP_PROFILE: "work" }
      const runs = commandRuns({ app, settings: () => ({ record: true, recordInput }), env })
      const definition = {
        app,
        commands: () => [
          new Command("meetings").addCommand(
            new Command("search")
              .argument("<words>")
              .option("--token <token>")
              .action(async function (this: Command) {
                runs.start(this)
                await runs.succeed()
              }),
          ),
        ],
      }
      const typed = ["meetings", "search", "Fake planning call", "--token=fake-token-value"]
      expect(await run(typed, definition, { streams: captureStreams(), tty: false, env })).toBe(0)
      return listRuns(runsDirFor(app, env))[0]?.argv
    }

    expect(await argvKept()).toEqual(["meetings", "search", "Fake planning call", "--token=[redacted]"])
    expect(await argvKept(false)).toEqual(["meetings", "search", "[redacted]", "--token=[redacted]"])
  })
})

describe("runSettings", () => {
  it("takes the flag first, then the config; keeps every run unless one says no, and failures unless --no-record", () => {
    const kept = {
      keepRunsForDays: KEEP_RUNS_FOR_DAYS,
      keepSuccessfulRunsForDays: KEEP_SUCCESSFUL_RUNS_FOR_DAYS,
      runsSizeLimitMb: RUNS_SIZE_LIMIT_MB,
    }
    expect(runSettings(undefined)).toEqual({ record: true, keepFailedRuns: true, ...kept })
    expect(runSettings(true, { record: false })).toEqual({ record: true, keepFailedRuns: true, ...kept })
    expect(runSettings(false, { record: true })).toEqual({ record: false, keepFailedRuns: false, ...kept })
    expect(
      runSettings(undefined, { record: false, keepRunsForDays: 9, keepSuccessfulRunsForDays: 2, runsSizeLimitMb: 5 }),
    ).toEqual({
      record: false,
      keepFailedRuns: true,
      keepRunsForDays: 9,
      keepSuccessfulRunsForDays: 2,
      runsSizeLimitMb: 5,
    })
    expect(runSettings(undefined, { record: true })).toMatchObject({ record: true, keepFailedRuns: true })
  })
})
