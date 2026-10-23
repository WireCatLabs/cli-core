import { CliError } from "@wirecat/cli-base"
import type { Level } from "../sends/permissions.js"
import { readSharedSection, writeSharedSection } from "../store/shared-config.js"

/** "allow" leaves every profile as its own configuration says. */
export const PERMISSION_ANSWERS = ["readonly", "ask", "allow"] as const
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

export const writeSetupAnswers = (path: string, answers: SetupAnswers): void =>
  writeSharedSection(path, SECTION, { ...readSetupAnswers(path), ...answers })

/** The level no command of any WireCat CLI goes above, or `undefined` when the owner chose to leave them as they are. */
export const permissionCeiling = (path: string): Level | undefined => {
  const answer = readSetupAnswers(path).permissions
  return answer === "allow" ? undefined : answer
}
