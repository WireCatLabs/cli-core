import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { Command, CommanderError } from "commander"
import { describe, expect, it, vi } from "vitest"
import type { AppIdentity } from "../ports/app.js"
import { type CliEntry, type EntryContext, type EntryIo, startCli } from "./entry.js"

const APP: AppIdentity = {
  command: "demo",
  appName: "demo-cli",
  envPrefix: "DEMO",
  description: "a demo",
  version: "0.0.0",
}

const tty = <T extends object>(stream: T, isTTY: boolean) => Object.assign(stream, { isTTY })

const fakeIo = (given: { tty?: boolean; env?: NodeJS.ProcessEnv; argv?: string[] } = {}) => {
  const signals = new EventEmitter()
  const exits: number[] = []
  const spawned: { command: string; args: readonly string[]; child: EventEmitter & { unref: () => void } }[] = []
  const io: Partial<EntryIo> = {
    argv: ["node", "demo", ...(given.argv ?? [])],
    env: given.env ?? {},
    platform: "linux",
    stdin: tty(new PassThrough(), given.tty ?? false),
    stdout: tty(new PassThrough(), given.tty ?? false),
    stderr: tty(new PassThrough(), given.tty ?? false),
    signals: signals as unknown as EntryIo["signals"],
    setExitCode: (code) => exits.push(code),
    spawn: (command, args) => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      spawned.push({ command, args, child })
      return child as unknown as ChildProcess
    },
  }
  return { io, signals, exits, spawned }
}

const start = (io: Partial<EntryIo>, run: CliEntry["run"], fail: CliEntry["fail"] = () => 1) =>
  startCli({ app: APP, io, run, fail })

describe("startCli", () => {
  it("**sets the code the program returns** and takes its signal listeners away after", async () => {
    const { io, signals, exits } = fakeIo({ argv: ["personal", "doctor"] })
    let seen: string[] = []
    await start(io, async ({ args }) => {
      seen = args
      expect(signals.listenerCount("SIGINT")).toBe(1)
      return 4
    })
    expect(seen).toEqual(["personal", "doctor"])
    expect(exits).toEqual([4])
    expect(signals.listenerCount("SIGINT")).toBe(0)
    expect(signals.listenerCount("SIGTERM")).toBe(0)
  })

  it("keeps the exit code the command set when the program returns nothing", async () => {
    const { io, exits } = fakeIo()
    await start(io, async () => undefined)
    expect(exits).toEqual([])
  })

  it("**cancels the command on SIGTERM** and gives the cancellation to the CLI's failure report", async () => {
    const { io, signals, exits } = fakeIo()
    const fail = vi.fn((_error: unknown, _entry: EntryContext) => 130)
    await start(
      io,
      async ({ signal }) => {
        signals.emit("SIGTERM")
        expect(signal.aborted).toBe(true)
        signal.throwIfAborted()
      },
      fail,
    )
    expect(fail.mock.calls[0]?.[0]).toMatchObject({ code: "cancelled", message: "command interrupted by SIGTERM" })
    expect(exits).toEqual([130])
  })

  it("**ends quietly with 0 when the reader closes the pipe**", async () => {
    const { io, exits } = fakeIo()
    const fail = vi.fn(() => 1)
    let closed = false
    await start(
      io,
      async (entry) => {
        io.stdout?.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
        closed = entry.outputClosed()
        entry.signal.throwIfAborted()
      },
      fail,
    )
    expect(closed).toBe(true)
    expect(exits).toEqual([0])
  })

  it("exits 3 when the output cannot be written for another reason", async () => {
    const { io, exits } = fakeIo()
    await start(io, async () => {
      io.stdout?.emit("error", Object.assign(new Error("no space"), { code: "ENOSPC" }))
      return 0
    })
    expect(exits).toEqual([3])
  })

  it("**gives help and the version their own exit code**, and help for a missing command 2", async () => {
    const shown = fakeIo()
    const fail = vi.fn(() => 1)
    await start(
      shown.io,
      async () => {
        throw new CommanderError(0, "commander.helpDisplayed", "(outputHelp)")
      },
      fail,
    )
    const missing = fakeIo()
    await start(
      missing.io,
      async () => {
        throw new CommanderError(1, "commander.help", "(outputHelp)")
      },
      fail,
    )
    expect([shown.exits, missing.exits]).toEqual([[0], [2]])
    expect(fail).not.toHaveBeenCalled()
  })

  it("passes any other failure to the CLI once", async () => {
    const { io, exits } = fakeIo()
    const fail = vi.fn((_error: unknown, _entry: EntryContext) => 5)
    await start(
      io,
      async () => {
        throw new Error("boom")
      },
      fail,
    )
    expect(fail).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([5])
  })

  it.each([
    ["without a terminal", { tty: false }, []],
    ["under CI", { tty: true, env: { CI: "true" } }, []],
    ["with --json", { tty: true }, ["--json"]],
    ["with --no-input", { tty: true }, ["--no-input"]],
  ])("**never asks for consent %s**", async (_name, given, flags) => {
    const { io } = fakeIo(given)
    let answer: boolean | undefined
    await start(io, async ({ ask }) => {
      const program = new Command("demo").option("--json").option("--no-input").exitOverride()
      program.parse(["node", "demo", ...flags])
      answer = await ask("Allow drive.files.delete?", program)
    })
    expect(answer).toBe(false)
  })

  it("asks at a terminal and takes yes", async () => {
    const { io } = fakeIo({ tty: true })
    const stdin = io.stdin as PassThrough
    let answer: boolean | undefined
    await start(io, async ({ ask }) => {
      const asked = ask("Allow drive.files.delete?")
      stdin.write("y\n")
      answer = await asked
    })
    expect(answer).toBe(true)
  })

  it("**opens the browser detached** and fails with a step when the opener is missing", async () => {
    const { io, spawned } = fakeIo()
    let failure: unknown
    await start(io, async ({ openBrowser }) => {
      const opened = openBrowser("https://example.test/sign-in")
      spawned[0]?.child.emit("spawn")
      await opened
      const missing = openBrowser("https://example.test/sign-in", "no-such-browser")
      spawned[1]?.child.emit("error", new Error("ENOENT"))
      failure = await missing.catch((error: unknown) => error)
    })
    expect(spawned.map(({ command, args }) => [command, ...args])).toEqual([
      ["xdg-open", "https://example.test/sign-in"],
      ["no-such-browser", "https://example.test/sign-in"],
    ])
    expect(spawned[0]?.child.unref).toHaveBeenCalled()
    expect(failure).toMatchObject({ code: "configuration_error" })
  })

  it("skips the first-run questions when no one can answer them", async () => {
    const { io } = fakeIo({ tty: false })
    await start(io, async ({ atStart }) => {
      const program = new Command("demo")
      const doctor = program.command("doctor")
      await expect(atStart(doctor)).resolves.toBeUndefined()
    })
  })

  it("asks no first-run question under --dry-run, even at a terminal", async () => {
    const { io } = fakeIo({ tty: true })
    const stderr = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
    try {
      await start(io, async ({ atStart }) => {
        const program = new Command("demo").option("--dry-run")
        const install = program.command("install").action(() => {})
        program.setOptionValue("dryRun", true)
        await expect(atStart(install)).resolves.toBeUndefined()
      })
    } finally {
      if (stderr) Object.defineProperty(process.stderr, "isTTY", stderr)
      else delete (process.stderr as { isTTY?: boolean }).isTTY
    }
  })
})
