import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { CliError, resolvePaths } from "@wirecat/cli-base"
import {
  DEFAULT_TASK_CATEGORIES,
  FALLBACK_CATEGORY,
  type TaskCategory,
  taskCategoryValue,
  withTaskCategory,
} from "../domain/task-categories.js"
import { storePath } from "./path.js"

/** A category's text as `config set` takes it, or `null` to drop a default one. */
export type TaskCategoryEdits = Record<string, string | null>

const SECTION = "task_categories"

/**
 * The file tg, MAX and memo read the owner's settings from: `~/.config/WireCat/config.json` for the default store.
 * A store moved by `MESSAGING_STORE` (tests, `bin/tg`) reads the one beside it, so it never reads the owner's.
 */
export const sharedConfigPath = (store: string, env: NodeJS.ProcessEnv = process.env): string => {
  const paths = resolvePaths({ appName: "WireCat", prefix: "WIRECAT", env })
  if (env.WIRECAT_CONFIG_DIR) return join(paths.config, "config.json")
  return resolve(store) === resolve(storePath({ ...env, MESSAGING_STORE: undefined }))
    ? join(paths.config, "config.json")
    : join(dirname(store), "config.json")
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CliError("configuration_error", `${path} is not valid JSON: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("configuration_error", `${path} must hold a JSON object`)
  return parsed as Record<string, unknown>
}

/** The `task_categories` section, or `undefined` when the file or the section is missing. */
export const readTaskCategoryEdits = (path: string): TaskCategoryEdits | undefined => {
  const section = readSharedSection(path, SECTION)
  if (section === undefined) return undefined
  if (section === null || typeof section !== "object" || Array.isArray(section))
    throw new CliError(
      "configuration_error",
      `${path}: ${SECTION} must be an object of "<name>": "<meaning> | <words>"`,
    )
  for (const [name, value] of Object.entries(section))
    if (value !== null && typeof value !== "string")
      throw new CliError(
        "configuration_error",
        `${path}: ${SECTION}.${name} takes "<meaning> | <words>", or null to drop the category`,
      )
  return section as TaskCategoryEdits
}

/** `base` with the edits applied: a text sets the category (a new one goes before `other`), `null` drops it. */
export const applyTaskCategoryEdits = (
  base: readonly TaskCategory[],
  edits: TaskCategoryEdits,
  path: string,
): readonly TaskCategory[] =>
  Object.entries(edits).reduce<readonly TaskCategory[]>((list, [name, value]) => {
    if (value === null && !list.some((one) => one.name === name.trim().toLowerCase())) return list
    try {
      return withTaskCategory(list, name, value ?? undefined)
    } catch (error) {
      if (error instanceof CliError) throw new CliError("configuration_error", `${path}: ${error.message}`)
      throw error
    }
  }, base)

/** The edits that turn the default list into `list`, for moving a list an older build saved in the store. */
export const editsFrom = (list: readonly TaskCategory[]): TaskCategoryEdits => {
  const edits: TaskCategoryEdits = {}
  const kept = new Map(list.map((one) => [one.name, one]))
  for (const one of DEFAULT_TASK_CATEGORIES)
    if (!kept.has(one.name) && one.name !== FALLBACK_CATEGORY) edits[one.name] = null
  for (const one of list) {
    const value = taskCategoryValue(one)
    const before = DEFAULT_TASK_CATEGORIES.find(({ name }) => name === one.name)
    if (!before || taskCategoryValue(before) !== value) edits[one.name] = value
  }
  return edits
}

/** One section of the file, or `undefined` when the file or the section is missing. */
export const readSharedSection = (path: string, section: string): unknown => readJson(path)?.[section]

/** Writes one section (or drops it, with `undefined`), keeping every other key of the file. */
export const writeSharedSection = (path: string, section: string, value: unknown): void => {
  const file = readJson(path) ?? {}
  if (value === undefined) delete file[section]
  else file[section] = value
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Writes the section (or drops it, with `undefined`), keeping every other key of the file. */
export const writeTaskCategoryEdits = (path: string, edits: TaskCategoryEdits | undefined): void =>
  writeSharedSection(path, SECTION, edits === undefined || Object.keys(edits).length === 0 ? undefined : edits)

/** Read again only when the file changed: a sync asks for the list once per message. */
export const taskCategoriesReader = (path: string) => {
  let seen: { stamp: string; base: readonly TaskCategory[]; list: readonly TaskCategory[] } | undefined
  return (base: readonly TaskCategory[]): readonly TaskCategory[] => {
    let stamp = "none"
    try {
      const { mtimeMs, size } = statSync(path)
      stamp = `${mtimeMs}:${size}`
    } catch {}
    if (seen?.stamp === stamp && seen.base === base) return seen.list
    const edits = readTaskCategoryEdits(path)
    const list = edits ? applyTaskCategoryEdits(base, edits, path) : base
    seen = { stamp, base, list }
    return list
  }
}
