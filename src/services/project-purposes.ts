import { CliError } from "@wirecat/cli-base"

/** What a chat can be for in a project, when the host's config names none. */
export const BUILT_IN_PURPOSES: readonly string[] = ["work", "sales", "support", "other"]
/** What `projects evidence` and `projects status` read when no purpose is asked for (built in; memo's config may change it). */
export const DEFAULT_PURPOSES: readonly string[] = ["work"]
/** A link with no purpose is a work chat. */
export const LINK_PURPOSE = "work"

/** The purposes a host's config lists; core knows only the built-in ones and takes the rest as given. */
export interface PurposeConfig {
  purposes: readonly string[]
  /** Read when no `--purpose` is given. */
  defaults: readonly string[]
  /** A project's own defaults, by its key or `project:<id>`. */
  projects?: Readonly<Record<string, readonly string[]>>
}

export const BUILT_IN_PURPOSE_CONFIG: PurposeConfig = { purposes: BUILT_IN_PURPOSES, defaults: DEFAULT_PURPOSES }

/** The purposes one run reads: `all`, or a set. */
export type PurposeChoice = "all" | ReadonlySet<string>

const unknown = (asked: readonly string[], config: PurposeConfig) => {
  const wrong = asked.filter((one) => !config.purposes.includes(one))
  if (wrong.length)
    throw new CliError(
      "validation_error",
      `unknown purpose ${wrong.join(", ")}; the configured ones are ${config.purposes.join(", ")}, or all`,
      { param: "purpose", purposes: [...config.purposes] },
    )
}

/**
 * The purposes a run reads: the asked ones, each checked against the config's list, else the project's own defaults,
 * else the config's. `all` reads every purpose, a link's unlisted one too.
 */
export const purposesOf = (
  asked: readonly string[] | undefined,
  config: PurposeConfig = BUILT_IN_PURPOSE_CONFIG,
  project?: { ref: string | null; key: string | null },
): PurposeChoice => {
  const words = (asked ?? []).map((one) => one.trim()).filter(Boolean)
  if (words.includes("all")) {
    if (words.length > 1) throw new CliError("validation_error", "--purpose all reads every purpose; give it alone")
    return "all"
  }
  if (words.length) {
    unknown(words, config)
    return new Set(words)
  }
  const own =
    (project?.key ? config.projects?.[project.key] : undefined) ??
    (project?.ref ? config.projects?.[project.ref] : undefined)
  return new Set(own ?? config.defaults)
}

export const purposeRead = (choice: PurposeChoice, purpose: string | null): boolean =>
  choice === "all" || choice.has(purpose ?? LINK_PURPOSE)

/** `a,b` and repeated flags as one list. */
export const purposeList = (value: string, previous: string[] = []): string[] => [
  ...previous,
  ...value
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean),
]
