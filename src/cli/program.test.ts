import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { annotate, type CommandMeta } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startRecording } from "../runs/recording.js"
import { listRuns } from "../runs/run.js"
import { writesInFlight } from "../sends/guarded.js"
import { baseContext, environmentOf, runBudgetOf } from "./context.js"
import { sharedCommandTemplate } from "./contract-templates.js"
import * as cli from "./index.js"
import { createProgram, type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }
const { resolveSettings } = settingsFor(app)

/** An error as another copy of cli-base builds it: the same name and code, a different class. */
const foreignFailure = (code: string, message: string) =>
  Object.assign(new Error(message), { name: "CliError", code, details: { candidates: [{ id: "1" }] } })

const definition = (action: (command: Command) => Promise<void>, meta: CommandMeta = {}) => ({
  app,
  commands: () => [
    new Command("chats").addCommand(
      annotate(new Command("list"), meta).action(async function (this: Command) {
        await action(this)
      }),
    ),
  ],
})

const call = async (argv: string[], action: (command: Command) => Promise<void> = async () => {}) => {
  const streams = captureStreams()
  const code = await run(argv, definition(action), { streams, tty: false, env: process.env })
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("running a messenger CLI", () => {
  it("**knows a CliError built by another copy of cli-base**, and keeps its code and details", async () => {
    const { code, stdout, stderr } = await call(["chats", "list"], async () => {
      throw foreignFailure("validation_error", '"Va" matches 2 chats')
    })

    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0] ?? "").error).toMatchObject({
      code: "validation_error",
      reason: "input.invalid",
      details: { candidates: [{ id: "1" }] },
    })
  })

  it("answers a profile with no command after it with a validation error, not help on stdout", async () => {
    const { code, stdout, stderr } = await call(["personal"])

    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr[0]).toContain("read as a profile name")
  })

  it("**shows the help at a terminal when no command is given**, and a validation error to a script", async () => {
    const terminal = captureStreams()
    const code = await run(
      [],
      definition(async () => {}),
      { streams: terminal, tty: true, env: process.env },
    )
    const script = await call([])
    const json = captureStreams()
    await run(
      ["--json"],
      definition(async () => {}),
      { streams: json, tty: true, env: process.env },
    )

    expect(code).toBe(2)
    expect(terminal.stdout).toEqual([])
    expect(terminal.stderr.join("\n")).toContain("Usage:")
    expect(terminal.stderr.join("\n")).not.toContain("(outputHelp)")
    expect(script.code).toBe(2)
    expect(JSON.parse(script.stderr[0] ?? "").error.message).toContain("give a command")
    expect(JSON.parse(json.stderr[0] ?? "").error.message).toContain("give a command")
  })

  it("**points a script at the group's own help** when a group is given no subcommand (WC-CMD-3)", async () => {
    const { code, stdout, stderr } = await call(["chats"])

    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0] ?? "").error.message).toBe("give a command — run `app chats --help` for the commands")
  })

  it("**shows a group's own help at a terminal** when it is given no subcommand", async () => {
    const terminal = captureStreams()
    const code = await run(
      ["chats"],
      definition(async () => {}),
      { streams: terminal, tty: true, env: process.env },
    )
    const help = terminal.stderr.join("\n")

    expect(code).toBe(2)
    expect(terminal.stdout).toEqual([])
    expect(help).toContain("Usage: app <profile> chats")
    expect(help).toMatch(/^\s+list\b/m)
    expect(help).not.toContain("(outputHelp)")
  })

  it.each([
    [["chats list", "--help"], "app chats list"],
    [["--json", "personal", "chats list"], "app personal chats list"],
    [["personal", "chats list"], "app personal chats list"],
    [["personal", "--json", "chats list", "--limit", "5"], "app personal chats list"],
  ])("refuses a command path given as one argument, %j, instead of printing the root help", async (argv, fix) => {
    let ran = false
    const { code, stdout, stderr } = await call(argv, async () => {
      ran = true
    })

    expect(ran).toBe(false)
    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0] ?? "").error.message).toBe(`"chats list" was given as one argument; run: ${fix}`)
  })

  it("logs each parsed command and its long options to <PREFIX>_TEST_ARGV_LOG, never a value", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "argv-")), "argv.jsonl")
    const streams = captureStreams()
    await run(
      ["personal", "chats", "list", "--json", "--timeout", "5s"],
      definition(async () => {}),
      { streams, tty: false, env: { ...process.env, APP_TEST_ARGV_LOG: file } },
    )

    expect(readFileSync(file, "utf8")).toBe(
      `${JSON.stringify({ command: "chats list", options: ["--json", "--timeout"] })}\n`,
    )
  })

  it("logs --version to <PREFIX>_TEST_ARGV_LOG, which ends before any command is parsed", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "argv-")), "argv.jsonl")
    const code = await run(
      ["--version"],
      definition(async () => {}),
      {
        streams: captureStreams(),
        tty: false,
        env: { ...process.env, APP_TEST_ARGV_LOG: file },
      },
    )

    expect(code).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify({ command: "", options: ["--version"] })}\n`)
  })

  it("hands the command its platform, the process's unless a test gives one", async () => {
    let seen: unknown
    const streams = captureStreams()
    const record = definition(async (command) => {
      seen = environmentOf(command).platform
    })
    await run(["chats", "list"], record, { streams, tty: false, env: process.env })
    const real = seen
    await run(["chats", "list"], record, { streams, tty: false, env: process.env, platform: "win32" })

    expect([real, seen]).toEqual([process.platform, "win32"])
  })

  it("never reads a positional after -- as a command path", async () => {
    let given: string | undefined
    const notes = new Command("notes").argument("[text]").action((text: string) => {
      given = text
    })
    notes.addCommand(new Command("add").action(() => {}))
    const code = await run(
      ["notes", "--", "add milk"],
      { app, commands: () => [notes] },
      {
        streams: captureStreams(),
        tty: false,
        env: process.env,
      },
    )

    expect([code, given]).toEqual([0, "add milk"])
  })

  it("hands the first word to the command as its profile", async () => {
    let profile = ""
    await call(["work", "chats", "list"], async (command) => {
      profile = baseContext(command, resolveSettings).settings.profile
    })
    expect(profile).toBe("work")
  })

  it("writes a subcommand's help to the injected stdout, not the terminal", async () => {
    const { code, stdout } = await call(["chats", "--help"])

    expect(code).toBe(0)
    expect(stdout.join("\n")).toContain("list")
  })

  it("**says a mistyped command on one line**, with commander's suggestion", async () => {
    const { stderr } = await call(["work", "chts"])

    expect(JSON.parse(stderr[0] ?? "").error.message).toMatch(/^unknown command 'chts' \(Did you mean chats\?\) /)
  })

  it("**puts the profile in the usage line** of a profile's command, and not in one that reads none", async () => {
    const commands = () => [new Command("chats").addCommand(new Command("list")), new Command("upgrade")]
    const usage = async (argv: string[]) => {
      const streams = captureStreams()
      await run(argv, { app, commands }, { streams, tty: false, env: process.env })
      return streams.stdout.join("\n").split("\n")[0]
    }

    expect(await usage(["work", "chats", "list", "--help"])).toBe("Usage: app <profile> chats list [options]")
    expect(await usage(["upgrade", "--help"])).toBe("Usage: app upgrade [options]")
    expect(await usage(["--help-all"])).toBe("Usage: app [profile] [options] <command>")
  })

  it("says which word was read as a profile when the command after it is unknown", async () => {
    const { code, stderr } = await call(["chat", "list"])

    expect(code).toBe(2)
    expect(JSON.parse(stderr[0] ?? "").error.message).toMatch(/ — "chat" is not a command/)
  })

  it("**closes what the command tracked when --timeout expires**, then reports a timeout", async () => {
    let closed = false
    const { code, stderr } = await call(["--timeout", "20ms", "chats", "list"], async (command) => {
      const context = baseContext(command, resolveSettings)
      await context.run(async () => {
        context.track({
          close: async () => {
            closed = true
          },
        })
        await new Promise(() => {})
      })
    })

    expect(closed).toBe(true)
    expect(code).toBe(9)
    expect(JSON.parse(stderr[0] ?? "").error.code).toBe("timeout")
  })
})

describe("the default whole-command deadline", () => {
  const hanging = async (env: NodeJS.ProcessEnv, meta: CommandMeta = {}) => {
    let started: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const action = async (command: Command) => {
      await baseContext(command, resolveSettings).run(async () => {
        started()
        await new Promise(() => {})
      })
    }
    const streams = captureStreams()
    const done = run(["chats", "list"], definition(action, meta), { streams, tty: false, env })
    await reached
    return { done }
  }

  afterEach(() => vi.useRealTimers())

  it("ends an ordinary command after 30 s, and leaves a background fetch job running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const ordinary = await hanging({ ...process.env })
    await vi.advanceTimersByTimeAsync(31_000)
    vi.useRealTimers()
    expect(await ordinary.done).toBe(9)

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const job = await hanging({ ...process.env, APP_BACKFILL_JOB: "20261011T000000-abcdef" })
    await vi.advanceTimersByTimeAsync(31_000)
    let ended = false
    void job.done.then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(false)
  })
})

describe("a command's declared lifetime", () => {
  afterEach(() => vi.useRealTimers())

  it.each(["persistent", "interactive"] as const)("gives a %s command no default deadline", async (lifetime) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let started: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const done = run(
      ["chats", "list"],
      definition(
        async (command) => {
          await baseContext(command, resolveSettings).run(async () => {
            started()
            await new Promise(() => {})
          })
        },
        { lifetime },
      ),
      { streams: captureStreams(), tty: true, env: { ...process.env, CI: undefined } },
    )
    await reached
    await vi.advanceTimersByTimeAsync(31_000)
    let ended = false
    void done.then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(false)
  })
  it("bounds an interactive command in CI even when a terminal is present", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const done = run(
      ["chats", "list"],
      definition(
        async (command) => {
          await baseContext(command, resolveSettings).run(async () => {
            entered()
            await new Promise(() => {})
          })
        },
        { lifetime: "interactive" },
      ),
      { streams: captureStreams(), tty: true, env: { ...process.env, CI: "true" } },
    )
    await started
    await vi.advanceTimersByTimeAsync(31_000)
    let ended = false
    void done.then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(await done).toBe(9)
  })
})

describe("the deadline a command sees", () => {
  it("is the one run() started, so a sync's budget can stop before it", async () => {
    const seen: unknown[] = []
    const code = await run(
      ["chats", "list", "--timeout", "1m"],
      definition(async (command) => {
        seen.push(environmentOf(command).deadline?.()?.ms, runBudgetOf(command).limit)
      }),
      { streams: captureStreams(), tty: false, env: { ...process.env } },
    )
    expect(code).toBe(0)
    expect(seen).toEqual([60_000, 25])
  })

  it("is 30 s for a one-shot command, 5 minutes for a cooperative one, 15 minutes for a cooperative sync, 45 s for a cooperative one over MCP", async () => {
    const deadlineOf = async (meta: CommandMeta, extra: Record<string, unknown> = {}, argv: string[] = []) => {
      let ms: number | undefined
      await run(
        ["chats", "list", ...argv],
        definition(async (command) => {
          ms = environmentOf(command).deadline?.()?.ms
        }, meta),
        { streams: captureStreams(), tty: false, env: { ...process.env }, ...extra },
      )
      return ms
    }
    const agent = { agent: { result: () => {}, failure: () => {} } }
    expect(await deadlineOf({})).toBe(30_000)
    expect(await deadlineOf({ cooperative: true })).toBe(300_000)
    expect(await deadlineOf({ cooperative: true, partial: true })).toBe(900_000)
    expect(await deadlineOf({ cooperative: true }, agent)).toBe(45_000)
    expect(await deadlineOf({ cooperative: true, partial: true }, agent)).toBe(45_000)
    expect(await deadlineOf({ cooperative: true }, agent, ["--timeout", "20s"])).toBe(20_000)
  })
})

describe("a phase that runs until stopped", () => {
  afterEach(() => vi.useRealTimers())

  const phased = (options: { signal?: AbortSignal } = {}) => {
    const streams = captureStreams()
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const done = run(
      ["chats", "list"],
      definition(async (command) => {
        const stop = environmentOf(command).untilStopped?.()
        entered()
        await new Promise((resolve) => stop?.addEventListener("abort", resolve, { once: true }))
        environmentOf(command).streams?.data("kept 3 batches")
      }),
      { streams, tty: false, env: { ...process.env }, ...options },
    )
    return { done, started, streams }
  }

  it("outlives the default deadline, and ends 0 with its answer on Ctrl-C", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { done, started, streams } = phased()
    await started
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    let ended = false
    void done.then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(false)
    vi.useRealTimers()

    process.emit("SIGINT")

    expect(await done).toBe(0)
    expect(streams.stdout).toEqual(["kept 3 batches"])
  })

  it("ends as any signal does on a second Ctrl-C, when the command ignores its phase", async () => {
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const done = run(
      ["chats", "list"],
      definition(async (command) => {
        environmentOf(command).untilStopped?.()
        entered()
        await new Promise(() => {})
      }),
      { streams: captureStreams(), tty: false, env: { ...process.env } },
    )
    await started

    process.emit("SIGINT")
    process.emit("SIGINT")

    expect(await done).toBe(130)
  })

  it("keeps an explicit --timeout, which ends the phase instead of the command", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const streams = captureStreams()
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let reason: unknown
    const done = run(
      ["chats", "list", "--timeout", "2m"],
      definition(async (command) => {
        const stop = environmentOf(command).untilStopped?.()
        entered()
        await new Promise((resolve) => stop?.addEventListener("abort", resolve, { once: true }))
        reason = stop?.reason
        environmentOf(command).streams?.data("kept 1 batch")
      }),
      { streams, tty: false, env: { ...process.env } },
    )
    await started
    await vi.advanceTimersByTimeAsync(119_000)
    expect(reason).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    vi.useRealTimers()

    expect(await done).toBe(0)
    expect(reason).toMatchObject({ code: "timeout" })
    expect(streams.stdout).toEqual(["kept 1 batch"])
  })

  const ending = (
    argv: string[],
    rest: (stop: AbortSignal | undefined, command: Command) => Promise<void>,
    options: { signal?: AbortSignal; streams?: ReturnType<typeof captureStreams> } = {},
  ) => {
    let entered: (stop: AbortSignal | undefined) => void = () => {}
    const started = new Promise<AbortSignal | undefined>((resolve) => {
      entered = resolve
    })
    const done = run(
      argv,
      definition(async (command) => {
        const stop = environmentOf(command).untilStopped?.()
        entered(stop)
        await rest(stop, command)
      }),
      { streams: captureStreams(), tty: false, env: { ...process.env }, ...options },
    )
    return { done, started }
  }

  it("gives the steps after an ended phase the default deadline again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { done, started } = ending(["chats", "list"], async (_stop, command) => {
      await new Promise((resolve) => setTimeout(resolve, 10 * 60_000))
      environmentOf(command).endUntilStopped?.()
      await new Promise(() => {})
    })
    const stop = await started
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 29_000)
    let ended = false
    void done.then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(false)

    await vi.advanceTimersByTimeAsync(1_100)
    vi.useRealTimers()

    expect(await done).toBe(9)
    expect(stop?.aborted).toBe(false)
  })

  it("gives a headless interactive command the default deadline once its phase ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const done = run(
      ["chats", "list"],
      definition(
        async (command) => {
          environmentOf(command).untilStopped?.()
          await new Promise((resolve) => setTimeout(resolve, 4 * 60_000))
          environmentOf(command).endUntilStopped?.()
          entered()
          await new Promise(() => {})
        },
        { lifetime: "interactive" },
      ),
      { streams: captureStreams(), tty: false, env: { ...process.env, CI: undefined } },
    )
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    await started
    await vi.advanceTimersByTimeAsync(29_000)
    let ended = false
    void done.then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(false)

    await vi.advanceTimersByTimeAsync(1_100)
    vi.useRealTimers()

    expect(ended).toBe(true)
    expect(await done).toBe(9)
  })

  it("leaves an interactive command at a terminal unbounded after its phase, while it may ask the person", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const done = run(
      ["chats", "list"],
      definition(
        async (command) => {
          environmentOf(command).untilStopped?.()
          environmentOf(command).endUntilStopped?.()
          await new Promise((resolve) => setTimeout(resolve, 10 * 60_000))
        },
        { lifetime: "interactive" },
      ),
      { streams: captureStreams(), tty: true, env: { ...process.env, CI: undefined } },
    )
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    vi.useRealTimers()

    expect(await done).toBe(0)
  })

  it("ends the command, not a phase, on Ctrl-C after the phase ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { done, started } = ending(["chats", "list"], async (_stop, command) => {
      environmentOf(command).endUntilStopped?.()
      await new Promise(() => {})
    })
    const stop = await started

    process.emit("SIGINT")
    await vi.advanceTimersByTimeAsync(1_100)
    vi.useRealTimers()

    expect(await done).toBe(130)
    expect(stop?.aborted).toBe(false)
  })

  it("reports a write the fresh deadline cut as an unknown outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const streams = captureStreams()
    const { done } = ending(
      ["chats", "list", "--json"],
      async (_stop, command) => {
        environmentOf(command).endUntilStopped?.()
        writesInFlight.getStore()?.add({ operationId: "op-after-phase", cut: () => {} })
        await new Promise(() => {})
      },
      { streams },
    )

    await vi.advanceTimersByTimeAsync(31_100)
    vi.useRealTimers()
    await done

    expect(JSON.parse(streams.stderr[0] ?? "").error).toMatchObject({
      code: "outcome_unknown",
      details: { operation_ids: ["op-after-phase"] },
    })
  })

  it("starts no deadline when a command ends its phase after the run returned", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let end: (() => void) | undefined
    const { done } = ending(["chats", "list"], async (_stop, command) => {
      end = environmentOf(command).endUntilStopped
    })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await done).toBe(0)

    end?.()

    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it("starts no phase timer when a command asks for a phase under --timeout after the run returned", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let late: (() => AbortSignal | undefined) | undefined
    const { done } = ending(["chats", "list", "--timeout", "2m"], async (_stop, command) => {
      environmentOf(command).endUntilStopped?.()
      late = environmentOf(command).untilStopped
    })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await done).toBe(0)

    late?.()

    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it("gives a second phase after --timeout ended the first a full --timeout of its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let second: AbortSignal | undefined
    const { done, started } = ending(["chats", "list", "--timeout", "2m"], async (stop, command) => {
      await new Promise((resolve) => stop?.addEventListener("abort", resolve, { once: true }))
      second = environmentOf(command).untilStopped?.()
      await new Promise((resolve) => second?.addEventListener("abort", resolve, { once: true }))
    })
    await started
    await vi.advanceTimersByTimeAsync(121_000)
    expect(second?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(118_000)
    expect(second?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2_100)
    vi.useRealTimers()

    expect(second?.reason).toMatchObject({ code: "timeout" })
    expect(await done).toBe(0)
  })

  it("gives the steps after a phase that --timeout ended a fresh full --timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { done, started } = ending(["chats", "list", "--timeout", "2m"], async (stop) => {
      await new Promise((resolve) => stop?.addEventListener("abort", resolve, { once: true }))
      await new Promise(() => {})
    })
    const stop = await started
    await vi.advanceTimersByTimeAsync(121_000)
    expect(stop?.reason).toMatchObject({ code: "timeout" })
    let ended = false
    void done.then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(118_000)
    expect(ended).toBe(false)

    await vi.advanceTimersByTimeAsync(2_100)
    vi.useRealTimers()

    expect(await done).toBe(9)
  })

  it("bounds the steps after a phase that Ctrl-C ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { done, started } = ending(["chats", "list"], async (stop) => {
      await new Promise((resolve) => stop?.addEventListener("abort", resolve, { once: true }))
      await new Promise(() => {})
    })
    await started
    process.emit("SIGINT")

    await vi.advanceTimersByTimeAsync(30_100)
    vi.useRealTimers()

    expect(await done).toBe(9)
  })

  it("stops the --timeout timer of a phase that ended, and starts the command's deadline afresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { done, started } = ending(["chats", "list", "--timeout", "2m"], async (_stop, command) => {
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      environmentOf(command).endUntilStopped?.()
      await new Promise(() => {})
    })
    const stop = await started
    await vi.advanceTimersByTimeAsync(179_000)
    expect(stop?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1_100)
    vi.useRealTimers()

    expect(await done).toBe(9)
  })

  it("ends 0 with its answer when the caller cancels", async () => {
    const cancel = new AbortController()
    const { done, started, streams } = phased({ signal: cancel.signal })
    await started

    cancel.abort()

    expect(await done).toBe(0)
    expect(streams.stdout).toEqual(["kept 3 batches"])
  })
})

describe("consumer lifecycle in the shared shell", () => {
  const execute = async (argv: string[], overrides: Partial<ProgramDefinition>) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      { ...definition(async () => {}), ...overrides },
      {
        streams,
        tty: false,
        env: process.env,
      },
    )
    return { code, stdout: streams.stdout, stderr: streams.stderr }
  }

  it("configures local root options and preserves injected help for added commands", () => {
    const output: string[] = []
    const program = createProgram(
      {
        ...definition(async () => {}),
        configure: (root) => {
          root.option("--serve", "start the connection server")
          root.addCommand(new Command("local").description("a local command"))
        },
      },
      { out: (line) => output.push(line) },
    )
    program.commands.find((command) => command.name() === "local")?.outputHelp()
    expect(output.join("\n")).toContain("a local command")
    expect(program.options.some((option) => option.long === "--serve")).toBe(true)
  })

  it("prepares legacy context with the shared streams before a profile's action", async () => {
    const contexts = new WeakMap<Command, unknown>()
    let root: Command | undefined
    const result = await execute(["work", "chats", "list", "--serve"], {
      configure: (program) => {
        program.option("--serve", "start the connection server")
      },
      prepare: async (program, environment) => {
        await Promise.resolve()
        root = program
        contexts.set(program, environment)
      },
      commands: () => [
        new Command("chats").addCommand(
          new Command("list").action(function (this: Command) {
            if (!root) throw new Error("context was not prepared")
            expect(contexts.get(root)).toBe(environmentOf(this))
            expect(this.optsWithGlobals()).toMatchObject({ profile: "work", serve: true })
            environmentOf(this).streams?.data('{"ok":true}')
          }),
        ),
      ],
    })
    expect(result).toMatchObject({ code: 0, stdout: ['{"ok":true}'], stderr: [] })
  })

  it.each(["--help", "--version"])("does not settle a failure for %s", async (flag) => {
    const onFailure = vi.fn()
    const prepare = vi.fn()
    const result = await execute([flag], { onFailure, prepare })
    expect(result.code).toBe(0)
    expect(result.stdout.length).toBeGreaterThan(0)
    expect(onFailure).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it("reports a preparation failure without executing the command", async () => {
    const action = vi.fn()
    const onFailure = vi.fn()
    const error = new CliError("permission_error", "synthetic refusal")
    const result = await execute(["chats", "list", "--no-record"], {
      ...definition(action),
      prepare: () => {
        throw error
      },
      onFailure,
    })
    expect(result.stdout).toEqual([])
    expect(JSON.parse(result.stderr[0] ?? "").error.code).toBe("permission_error")
    expect(action).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(error, expect.any(Command))
  })

  it("awaits consumer settlement and does not create a second fallback run", async () => {
    const state = mkdtempSync(join(tmpdir(), "shell-settlement-"))
    const env = { ...process.env, APP_PROFILE: "default", APP_STATE_DIR: state }
    const streams = captureStreams()
    const error = new CliError("validation_error", "synthetic command failure")
    let finished = false
    const code = await run(
      ["chats", "list"],
      {
        ...definition(async () => {
          throw error
        }),
        onFailure: async (failure) => {
          await startRecording({
            app,
            command: "chats list",
            profile: "default",
            record: true,
            keepFailed: true,
            trace: false,
            format: "json",
            streams,
            env,
          }).fail(failure)
          finished = true
        },
      },
      { streams, env, tty: false },
    )
    expect(code).toBe(2)
    expect(finished).toBe(true)
    expect(readdirSync(join(state, "runs")).filter((name) => !name.startsWith("."))).toHaveLength(1)
    expect(streams.stdout).toEqual([])
    expect(JSON.parse(streams.stderr[0] ?? "").error.code).toBe("validation_error")
  })

  it("preserves the original failure when settlement throws, without exposing handler text", async () => {
    const result = await execute(["chats", "list", "--no-record"], {
      ...definition(async () => {
        throw new CliError("not_found", "synthetic missing item")
      }),
      onFailure: async () => {
        throw new Error("synthetic private handler content")
      },
    })
    expect(result.code).toBe(6)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toHaveLength(1)
    expect(JSON.parse(result.stderr[0] ?? "").error).toMatchObject({
      code: "not_found",
      details: { settlement_failed: true },
    })
    expect(result.stderr.join("\n")).not.toContain("private handler content")
  })

  it("settles a missing-command failure without preparing resources", async () => {
    const prepare = vi.fn()
    const onFailure = vi.fn()
    const result = await execute(["work"], { prepare, onFailure })
    expect(result.code).toBe(2)
    expect(result.stdout).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledOnce()
  })
})

describe.each(["max", "tg"])("shared shell contract for %s", (name) => {
  it("uses identical machine output and failure codes with a provider definition", async () => {
    const streams = captureStreams()
    const provider: ProgramDefinition = {
      app: { ...app, command: name },
      commands: () => [
        new Command("messages").addCommand(
          new Command("list").action(function (this: Command) {
            const environment = environmentOf(this)
            if (this.optsWithGlobals().offline) throw new CliError("not_found", "nothing recorded")
            environment.streams?.data('{"items":[],"hasMore":false}')
          }),
        ),
      ],
    }
    const options = { streams, tty: false, env: process.env }
    expect(await run(["messages", "list", "--json", "--no-record"], provider, options)).toBe(0)
    expect(streams.stdout).toEqual(['{"items":[],"hasMore":false}'])
    expect(streams.stderr).toEqual([])
    streams.stdout.length = 0
    expect(await run(["messages", "list", "--offline", "--no-record"], provider, options)).toBe(6)
    expect(streams.stdout).toEqual([])
    expect(JSON.parse(streams.stderr[0] ?? "")).toMatchObject({
      error: { code: "not_found", reason: "item.not-found", message: "nothing recorded" },
    })
  })
})

describe("the runner's configuration seam", () => {
  it.each(["bot", "chats"])(
    "keeps early %s failures with the matching scope and configured profile",
    async (resource) => {
      const state = mkdtempSync(join(tmpdir(), "shell-scope-"))
      const env = { ...process.env, APP_PROFILE: "default", APP_STATE_DIR: state }
      const streams = captureStreams()
      const scopes: unknown[] = []
      const provider: ProgramDefinition = {
        app,
        configuration: {
          resolveSettings: (_flags, options) => {
            scopes.push(options?.kind)
            return {
              profile: "configured",
              keepFailedRuns: options?.kind === "bot",
              keepRunsForDays: 7,
              skillHint: false,
            }
          },
        },
        commands: () => [
          new Command(resource).addCommand(
            new Command("show").action(() => {
              throw new CliError("validation_error", "synthetic early failure")
            }),
          ),
        ],
      }
      const code = await run(["--timeout", "1s", "--quiet", resource, "show"], provider, { env, streams, tty: false })
      expect(code).toBe(2)
      expect(scopes).toEqual([resource === "bot" ? "bot" : "personal"])
      const runs = listRuns(join(state, "runs"))
      expect(runs).toHaveLength(resource === "bot" ? 1 : 0)
      if (resource === "bot")
        expect(runs[0]).toMatchObject({ profile: "configured", command: "bot show", errorCode: "validation_error" })
      expect(streams.stdout).toEqual([])
      expect(JSON.parse(streams.stderr[0] ?? "").error.code).toBe("validation_error")
    },
  )
})

it("does not blame a profile when a known resource has an unknown subcommand", async () => {
  const result = await call(["work", "chats", "missing"])
  expect(result.code).toBe(2)
  expect(result.stderr.join("\n")).toContain("unknown command 'missing'")
  expect(result.stderr.join("\n")).not.toContain("read as a profile name")
})

it("previews housekeeping with --dry-run without a profile, and still asks for one where permissions apply", async () => {
  const home = mkdtempSync(join(tmpdir(), "dry-run-"))
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") }
  const preview = async (argv: string[]) => {
    const streams = captureStreams()
    const commands = () => [
      new Command("skill").addCommand(new Command("install").action(() => {})),
      new Command("chats").addCommand(new Command("list").action(() => {})),
    ]
    return { code: await run(argv, { app, commands }, { streams, tty: false, env }), streams }
  }
  const skill = await preview(["skill", "install", "--dry-run", "--json"])
  expect([skill.code, skill.streams.stderr]).toEqual([0, []])
  expect(JSON.parse(skill.streams.stdout[0] ?? "").item.preview).toBe(true)
  expect((await preview(["chats", "list", "--dry-run", "--json"])).code).toBe(2)
})

describe("machine failures", () => {
  const cases = [
    ["unknown root", ["missing", "operation"]],
    ["unknown child", ["items", "missing"]],
    ["unknown option", ["items", "show", "synthetic", "--missing"]],
    ["missing operand", ["items", "show"]],
    ["missing option value", ["items", "show", "synthetic", "--mode"]],
    ["invalid choice", ["items", "show", "synthetic", "--mode", "missing"]],
    ["missing command", []],
  ] as const

  it.each(cases)("returns one JSON validation failure for %s without running the action", async (_, words) => {
    for (const tty of [true, false]) {
      for (const format of ["--json", "--jsonl"]) {
        const action = vi.fn()
        const prepare = vi.fn()
        const streams = captureStreams()
        const code = await run(
          [...words, format, "--no-record"],
          {
            app,
            prepare,
            commands: () => [
              new Command("items").addCommand(
                new Command("show")
                  .argument("<name>")
                  .addOption(new Option("--mode <mode>").choices(["compact", "full"]))
                  .action(action),
              ),
            ],
          },
          { streams, tty, env: process.env },
        )
        expect(code).toBe(2)
        expect(streams.stdout).toEqual([])
        expect(streams.stderr).toHaveLength(1)
        expect(JSON.parse(streams.stderr[0] ?? "").error).toMatchObject({ code: "validation_error" })
        expect(action).not.toHaveBeenCalled()
        expect(prepare).not.toHaveBeenCalled()
      }
    }
  })

  it.each(["--json", "--jsonl"])("keeps an explicit %s error structured with a TTY", async (format) => {
    const streams = captureStreams()
    const code = await run(
      ["chats", "list", format, "--no-record"],
      definition(async () => {
        throw new CliError("not_found", "synthetic missing item", { candidates: [{ id: "7" }] })
      }),
      { streams, tty: true, env: process.env },
    )
    expect(code).toBe(6)
    expect(streams.stdout).toEqual([])
    expect(streams.stderr).toHaveLength(1)
    expect(JSON.parse(streams.stderr[0] ?? "").error).toMatchObject({
      code: "not_found",
      details: { candidates: [{ id: "7" }] },
    })
  })

  it("does not treat a literal --json after the delimiter as an output flag", async () => {
    const streams = captureStreams()
    const code = await run(
      ["item", "--no-record", "--", "--json"],
      {
        app,
        commands: () => [
          new Command("item").argument("<name>").action(() => {
            throw new CliError("not_found", "synthetic missing item")
          }),
        ],
      },
      { streams, tty: true, env: process.env },
    )
    expect(code).toBe(6)
    expect(streams.stderr).toHaveLength(1)
    expect(streams.stderr[0]).toBe("✗ synthetic missing item")
  })

  it("uses JSON for a preparation failure before command options have been parsed", async () => {
    const streams = captureStreams()
    const action = vi.fn()
    const code = await run(
      ["chats", "list", "--json", "--no-record"],
      {
        ...definition(action),
        prepare: () => {
          throw new CliError("permission_error", "synthetic refusal")
        },
      },
      { streams, tty: true, env: process.env },
    )
    expect(code).toBe(5)
    expect(streams.stderr).toHaveLength(1)
    expect(JSON.parse(streams.stderr[0] ?? "").error.code).toBe("permission_error")
    expect(action).not.toHaveBeenCalled()
  })
})

it("bounds an unresponsive failure handler while preserving the original error", async () => {
  vi.useFakeTimers()
  const streams = captureStreams()
  try {
    const pending = run(
      ["chats", "list", "--json", "--no-record"],
      {
        ...definition(async () => {
          throw new CliError("not_found", "synthetic failure")
        }),
        onFailure: async () => new Promise(() => {}),
      },
      { streams, tty: false, env: process.env },
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(6)
    expect(JSON.parse(streams.stderr[0] ?? "{}").error).toMatchObject({
      code: "not_found",
      details: { settlement_failed: true },
    })
  } finally {
    vi.useRealTimers()
  }
})

describe("a run with no profile named", () => {
  const program = (withSetup: boolean): ProgramDefinition => ({
    app,
    commands: () => [
      new Command("chats").addCommand(
        new Command("list").action(async function (this: Command) {
          await baseContext(this, resolveSettings).run(async () => {})
        }),
      ),
      ...(withSetup ? [new Command("setup").action(() => {})] : []),
    ],
  })
  const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), "no-profile-"))
    const { APP_PROFILE: _, APP_PROFILE_LOCK: __, ...env } = process.env
    return { ...env, APP_CONFIG_DIR: join(root, "config"), APP_STATE_DIR: join(root, "state") }
  }
  const go = async (argv: string[], withSetup: boolean, env: NodeJS.ProcessEnv) => {
    const streams = captureStreams()
    const code = await run(argv, program(withSetup), { streams, tty: false, env })
    return { code, error: streams.stderr[0] ? JSON.parse(streams.stderr[0]).error : undefined }
  }
  const runs = (env: NodeJS.ProcessEnv) => listRuns(join(env.APP_STATE_DIR ?? "", "runs"))

  it("**suggests `setup` only to a CLI that has it**, and otherwise the typed command with a profile", async () => {
    const env = sandbox()

    const withSetup = await go(["chats", "list"], true, env)
    const without = await go(["chats", "list"], false, env)
    const suggested = await go(["personal", "chats", "list", "--record"], false, env)

    expect(withSetup.error.message).toBe(
      "name a profile: there is none on this computer yet — create one with `app personal setup` " +
        "(any name in place of personal)",
    )
    expect(without.code).toBe(2)
    expect(without.error).toMatchObject({
      code: "validation_error",
      message:
        "name a profile: there is none on this computer yet — any name works, such as `app personal chats list` " +
        "(or set APP_PROFILE)",
      details: { profiles: [] },
    })
    expect(suggested.code).toBe(0)
  })

  it("**records no profile for the owner** — not `default` — and the one named, even one called default", async () => {
    const env = sandbox()

    await go(["chats", "list"], false, env)
    await go(["default", "chats", "list", "--record"], false, env)

    const unnamed = runs(env).find((one) => one.status === "failed")
    const named = runs(env).find((one) => one.status === "success")
    expect(unnamed).toMatchObject({ command: "chats list" })
    expect(unnamed).not.toHaveProperty("profile")
    expect(named).toMatchObject({ command: "chats list", profile: "default" })
  })

  it.each([
    [["runs list"], {}],
    [["Jane Doe", "chats", "list"], {}],
    [["Jane Doe", "nope"], {}],
    [["Jane Doe", "chats", "list"], { APP_PROFILE_LOCK: "work" }],
    [["alice", "chats", "list"], { APP_PROFILE_LOCK: "work" }],
  ])("**records no profile for a refused first word** — %j %j", async (argv, extra) => {
    const env = { ...sandbox(), ...extra }

    await go(argv, false, env)

    const [kept] = runs(env)
    const dir = join(env.APP_STATE_DIR ?? "", "runs")
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((one) => one.isFile())
    expect(kept).toMatchObject({ status: "failed" })
    expect(kept).not.toHaveProperty("profile")
    for (const file of files)
      expect(readFileSync(join(file.parentPath, file.name), "utf8")).not.toContain(
        argv[0] === "alice" ? '"profile"' : argv[0],
      )
  })

  it("**suggests `account show` for a bare word only to a CLI that has it**, and only for a word that can be a profile", async () => {
    const withAccount: ProgramDefinition = {
      app,
      commands: () => [new Command("account").addCommand(new Command("show").action(() => {}))],
    }
    const bare = async (word: string, definition: ProgramDefinition) => {
      const streams = captureStreams()
      await run([word], definition, { streams, tty: false, env: sandbox() })
      return JSON.parse(streams.stderr[0] ?? "{}").error.message
    }

    expect(await bare("work", withAccount)).toContain('or `app work account show` if "work" is your profile')
    expect(await bare("runs list", withAccount)).toMatch(/Run `app --help` for the commands\.$/)
    expect(await bare("work", program(false))).toMatch(/Run `app --help` for the commands\.$/)
  })
})

describe("a CLI's own command", () => {
  const notes = (recordInput: boolean): ProgramDefinition => ({
    app,
    commands: () => [
      new Command("notes").addCommand(
        new Command("add")
          .argument("<text>")
          .option("--token <token>")
          .action(async function (this: Command) {
            const { argv, env = process.env } = cli.environmentOf(this)
            await cli.recorded(
              {
                app,
                command: "notes add",
                record: true,
                keepFailed: true,
                trace: false,
                format: "json",
                env,
                context: cli.runContextOf({
                  bin: app.command,
                  command: "notes add",
                  program: cli.rootOf(this),
                  ...(argv ? { argv } : {}),
                  env,
                  recordInput,
                }),
              },
              async () => {},
            )
          }),
      ),
    ],
  })
  const recordedArgv = async (recordInput: boolean) => {
    const state = mkdtempSync(join(tmpdir(), "own-command-"))
    const env = { ...process.env, APP_PROFILE: "work", APP_STATE_DIR: state, APP_CONFIG_DIR: join(state, "config") }
    const typed = ["notes", "add", "Fake typed note", "--token=fake-token-value"]
    expect(await run(typed, notes(recordInput), { streams: captureStreams(), tty: false, env })).toBe(0)
    return listRuns(join(state, "runs"))[0]?.argv
  }

  it("**keeps its typed command line on success** through the exported runContextOf, secrets hidden", async () => {
    expect(await recordedArgv(true)).toEqual(["notes", "add", "Fake typed note", "--token=[redacted]"])
    expect(await recordedArgv(false)).toEqual(["notes", "add", "[redacted]", "--token=[redacted]"])
  })
})

describe("the shared command contracts", () => {
  const changedSearch = () => sharedCommandTemplate(app, "search").option("--undocumented", "a silent change")

  it("are checked once per definition, and again for a new one", () => {
    let broken = false
    const once: ProgramDefinition = {
      app,
      commands: () => [broken ? changedSearch() : sharedCommandTemplate(app, "search")],
    }
    createProgram(once)
    broken = true
    expect(() => createProgram(once)).not.toThrow()
    expect(() => createProgram({ ...once })).toThrow("without an explicit override")
  })

  it("keep refusing a definition that failed them", () => {
    const failing: ProgramDefinition = { app, commands: () => [changedSearch()] }
    expect(() => createProgram(failing)).toThrow("without an explicit override")
    expect(() => createProgram(failing)).toThrow("without an explicit override")
  })
})
