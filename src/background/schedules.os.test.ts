import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, expect, it } from "vitest"
import { notify, type Schedule, scheduleFile, timerFor } from "./schedules.js"
import { runProgram, type ServerSystem } from "./system.js"

// Registers real timers with the operating system: only on the macOS and Windows CI runners (schedules.yml).
const real = process.env.SCHEDULE_OS_TEST === "1" && ["darwin", "win32"].includes(process.platform)
const app = { command: "osprobe", appName: "osprobe-cli", envPrefix: "OSPROBE", description: "", version: "0" }

const system: ServerSystem = {
  platform: process.platform,
  run: runProgram,
  entry: [process.execPath],
  uid: process.getuid?.() ?? 0,
  spawn: () => 0,
  pause: () => sleep(250),
}

const registered = async (name: string) =>
  process.platform === "darwin"
    ? (await runProgram(["launchctl", "print", `gui/${system.uid}/${app.appName}.schedule.${name}`], process.env))
        .code === 0
    : (
        await runProgram(
          [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            `Get-ScheduledTask -TaskPath '\\${app.appName}\\' -TaskName '${name}'`,
          ],
          process.env,
        )
      ).code === 0

const start = (name: string) =>
  process.platform === "darwin"
    ? runProgram(["launchctl", "kickstart", "-k", `gui/${system.uid}/${app.appName}.schedule.${name}`], process.env)
    : runProgram(
        [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          `Start-ScheduledTask -TaskPath '\\${app.appName}\\' -TaskName '${name}'`,
        ],
        process.env,
      )

describe.runIf(real)(`schedules on this machine's own timer (${process.platform})`, () => {
  it("registers each kind of schedule, runs it from the timer with its arguments intact, and removes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "schedule os "))
    const state = join(root, "state")
    const timer = timerFor(app, system, process.env)
    const marker = join(root, "fired with spaces.txt")
    const script = join(root, "probe.mjs")
    writeFileSync(
      script,
      "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], process.argv.slice(3).join('|'))\n",
    )

    for (const [name, when] of [
      ["every", { every: 60 }],
      ["daily", { daily: "08:30" }],
      ["once", { once: new Date(Date.now() + 86_400_000).toISOString() }],
    ] as const) {
      const schedule: Schedule = { name, kind: "command", argv: [], when, environment: {}, createdAt: "" }
      const file = scheduleFile(state, name)
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, JSON.stringify(schedule))
      await timer.install(schedule, [process.execPath, script, marker, "schedule", "exec", file])
      expect(await registered(name)).toBe(true)
    }

    expect((await start("daily")).code).toBe(0)
    for (let tries = 0; tries < 120 && !existsSync(marker); tries++) await sleep(500)
    expect(readFileSync(marker, "utf8")).toBe(`schedule|exec|${scheduleFile(state, "daily")}`)

    for (const name of ["every", "daily", "once"]) {
      await timer.remove(name)
      expect(await registered(name)).toBe(false)
    }
  }, 120_000)

  it("shows a desktop notification", async () => {
    expect(await notify(system, process.env, "osprobe", "a schedule ran")).toBe(true)
  })
})
