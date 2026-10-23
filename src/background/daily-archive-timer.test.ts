import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { dailyArchiveTimer, manageDailyArchiveTimer } from "./daily-archive-timer.js"
import type { ServerSystem } from "./system.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", version: "1.0.0", description: "Example" }
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-media-"))
  const env = {
    HOME: root,
    CHAT_CONFIG_DIR: join(root, 'config % "$ `'),
    MESSAGING_STORE: join(root, "example.db"),
    CHAT_TOKEN: "SYNTHETIC-SECRET",
    UNRELATED: "SYNTHETIC-SECRET",
  }
  const input = {
    app,
    profile: "example",
    directory: join(root, "archive"),
    entry: ["/usr/bin/node", "/example tool/chat.js"],
    env,
  }
  const plan = dailyArchiveTimer(input)
  const run = vi.fn(async (_argv: string[], _env: NodeJS.ProcessEnv) => ({ code: 0, stdout: "", stderr: "" }))
  const system: Pick<ServerSystem, "platform" | "run"> = { platform: "linux", run }
  const manage = (action: Parameters<typeof manageDailyArchiveTimer>[1]) =>
    manageDailyArchiveTimer(plan, action, system, env)
  return { root, env, input, plan, run, system, manage }
}
describe("daily archive systemd units", () => {
  it("writes durable owned units, starts nothing, and captures only location variables", async () => {
    const f = await fixture()
    const plan = dailyArchiveTimer({
      ...f.input,
      at: "04:25",
      timeZone: "Europe/Madrid",
      chats: ['Example "$%'],
      sinceTime: "2026-10-01T00:00:00Z",
    })
    expect(plan.service).toContain('"attachments" "download"')
    expect(plan.service).toContain('"--chat" "Example \\"$$%%"')
    expect(plan.service).toContain("UMask=0077")
    expect(plan.service).toContain("MESSAGING_STORE=")
    expect(plan.service).not.toContain("SYNTHETIC-SECRET")
    expect(plan.timer).toContain("OnCalendar=*-*-* 04:25:00 Europe/Madrid")
    expect(plan.timer).toContain("Persistent=true")
    await manageDailyArchiveTimer(plan, "install", f.system, f.env)
    expect(f.run.mock.calls.map(([args]) => args)).toEqual([["systemctl", "--user", "daemon-reload"]])
    expect(await readFile(join(plan.unitDirectory, `${plan.name}.service`), "utf8")).toBe(plan.service)
    await manageDailyArchiveTimer(plan, "install", f.system, f.env)
    expect((await f.manage("status")).installed).toBe(true)
  })
  it("starts and stops only the captured timer; uninstall refuses running jobs", async () => {
    const f = await fixture()
    await f.manage("install")
    await f.manage("start")
    await f.manage("stop")
    expect(f.run.mock.calls.map(([args]) => args).slice(1)).toEqual([
      ["systemctl", "--user", "enable", "--now", `${f.plan.name}.timer`],
      ["systemctl", "--user", "disable", "--now", `${f.plan.name}.timer`],
    ])
    await expect(f.manage("uninstall")).rejects.toThrow("stop the archive timer")
    f.run.mockImplementation(async (args) => ({
      code: args.includes("is-active") ? 3 : args.includes("is-enabled") ? 1 : 0,
      stdout: "",
      stderr: "",
    }))
    expect(await f.manage("uninstall")).toMatchObject({ installed: false })
    expect(await f.manage("status")).toMatchObject({ installed: false, active: false })
    await expect(f.manage("start")).rejects.toThrow("not installed")
  })
  it("preserves edited or foreign files and refuses a changed schedule", async () => {
    const f = await fixture()
    await f.manage("install")
    const different = dailyArchiveTimer({ ...f.input, at: "05:00" })
    await expect(manageDailyArchiveTimer(different, "install", f.system, f.env)).rejects.toThrow("different schedule")
    const path = join(f.plan.unitDirectory, `${f.plan.name}.service`)
    const edited = f.plan.service.replace("UMask=0077", "UMask=0000")
    await writeFile(path, edited)
    await expect(f.manage("start")).rejects.toThrow("foreign or edited")
    await expect(f.manage("install")).rejects.toThrow("foreign or edited")
    expect(await readFile(path, "utf8")).toBe(edited)
  })
  it("separates profiles, destinations and development locations; validates units before writes", async () => {
    const f = await fixture()
    expect(dailyArchiveTimer({ ...f.input, profile: "another" }).name).not.toBe(f.plan.name)
    expect(dailyArchiveTimer({ ...f.input, env: { HOME: f.root } }).name).not.toBe(f.plan.name)
    expect(dailyArchiveTimer({ ...f.input, directory: join(f.root, "other") }).name).not.toBe(f.plan.name)
    for (const invalid of [
      { at: "25:00" },
      { timeZone: "bad zone" },
      { directory: "relative" },
      { profile: "example\nExecStart=bad" },
      { chats: ["Example\tbad"] },
      { entry: ["relative"] },
    ])
      expect(() => dailyArchiveTimer({ ...f.input, ...invalid })).toThrow()
    await expect(
      manageDailyArchiveTimer(f.plan, "install", { ...f.system, platform: "darwin" }, f.env),
    ).rejects.toThrow("Linux")
    await f.manage("install")
    f.run.mockResolvedValue({ code: 1, stdout: "", stderr: "SYNTHETIC-SECRET" })
    await expect(f.manage("start")).rejects.toThrow("systemctl could not")
    const stop = new AbortController()
    stop.abort(new Error("cancelled"))
    await expect(manageDailyArchiveTimer(f.plan, "install", f.system, f.env, stop.signal)).rejects.toThrow("cancelled")
  })
})
