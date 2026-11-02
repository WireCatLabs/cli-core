import { lstatSync, readFileSync, writeFileSync } from "node:fs"
import { isMovedRun, loadConfigFile, saveConfigFile } from "@wirecat/cli-base"
import {
  hermesCopyPath,
  installSkill,
  type SkillApp,
  type SkillTarget,
  skillStatus,
  skillVersion,
  withVersion,
} from "@wirecat/cli-base/skill"
import { isNewer } from "@wirecat/cli-base/update"
import * as v from "valibot"
import { type AppIdentity, envName } from "../ports/app.js"

type Env = Readonly<Record<string, string | undefined>>

const marker = v.object({ version: v.optional(v.string()) })

const AGENT_NAMES: Record<SkillTarget | "hermes", string> = {
  claude: "Claude Code",
  agents: "other agents",
  hermes: "Hermes",
}

/** Not where the owner's own agents look: a test, a moved HOME or state folder, or the owner said no. */
export const skipsSkillRefresh = (app: AppIdentity, env: NodeJS.ProcessEnv): boolean =>
  env.VITEST !== undefined ||
  Boolean(env[envName(app, "NO_SKILL_REFRESH")]) ||
  isMovedRun({ appName: app.appName, prefix: app.envPrefix, env })

// A symlink points into a checkout or a dotfiles repo; writing through it changes a file the tool never wrote.
const isPlainFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Only `stale` copies: one with a version stamp that `skill install` wrote for an older release. `unversioned` means
 * no released `skill install` wrote it (each stamps `metadata.version`), so it is somebody's own file and stays.
 */
const staleTargets = (app: SkillApp, env: Env): SkillTarget[] =>
  skillStatus(app, env)
    .filter(({ state, path }) => state === "stale" && isPlainFile(path))
    .map(({ target }) => target)

/** Hermes's own copy, read from disk: asking Hermes would start a program and could take seconds. */
const refreshHermesCopy = (app: SkillApp, skill: URL, env: Env): boolean => {
  const path = hermesCopyPath(app.appName, env)
  if (!isPlainFile(path)) return false
  const installed = skillVersion(readFileSync(path, "utf8"))
  if (installed === undefined || !isNewer(app.version, installed)) return false
  writeFileSync(path, withVersion(readFileSync(skill, "utf8"), app.version))
  return true
}

export interface SkillRefreshRequest {
  app: SkillApp
  skill: URL
  env: Env
  /** `<state>/skill-refresh.json`: the version this was last tried for, so each version tries once. */
  markerPath: string
}

/**
 * On the first run of a new version, rewrites the installed SKILL.md copies that an older version wrote, and answers
 * the line for stderr — or `undefined` when there was nothing to do. A failure is a one-line note, never an error.
 */
export const refreshSkills = ({ app, skill, env, markerPath }: SkillRefreshRequest): string | undefined => {
  try {
    const seen = loadConfigFile(markerPath, marker, () => ({})).version
    if (seen === app.version) return undefined
  } catch {
    // An unreadable marker counts as a new version; the write below replaces it.
  }
  const save = () => {
    try {
      saveConfigFile(markerPath, { version: app.version })
    } catch {
      // Unsaved, the next run tries again; that costs two file reads.
    }
  }
  try {
    const targets = staleTargets(app, env)
    if (targets.length > 0) installSkill(app, skill, { targets, env })
    const hermes = refreshHermesCopy(app, skill, env)
    save()
    const names = [...targets, ...(hermes ? (["hermes"] as const) : [])].map((target) => AGENT_NAMES[target])
    if (names.length === 0) return undefined
    return `Updated the ${app.command} instructions for ${listed(names)} to ${app.version}`
  } catch (error) {
    save()
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return `Could not update the ${app.command} instructions for agents (${reason}); \`${app.command} skill install\` does it`
  }
}

const listed = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
