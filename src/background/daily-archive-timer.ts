import { createHash } from "node:crypto"
import { mkdir, realpath, unlink } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { acquireLock, readBoundedUtf8File, syncDirectory, writeFileAtomic } from "../files/index.js"
import type { AppIdentity } from "../ports/app.js"
import type { ServerSystem } from "./system.js"
import { locationVariables } from "./units.js"

export const runArchiveTimerCommand = (args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      args[0] ?? "systemctl",
      args.slice(1),
      {
        env,
        signal,
        timeout: 30000,
        maxBuffer: 65536,
        encoding: "utf8",
        shell: false,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr })
        reject(
          new CliError("configuration_error", "archive timer command did not complete; inspect its systemctl status"),
        )
      },
    )
  })

const missingMediaFile = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const quote = (value: string, expandDollar: boolean) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (expandDollar ? "$$" : "$"))}"`
export interface DailyArchiveTimer {
  name: string
  unitDirectory: string
  service: string
  timer: string
}
export interface DailyArchiveTimerInput {
  app: AppIdentity
  profile: string
  directory: string
  entry: readonly string[]
  env: NodeJS.ProcessEnv
  chats?: readonly string[]
  sinceTime?: string
  at?: string
  timeZone?: string
}
const unitFolder = (env: NodeJS.ProcessEnv) => {
  const folder = env.XDG_CONFIG_HOME ?? (env.HOME ? join(env.HOME, ".config") : "")
  if (!isAbsolute(folder) || /[\p{Cc}]/u.test(folder))
    throw new CliError("configuration_error", "a timer needs an absolute HOME or XDG_CONFIG_HOME")
  return join(folder, "systemd", "user")
}
export const dailyArchiveTimer = (input: DailyArchiveTimerInput): DailyArchiveTimer => {
  const at = input.at ?? "03:00"
  const timeZone = input.timeZone ?? "UTC"
  const environment = locationVariables(input.app, input.env)
  let zone: string
  try {
    zone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone
  } catch {
    throw new CliError("validation_error", "--timezone needs an IANA time zone")
  }
  if (
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at) ||
    !/^[A-Za-z0-9_+/-]+$/.test(zone) ||
    !/^[a-z][a-z0-9-]*$/.test(input.app.command) ||
    !input.profile ||
    !isAbsolute(input.directory) ||
    input.entry.length < 1 ||
    input.entry.some((one) => !isAbsolute(one)) ||
    [
      input.profile,
      input.directory,
      ...input.entry,
      ...Object.values(environment),
      ...(input.chats ?? []),
      input.sinceTime ?? "",
    ].some((one) => /[\p{Cc}]/u.test(one))
  )
    throw new CliError("validation_error", "invalid daily archive timer arguments")
  const scope = digest(
    JSON.stringify([
      input.app.command,
      input.profile,
      input.directory,
      Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  )
  const name = `${input.app.command}-media-archive-${scope.slice(0, 32)}`
  const owner = `# WireCat daily media archive ${scope}`
  const command = [
    ...input.entry,
    input.profile,
    "attachments",
    "download",
    input.directory,
    "--json",
    "--no-input",
    "--timeout",
    "6h",
    ...(input.sinceTime ? ["--since-time", input.sinceTime] : []),
    ...(input.chats ?? []).flatMap((chat) => ["--chat", chat]),
  ]
  const seal = (text: string) => `${text}# SHA-256 ${digest(text)}\n`
  return {
    name,
    unitDirectory: unitFolder(input.env),
    service: seal(
      `${owner}\n[Unit]\nDescription=WireCat media archive\n\n[Service]\nType=oneshot\nUMask=0077\nTimeoutStartSec=6h\n${Object.entries(
        environment,
      )
        .map(([key, value]) => `Environment=${quote(`${key}=${value}`, false)}\n`)
        .join("")}ExecStart=${command.map((one) => quote(one, true)).join(" ")}\n`,
    ),
    timer: seal(
      `${owner}\n[Unit]\nDescription=WireCat daily media archive\n\n[Timer]\nOnCalendar=*-*-* ${at}:00 ${zone}\nPersistent=true\nUnit=${name}.service\n\n[Install]\nWantedBy=timers.target\n`,
    ),
  }
}
const ownedUnit = async (path: string, expectedOwner: string): Promise<string | null> => {
  let text: string
  try {
    text = await readBoundedUtf8File(path, { maxBytes: 65536 })
  } catch (error) {
    if (missingMediaFile(error)) return null
    throw error
  }
  const sealAt = text.lastIndexOf("# SHA-256 ")
  if (
    !text.startsWith(`${expectedOwner}\n`) ||
    sealAt < 0 ||
    text.slice(sealAt) !== `# SHA-256 ${digest(text.slice(0, sealAt))}\n`
  )
    throw new CliError("validation_error", "archive timer unit is foreign or edited; it was preserved")
  return text
}
export const manageDailyArchiveTimer = async (
  plan: DailyArchiveTimer,
  action: "install" | "start" | "stop" | "status" | "uninstall",
  system: Pick<ServerSystem, "platform" | "run">,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => {
  if (system.platform !== "linux")
    throw new CliError("configuration_error", "daily media archive timers require Linux systemd user services")
  if (!isAbsolute(plan.unitDirectory) || !/^[a-z][a-z0-9-]*-media-archive-[a-f0-9]{32}$/.test(plan.name))
    throw new CliError("validation_error", "invalid archive timer paths")
  signal?.throwIfAborted()
  await mkdir(plan.unitDirectory, { recursive: true, mode: 0o700 })
  const folder = await realpath(plan.unitDirectory)
  const lease = await acquireLock(join(folder, `.${plan.name}.lock`), { signal })
  const beforeWrite = async () => {
    signal?.throwIfAborted()
    if (!(await lease.held())) throw new CliError("validation_error", "archive timer lost its writer lock")
  }
  const servicePath = resolve(folder, `${plan.name}.service`)
  const timerPath = resolve(folder, `${plan.name}.timer`)
  const owner = plan.service.split("\n")[0] ?? ""
  const run = async (...args: string[]) => {
    await beforeWrite()
    const result = await system.run(["systemctl", "--user", ...args], env)
    if (result.code !== 0)
      throw new CliError("configuration_error", "systemctl could not change the archive timer; inspect its status")
  }
  try {
    const service = await ownedUnit(servicePath, owner)
    const timer = await ownedUnit(timerPath, owner)
    const installed = service !== null && timer !== null
    if (action === "status") {
      const active = installed
        ? await system.run(["systemctl", "--user", "is-active", `${plan.name}.timer`], env)
        : undefined
      return { name: plan.name, installed, active: active?.code === 0, servicePath, timerPath }
    }
    if (action === "install") {
      if ((service !== null && service !== plan.service) || (timer !== null && timer !== plan.timer))
        throw new CliError(
          "validation_error",
          "this destination already has a different schedule; stop and uninstall it first",
        )
      await beforeWrite()
      if (service === null)
        await writeFileAtomic(servicePath, plan.service, { overwrite: false, beforePublish: beforeWrite })
      if (timer === null) await writeFileAtomic(timerPath, plan.timer, { overwrite: false, beforePublish: beforeWrite })
      await run("daemon-reload")
    } else {
      if (!installed) throw new CliError("not_found", "archive timer is not installed")
      if (action === "start") await run("enable", "--now", `${plan.name}.timer`)
      if (action === "stop") await run("disable", "--now", `${plan.name}.timer`)
      if (action === "uninstall") {
        await beforeWrite()
        const active = await system.run(["systemctl", "--user", "is-active", `${plan.name}.timer`], env)
        const enabled = await system.run(["systemctl", "--user", "is-enabled", `${plan.name}.timer`], env)
        const running = await system.run(["systemctl", "--user", "is-active", `${plan.name}.service`], env)
        if (active.code !== 3 || enabled.code !== 1 || running.code !== 3)
          throw new CliError(
            "validation_error",
            "stop the archive timer and wait for its service to finish before uninstalling",
          )
        await beforeWrite()
        await unlink(servicePath)
        await unlink(timerPath)
        await syncDirectory(folder)
        await run("daemon-reload")
      }
    }
    return { name: plan.name, installed: action !== "uninstall", action, servicePath, timerPath }
  } finally {
    await lease.release()
  }
}

import { execFile } from "node:child_process"
