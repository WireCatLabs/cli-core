import { CliError } from "@wirecat/cli-base"

/** An exclusion as the mirror keeps it: trimmed, without a trailing `/`; refused when it names nothing or leaves. */
export const exclusionPattern = (input: string): string => {
  const pattern = input.trim().replace(/\/+$/u, "")
  const parts = pattern.replace(/^\//u, "").split("/")
  if (!pattern || pattern === "/" || parts.some((part) => !part || part === "." || part === ".."))
    throw new CliError(
      "validation_error",
      `${JSON.stringify(input)} is not a path pattern like Photos or /Work/*.iso`,
      {
        reason: "mirror.bad-exclusion",
      },
    )
  return pattern
}

const globSource = (glob: string) =>
  glob
    .split(/(\*\*\/|\*\*|\*|\?)/u)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part === "?"
              ? "[^/]"
              : part.replace(/[.+^${}()|[\]\\]/gu, "\\$&"),
    )
    .join("")

/**
 * Whether a mirror's exclusions cover `path`, or a folder on the way to it. A pattern without `/` is a name at any
 * depth (`node_modules`, `*.iso`); one with `/` is a path from the mirror's root (`Photos/2019`, `/Camera`). `*` and `?`
 * stay within a name; `**` crosses folders.
 */
export const excludedBy = (patterns: readonly string[] = []) => {
  const test = (glob: string) => new RegExp(`^${globSource(glob)}$`, "u")
  const names = patterns.filter((pattern) => !pattern.includes("/")).map(test)
  const paths = patterns.filter((pattern) => pattern.includes("/")).map((pattern) => test(pattern.replace(/^\//u, "")))
  return (path: string): boolean => {
    if (!names.length && !paths.length) return false
    const parts = path.split("/")
    return parts.some(
      (name, index) =>
        names.some((glob) => glob.test(name)) || paths.some((way) => way.test(parts.slice(0, index + 1).join("/"))),
    )
  }
}
