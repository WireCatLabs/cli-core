import { CliError } from "@wirecat/cli-base"
import type { Level } from "../sends/permissions.js"
import { storePath } from "../store/path.js"
import { readSharedSection, sharedConfigPath, writeSharedSection } from "../store/shared-config.js"

/** One switch for every tool, the same on the command line and over MCP; "allow" leaves each profile as configured. */
export const PERMISSION_ANSWERS = ["readonly", "allow"] as const
export type PermissionAnswer = (typeof PERMISSION_ANSWERS)[number]

/**
 * The first-run answers every WireCat CLI shares. Languages live in the store (`search_stemmers`), so only the
 * fact that they were asked is kept here.
 */
export interface SetupAnswers {
  languages?: true
  tools?: true
  permissions?: PermissionAnswer
}
export const QUESTIONS = ["languages", "tools", "permissions"] as const
export type Question = (typeof QUESTIONS)[number]

const SECTION = "setup"

export const readSetupAnswers = (path: string): SetupAnswers => {
  const section = readSharedSection(path, SECTION)
  if (section === undefined) return {}
  const answers = section as Record<string, unknown>
  if (
    section === null ||
    typeof section !== "object" ||
    Array.isArray(section) ||
    (answers.languages !== undefined && answers.languages !== true) ||
    (answers.tools !== undefined && answers.tools !== true) ||
    (answers.permissions !== undefined && !PERMISSION_ANSWERS.includes(answers.permissions as PermissionAnswer))
  )
    throw new CliError(
      "configuration_error",
      `${path}: ${SECTION} holds what setup asked — languages: true, tools: true, permissions: ${PERMISSION_ANSWERS.join(" | ")}`,
    )
  return answers as SetupAnswers
}

export const unanswered = (answers: SetupAnswers): Question[] =>
  QUESTIONS.filter((question) => answers[question] === undefined)

/** A section written wrongly is replaced; a file that is not JSON at all still refuses, naming itself. */
export const writeSetupAnswers = (path: string, answers: SetupAnswers): void => {
  let kept: SetupAnswers = {}
  try {
    kept = readSetupAnswers(path)
  } catch (error) {
    if (!(error instanceof CliError) || !error.message.includes(`${SECTION} holds`)) throw error
  }
  writeSharedSection(path, SECTION, { ...kept, ...answers })
}

/**
 * The level no command of any WireCat tool goes above, or `undefined` when the owner chose to leave them as they
 * are. A file that cannot be read keeps everything read-only: reads still work, and `setup` writes it again.
 */
export const permissionCeiling = (path: string): Level | undefined => {
  let answer: PermissionAnswer | undefined
  try {
    answer = readSetupAnswers(path).permissions
  } catch {
    return "readonly"
  }
  return answer === "allow" ? undefined : answer
}

/** `permissionCeiling` of this machine's shared config, for a tool that keeps its own levels: add it as `CEILING_KEY`. */
export const setupPermissionCeiling = (env: NodeJS.ProcessEnv = process.env): Level | undefined =>
  permissionCeiling(sharedConfigPath(storePath(env), env))
