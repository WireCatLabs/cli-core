/**
 * Keeping an installed CLI current: which package manager put it here, what command updates it,
 * whether npm has something newer, and whether a person should be told.
 *
 * Nothing here updates anything by itself, and nothing here decides to print: a CLI that holds
 * somebody's credentials must not change itself unasked, and a line on the terminal is for a
 * person, never for a script or an agent reading JSON. The CLI asks and decides.
 */
import { spawnSync } from "node:child_process"
import * as v from "valibot"
import { loadConfigFile, saveConfigFile } from "../config.js"
import type { FetchLike } from "../http/index.js"

export type Installer = "pnpm" | "npm" | "bun" | "npx" | "checkout" | "unknown"

/**
 * Read from where the running file really lives — `realpath` of the script, not `which`: the
 * command on `PATH` is a shim or a link, and only its target says who installed it. Paths measured
 * on 2026-09-24 by installing into throwaway prefixes.
 */
export const installerOf = (scriptPath: string): Installer => {
  const path = scriptPath.replaceAll("\\", "/")
  if (path.includes("/_npx/")) return "npx"
  if (path.includes("/install/global/node_modules/")) return "bun"
  if (/\/\.?pnpm\//.test(path)) return "pnpm"
  if (path.includes("/node_modules/")) return "npm"
  return path.includes("/dist/") ? "checkout" : "unknown"
}

/** The argv that updates a global install, or `undefined` where there is nothing to run. */
export const updateCommand = (installer: Installer, packageName: string): string[] | undefined => {
  const target = `${packageName}@latest`
  switch (installer) {
    case "pnpm":
      return ["pnpm", "add", "-g", target]
    case "npm":
      return ["npm", "install", "-g", target]
    case "bun":
      return ["bun", "add", "-g", target]
    default:
      return undefined
  }
}

/** Plain `x.y.z` only: a pre-release is never offered, so it never counts as newer. */
export const isNewer = (candidate: string, current: string): boolean => {
  const parse = (version: string) => (/^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : undefined)
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number)
  }
  return false
}

/** The `latest` version on npm, or `undefined` on any failure — a hint may never fail a command. */
export const latestVersion = async (
  packageName: string,
  fetch: FetchLike,
  { timeoutMs = 1000 }: { timeoutMs?: number } = {},
): Promise<string | undefined> => {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    })
    if (!response.ok) return undefined
    const { version } = (await response.json()) as { version?: unknown }
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
}

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000

export interface NotifyContext {
  /** `pretty`, `json` or `jsonl` — the line exists only for the first. */
  format: string
  stderrIsTTY: boolean
  quiet: boolean
  /** The setting; `false` turns the check off. */
  enabled: boolean
  installer: Installer
  env: Readonly<Record<string, string | undefined>>
  /** Extra variables that turn it off, for the CLI's own prefix: `MAX_NO_UPDATE_CHECK`. */
  offVariables?: readonly string[]
}

/** Whether a person is at a terminal who could be told — the only case a check is worth making. */
export const mayNotify = ({
  format,
  stderrIsTTY,
  quiet,
  enabled,
  installer,
  env,
  offVariables = [],
}: NotifyContext): boolean =>
  enabled &&
  format === "pretty" &&
  stderrIsTTY &&
  !quiet &&
  updateCommand(installer, "any") !== undefined &&
  !env.CI &&
  !env.NO_UPDATE_NOTIFIER &&
  offVariables.every((name) => !env[name])

const updateState = v.object({
  checkedAt: v.number(),
  latest: v.optional(v.string()),
  /** When the skill hint (`cli-core/skill`) was last shown — the other daily notice kept in this file. */
  skillHintAt: v.optional(v.number()),
})
export type UpdateState = v.InferOutput<typeof updateState>

/** The file as it is, `checkedAt: 0` when it is missing or unreadable. */
export const readNoticeState = (path: string): UpdateState => {
  try {
    return loadConfigFile(path, updateState, () => ({ checkedAt: 0 }))
  } catch {
    return { checkedAt: 0 }
  }
}

/** What the last check found. A missing or unreadable file is "never checked", not an error. */
export const readUpdateState = (path: string): UpdateState | undefined => {
  const state = readNoticeState(path)
  return state.checkedAt > 0 ? state : undefined
}

/**
 * Merged into the file as it is at the moment of writing: the update notice reads before it asks
 * npm and writes after, and the skill hint may have written in between.
 */
export const writeUpdateState = (path: string, state: Partial<UpdateState>): void => {
  try {
    saveConfigFile(path, { ...readNoticeState(path), ...state })
  } catch {
    // A state file that cannot be written means asking npm again tomorrow, nothing worse.
  }
}

export const checkIsDue = (state: UpdateState | undefined, now: number): boolean =>
  state === undefined || now - state.checkedAt >= CHECK_EVERY_MS

/**
 * npm and pnpm are `.cmd` shims on Windows, and Node starts a `.cmd` only through a shell. The
 * words are joined rather than passed as arguments, which Node 24 deprecates alongside `shell`;
 * that is safe only because they come from `updateCommand`, never from the person typing.
 */
export const spawnPlan = ([command, ...args]: readonly string[], platform: NodeJS.Platform = process.platform) =>
  platform === "win32"
    ? { file: [command, ...args].join(" "), args: [] as string[], shell: true }
    : { file: command as string, args, shell: false }

/** Runs the update and answers its exit code. stdout stays one result: the package manager's output goes to stderr. */
export const runUpdate = (argv: readonly string[]): number => {
  const { file, args, shell } = spawnPlan(argv)
  const { status, error } = spawnSync(file, args, { stdio: ["inherit", 2, 2], shell })
  if (error) throw new Error(`could not start ${argv[0]}: ${error.message}`)
  return status ?? 1
}

export interface NoticeRequest extends NotifyContext {
  /** The words the CLI was run with, to leave `update` and `complete` alone. */
  argv: readonly string[]
  packageName: string
  /** The command a person types: `braze`, `max`. */
  command: string
  version: string
  /** Where the last answer from npm is kept — the CLI's state directory. */
  statePath: string
  fetch: FetchLike
  now?: () => number
}

/**
 * The daily "a newer version exists" line, or `undefined`. Meant to be started beside the command
 * and awaited after it, so asking npm costs the command nothing; any failure is silence.
 */
export const updateNotice = async ({
  argv,
  packageName,
  command,
  version,
  statePath,
  fetch,
  now = Date.now,
  ...context
}: NoticeRequest): Promise<string | undefined> => {
  try {
    // Anywhere, not the first word: that can be a profile (`braze prod update`) or an option's value,
    // and a notice after `update` names the version just installed as the one to get.
    if (argv.includes("complete") || argv.includes("update")) return undefined
    if (!mayNotify(context)) return undefined

    const at = now()
    let state = readUpdateState(statePath)
    if (checkIsDue(state, at)) {
      const found = await latestVersion(packageName, fetch, { timeoutMs: 1000 })
      const seen = found ?? state?.latest
      state = seen ? { checkedAt: at, latest: seen } : { checkedAt: at }
      writeUpdateState(statePath, state)
    }

    return state?.latest && isNewer(state.latest, version)
      ? `${command} ${state.latest} is out — you have ${version}. \`${command} update\` installs it.`
      : undefined
  } catch {
    return undefined
  }
}
