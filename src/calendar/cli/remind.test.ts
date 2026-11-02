import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import type { EntryInput } from "../../meetings/index.js"
import type { GuardSettings } from "../../sends/guard.js"
import type { Level } from "../../sends/permissions.js"
import { checkCalendarAnswer } from "../testing/answers.js"
import { fakeCalendarSource, fakeCalendarWriter, memoryEventStore } from "../testing/index.js"
import { addCalendarCommands } from "./index.js"

const MINUTE = 60_000
const NOW = Date.UTC(2026, 10, 2, 9)
const app = { command: "gcal", appName: "gcal-cli", envPrefix: "GCAL", description: "synthetic", version: "1.0.0" }

const meeting = (externalId: string, startsInMinutes: number, extra: Partial<EntryInput> = {}): EntryInput => ({
  externalId,
  kind: "single",
  status: "confirmed",
  title: `Example ${externalId}`,
  startsAt: NOW + startsInMinutes * MINUTE,
  endsAt: NOW + (startsInMinutes + 30) * MINUTE,
  ...extra,
})

const setup = (options: { permissions?: Record<string, Level>; lock?: string } = {}) => {
  const store = memoryEventStore()
  const source = fakeCalendarSource()
  source.put(
    "primary",
    meeting("soon", 5),
    meeting("later", 40),
    meeting("declined", 6, { ownResponse: "declined" }),
    meeting("cancelled", 7, { status: "cancelled" }),
    meeting("out", 8, { eventType: "out-of-office" }),
    // A stranger's invitation: its title would run a command if it ever reached a shell.
    meeting("hostile", 9, { title: "$(touch pwned) `touch pwned2`; rm -rf ~" }),
  )
  const home = mkdtempSync(join(tmpdir(), "calendar-remind-"))
  const env = { HOME: home, XDG_DATA_HOME: home, GCAL_STATE_DIR: home, PATH: process.env.PATH ?? "" }
  const settings = (): GuardSettings => ({
    profile: "work",
    permissions: options.permissions ?? {},
    permissionSources: {},
    sendsPerHour: 30,
    ...(options.lock ? { readOnlyLock: options.lock } : {}),
  })
  let clock = NOW
  const written: Record<string, unknown>[] = []
  const program = () => {
    const root = new Command("gcal").exitOverride().configureOutput({ writeErr: () => undefined })
    root.option("--yes").option("--json").option("--offline")
    addCalendarCommands(root, {
      store,
      accountId: 1,
      account: { provider: "example-calendar", account: "owner-1" },
      source,
      write: (value) => written.push(value as Record<string, unknown>),
      now: () => clock,
      timezone: "UTC",
      writes: { writer: fakeCalendarWriter(), app, settings, env },
    })
    return root
  }
  const remind = async (...args: string[]) => {
    const root = program()
    const before = written.length
    const argv = ["events", "remind", ...args, "--json"]
    await root.parseAsync(argv, { from: "user" })
    if (written.length > before) checkCalendarAnswer(root, argv, written.at(-1))
    return (written.length > before ? written.at(-1) : undefined) as { items: { title: string; ref: string }[] }
  }
  const titles = async (...args: string[]) => (await remind(...args)).items.map(({ title }) => title)
  return { store, source, remind, titles, home, program, setClock: (at: number) => (clock = at) }
}

/** A program that saves what it got on stdin, and the event its environment names, to a file of its own. */
const recorder = (home: string, exitCode = 0) => {
  const out = join(home, "hook-out")
  const script =
    "const fs=require('fs');const input=fs.readFileSync(0,'utf8');" +
    "fs.appendFileSync(process.argv[1],JSON.stringify({input:JSON.parse(input),event:process.env.GCAL_EVENT," +
    `profile:process.env.GCAL_PROFILE})+'\\n');process.exit(${exitCode})`
  return {
    argv: ["--", process.execPath, "-e", script, out],
    runs: () =>
      existsSync(out)
        ? readFileSync(out, "utf8")
            .trim()
            .split("\n")
            .map(
              (line) => JSON.parse(line) as { input: { ref: string; title: string }; event: string; profile: string },
            )
        : [],
  }
}

describe("events remind", () => {
  it("syncs, then tells once about each event that takes the owner's time and starts in the window", async () => {
    const { titles, setClock, source } = setup()
    expect(await titles("--due-within", "10m")).toEqual(["Example soon", "$(touch pwned) `touch pwned2`; rm -rf ~"])
    expect(await titles("--due-within", "10m")).toEqual([])
    setClock(NOW + 15 * MINUTE)
    expect(await titles("--due-within", "30m")).toEqual(["Example later"])
    // Moved to another time, the meeting is reminded again.
    source.put("primary", meeting("soon", 30))
    expect(await titles("--due-within", "30m")).toEqual(["Example soon"])
  })

  it("--offline reads only the store, and --dry-run remembers nothing", async () => {
    const { titles, remind } = setup()
    expect(await titles("--due-within", "10m", "--offline")).toEqual([])
    await remind("--due-within", "10m", "--dry-run")
    expect(await titles("--due-within", "10m", "--dry-run", "--offline")).toEqual([])
    expect(await titles("--due-within", "10m")).toHaveLength(2)
  })

  it("says in meta when the sync failed, and still reminds from the store", async () => {
    const { remind, source, setClock } = setup()
    await remind("--due-within", "1m")
    source.failAfter(0)
    setClock(NOW + MINUTE)
    const answer = (await remind("--due-within", "10m")) as unknown as {
      items: unknown[]
      meta: { complete: boolean; issues: { reason: string }[] }
    }
    expect(answer.items).toHaveLength(2)
    expect(answer.meta).toMatchObject({ complete: false, issues: [{ reason: "sync.partial" }] })
  })

  it("refuses a window outside 1m to 1d, and a bare number", async () => {
    const { remind } = setup()
    await expect(remind("--due-within", "30s")).rejects.toMatchObject({ code: "validation_error" })
    await expect(remind("--due-within", "2d")).rejects.toMatchObject({ code: "validation_error" })
    await expect(remind("--due-within", "10")).rejects.toMatchObject({ code: "validation_error" })
  })

  it("runs no program until the owner allows events.remind.hook, and remembers nothing then", async () => {
    const { remind, titles, home } = setup()
    const hook = recorder(home)
    await expect(remind("--due-within", "10m", ...hook.argv)).rejects.toMatchObject({
      code: "permission_error",
      details: { permission: "events.remind.hook" },
    })
    expect(hook.runs()).toEqual([])
    expect(await titles("--due-within", "10m")).toHaveLength(2)
  })

  it("refuses the program under the read-only lock, whatever the permission", async () => {
    const { remind, home } = setup({ permissions: { "events.remind.hook": "allow" }, lock: "GCAL_READ_ONLY" })
    const hook = recorder(home)
    await expect(remind("--due-within", "10m", ...hook.argv)).rejects.toMatchObject({ code: "permission_error" })
    expect(hook.runs()).toEqual([])
  })

  it("runs the program once per event with the event as JSON on stdin, and never through a shell", async () => {
    const { remind, home } = setup({ permissions: { "events.remind.hook": "allow" } })
    const hook = recorder(home)
    const answer = await remind("--due-within", "10m", ...hook.argv)
    expect(answer.items).toHaveLength(2)
    const runs = hook.runs()
    expect(runs.map(({ input }) => input.title)).toEqual(["Example soon", "$(touch pwned) `touch pwned2`; rm -rf ~"])
    expect(runs.map(({ event, profile }) => [event, profile])).toEqual(runs.map(({ input }) => [input.ref, "work"]))
    expect(runs[0]?.input).toMatchObject({ untrusted: ["title", "description", "location"] })
    for (const file of ["pwned", "pwned2"]) expect(existsSync(join(home, file))).toBe(false)
    await remind("--due-within", "10m", ...hook.argv)
    expect(hook.runs()).toHaveLength(2)
  })

  it("keeps an event whose program failed for the next run, and says so", async () => {
    const { remind, home } = setup({ permissions: { "events.remind.hook": "allow" } })
    const failing = recorder(home, 3)
    await expect(remind("--due-within", "10m", ...failing.argv)).rejects.toMatchObject({
      code: "configuration_error",
      details: { reason: "remind.hook-failed", failed: [{ exit_code: 3 }, { exit_code: 3 }] },
    })
    const working = recorder(home)
    expect((await remind("--due-within", "10m", ...working.argv)).items).toHaveLength(2)
  })

  it("answers 127 for a program that does not exist", async () => {
    const { remind, home } = setup({ permissions: { "events.remind.hook": "allow" } })
    await expect(remind("--due-within", "10m", "--", join(home, "no-such-program"))).rejects.toMatchObject({
      details: { failed: [{ exit_code: 127 }, { exit_code: 127 }] },
    })
  })

  it("stays off MCP", () => {
    const events = setup()
      .program()
      .commands.find((one) => one.name() === "events")
    const remind = events?.commands.find((one) => one.name() === "remind")
    expect(remind && metaOf(remind).mcp).toBe(false)
  })
})
