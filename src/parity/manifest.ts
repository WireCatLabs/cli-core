import type { CommandInfo, OptionInfo } from "@wirecat/cli-base/commands"

/** A name from the manifest's `clis`: `max`, `tg`, and whichever CLI joins next. */
export type Cli = string

/**
 * Which CLIs have a command or option. `in` lists them, or is `"all"`. A CLI outside `in` is either
 * `planned` — who closes the gap, and nothing is checked for it — or lacks it for the row's `reason`.
 */
export interface Presence {
  in: "all" | Cli[]
  reason?: string
  planned?: Record<Cli, string>
}

/** An option: `"all"` alone, or where it is and why not elsewhere. */
export type Entry = "all" | (Presence & { wording?: string })

export interface CommandRow extends Presence {
  /** On a planned row: it stands for every path below it, which then have no rows of their own. */
  subtree?: boolean
  options?: Record<string, Entry>
}

export interface CatalogueOption {
  value?: string
  meaning: string
  default?: string
  note?: string
}

export interface Manifest {
  clis: Cli[]
  options: Record<string, CatalogueOption>
  globalOptions: Record<string, Entry>
  commands: Record<string, CommandRow>
}

/** What `commands --json` prints, as far as the check reads it. */
export interface CommandsJson {
  cli: string
  global_options: readonly OptionInfo[]
  commands: readonly CommandInfo[]
}

export const longName = (flags: string): string => flags.split(/[\s,|]+/).find((part) => part.startsWith("--")) ?? flags

const presence = (entry: Entry | CommandRow): Presence => (typeof entry === "string" ? { in: entry } : entry)

/** `true` the CLI must have it, `false` it must not, `undefined` it is planned and either passes. */
export const expected = (entry: Entry | CommandRow, cli: Cli): boolean | undefined => {
  const row = presence(entry)
  if (row.in === "all" || row.in.includes(cli)) return true
  return row.planned?.[cli] === undefined ? false : undefined
}

/** A row only one CLI has, for a stated reason: everything below it is that CLI's alone, and unrowed. */
export const solo = (row: CommandRow) => row.in !== "all" && row.in.length === 1 && row.reason !== undefined

const describe = (row: Presence) =>
  row.in === "all" ? "all" : row.in.length === 1 ? `${row.in[0]}-only` : row.in.join("+") || "in none"

const entryProblems = (clis: readonly Cli[], where: string, entry: Entry | CommandRow): string[] => {
  if (typeof entry === "string") return entry === "all" ? [] : [`${where}: "${entry}" — only "all" stands alone`]
  const problems: string[] = []
  const names = entry.in === "all" ? [] : Array.isArray(entry.in) ? entry.in : undefined
  if (names === undefined) return [`${where}: "in" is neither "all" nor a list of CLIs`]
  if ("wording" in entry && (typeof entry.wording !== "string" || entry.wording.trim() === ""))
    problems.push(`${where}: a wording exception needs its reason`)
  const planned = Object.entries(entry.planned ?? {})
  for (const name of [...names, ...planned.map(([name]) => name)])
    if (!clis.includes(name))
      problems.push(`${where}: no such CLI "${name}" — the manifest's clis are ${clis.join(", ")}`)
  if (new Set(names).size !== names.length) problems.push(`${where}: a CLI named twice in "in"`)
  if (names.length > 0 && clis.every((cli) => names.includes(cli)))
    problems.push(`${where}: in every CLI — write "all"`)
  for (const [name, by] of planned) {
    if (names.includes(name) || entry.in === "all") problems.push(`${where}: planned for ${name}, which has it`)
    if (!by) problems.push(`${where}: planned for ${name} without who closes it`)
  }
  const lacking = clis.filter((cli) => expected(entry, cli) === false)
  if (lacking.length > 0 && !entry.reason) problems.push(`${where}: not in ${lacking.join(", ")}, without a reason`)
  if (lacking.length === 0 && entry.reason) problems.push(`${where}: a reason, but no CLI lacks it unplanned`)
  return problems
}

const unsorted = (where: string, keys: string[]): string[] => {
  const sorted = [...keys].sort()
  const at = keys.findIndex((key, index) => key !== sorted[index])
  return at === -1 ? [] : [`${where}: keys out of order at "${keys[at]}" — run the seed to sort`]
}

/** The row above `path` that covers it and everything else below it: one CLI's alone, or planned as a subtree. */
export const coveringRow = (manifest: Manifest, path: string): string | undefined => {
  const words = path.split(" ")
  for (let length = words.length - 1; length > 0; length--) {
    const parent = words.slice(0, length).join(" ")
    const row = manifest.commands[parent]
    if (row && (solo(row) || row.subtree)) return parent
  }
  return undefined
}

/** Everything wrong with the manifest itself; empty when it is well-formed. */
export const manifestProblems = (manifest: Manifest): string[] => {
  const clis = Array.isArray(manifest.clis) ? manifest.clis : []
  const problems: string[] = [
    ...(clis.length === 0 ? ['clis: no CLIs — the manifest starts with "clis": ["max", "tg"]'] : []),
    ...(new Set(clis).size === clis.length ? [] : ["clis: a CLI named twice"]),
    ...unsorted("options", Object.keys(manifest.options)),
    ...unsorted("globalOptions", Object.keys(manifest.globalOptions)),
    ...unsorted("commands", Object.keys(manifest.commands)),
  ]
  const used = new Set<string>()
  const optionEntries = (where: string, options: Record<string, Entry>) => {
    problems.push(...unsorted(`${where} options`, Object.keys(options)))
    for (const [name, entry] of Object.entries(options)) {
      used.add(name)
      if (!manifest.options[name]) problems.push(`${where} ${name}: not in the option catalogue`)
      problems.push(...entryProblems(clis, `${where} ${name}`, entry))
    }
  }

  optionEntries("(global)", manifest.globalOptions)
  for (const [path, row] of Object.entries(manifest.commands)) {
    problems.push(...entryProblems(clis, path, row))
    if (row.subtree && Object.keys(row.planned ?? {}).length === 0)
      problems.push(`${path}: subtree on a row nobody plans`)
    const parent = path.split(" ").slice(0, -1).join(" ")
    if (parent && !manifest.commands[parent]) problems.push(`${path}: no row for its parent "${parent}"`)
    const cover = coveringRow(manifest, path)
    if (cover && (manifest.commands[cover]?.subtree || Object.keys(row.options ?? {}).length === 0)) {
      const above = manifest.commands[cover]
      const how = above?.subtree ? "planned" : above ? describe(above) : ""
      problems.push(`${path}: under "${cover}", which is ${how} and covers it`)
    }
    optionEntries(path, row.options ?? {})
  }

  for (const [name, option] of Object.entries(manifest.options)) {
    if (!option.meaning) problems.push(`options ${name}: no meaning`)
    if (!used.has(name)) problems.push(`options ${name}: in the catalogue, on no command`)
  }
  return problems
}

const compare = (cli: Cli, where: string, entry: Entry | CommandRow | undefined, has: boolean): string[] => {
  if (entry === undefined) return has ? [`${where}: not in the manifest — add its row first`] : []
  const want = expected(entry, cli)
  if (want === undefined || want === has) return []
  const row = presence(entry)
  return has
    ? [`${where}: ${cli} has it, the manifest says ${describe(row)}`]
    : [`${where}: the manifest says ${describe(row)}, ${cli} lacks it`]
}

const optionsOf = (options: readonly OptionInfo[]) => new Set(options.map((option) => longName(option.flags)))

const compareOptions = (cli: Cli, where: string, entries: Record<string, Entry>, options: readonly OptionInfo[]) => {
  const has = optionsOf(options)
  return [...new Set([...has, ...Object.keys(entries)])]
    .sort()
    .flatMap((name) => compare(cli, `${where} ${name}`, entries[name], has.has(name)))
}

/** Where a CLI's `commands --json` disagrees with its column of the manifest; empty when it agrees. */
export const parityProblems = (manifest: Manifest, cli: Cli, program: CommandsJson): string[] => {
  const found = new Map<string, CommandInfo>()
  const walk = (command: CommandInfo) => {
    found.set(command.path.join(" "), command)
    command.commands.forEach(walk)
  }
  program.commands.forEach(walk)

  const problems = compareOptions(cli, "(global)", manifest.globalOptions, program.global_options)
  const paths = [...new Set([...found.keys(), ...Object.keys(manifest.commands)])].sort()
  for (const path of paths) {
    if (coveringRow(manifest, path)) continue
    const row = manifest.commands[path]
    const command = found.get(path)
    const nativeApi = manifest.commands["bot api"]
    if (
      !row &&
      command?.origin === "generated" &&
      command.api_operation &&
      path.startsWith("bot api ") &&
      nativeApi &&
      expected(nativeApi, cli) !== false
    )
      continue
    problems.push(...compare(cli, path, row, command !== undefined))
    // A command still planned for this CLI may come with any options: they are checked once it is.
    if (
      row &&
      command &&
      expected(row, cli) === true &&
      (!solo(row) || (coveringRow(manifest, path) !== undefined && Object.keys(row.options ?? {}).length > 0))
    )
      problems.push(...compareOptions(cli, path, row.options ?? {}, command.options))
  }
  return problems
}
