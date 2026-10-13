import type { CommandInfo, OptionInfo } from "@wirecat/cli-base/commands"
import {
  type Cli,
  type CommandRow,
  type CommandsJson,
  coveringRow,
  type Entry,
  longName,
  type Manifest,
  type Presence,
  solo,
} from "./manifest.js"

const sorted = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

const commandsOf = (program: CommandsJson) => {
  const found = new Map<string, CommandInfo>()
  const walk = (command: CommandInfo) => {
    found.set(command.path.join(" "), command)
    command.commands.forEach(walk)
  }
  program.commands.forEach(walk)
  return found
}

const where = (clis: readonly Cli[], having: readonly Cli[]) =>
  having.length === clis.length
    ? { in: "all" as const }
    : {
        in: [...having],
        planned: Object.fromEntries(clis.filter((cli) => !having.includes(cli)).map((cli) => [cli, "?"])),
      }

/**
 * `manifest` with every command and option the programs have and it lacks, sorted. A program per CLI
 * of the manifest, known by its `cli`. A row that is there is left as it is.
 */
export const seedPrograms = (manifest: Manifest, programs: readonly CommandsJson[]): Manifest => {
  const missing = manifest.clis.filter((cli) => !programs.some((program) => program.cli === cli))
  if (missing.length > 0) throw new Error(`no commands --json for ${missing.join(", ")}`)
  const next: Manifest = structuredClone(manifest)
  const trees = new Map(programs.map((program) => [program.cli, commandsOf(program)]))

  const catalogue = (option: OptionInfo) => {
    const name = longName(option.flags)
    if (next.options[name]) return
    const value = /[<[][^>\]]+[>\]]/.exec(option.flags)?.[0]
    next.options[name] = {
      ...(value ? { value } : {}),
      meaning: option.description,
      ...(option.default === undefined ? {} : { default: String(option.default) }),
    }
  }
  const seedOptions = (entries: Record<string, Entry>, options: Map<Cli, readonly OptionInfo[]>) => {
    for (const option of [...options.values()].flat()) {
      catalogue(option)
      const name = longName(option.flags)
      const having = next.clis.filter((cli) => options.get(cli)?.some((one) => longName(one.flags) === name))
      const place = where(next.clis, having)
      entries[name] ??= place.in === "all" ? "all" : place
    }
  }

  seedOptions(next.globalOptions, new Map(programs.map((program) => [program.cli, program.global_options])))
  const paths = new Set([...trees.values()].flatMap((tree) => [...tree.keys()]))
  for (const path of [...paths].sort()) {
    if (coveringRow(next, path)) continue
    const having = next.clis.filter((cli) => trees.get(cli)?.has(path))
    next.commands[path] ??= where(next.clis, having)
    const row = next.commands[path] as CommandRow
    if (solo(row)) continue
    const options = { ...row.options }
    seedOptions(options, new Map(having.map((cli) => [cli, trees.get(cli)?.get(path)?.options ?? []])))
    if (Object.keys(options).length > 0) row.options = sorted(options)
  }

  return {
    ...next,
    options: sorted(next.options),
    globalOptions: sorted(next.globalOptions),
    commands: sorted(next.commands),
  }
}

/** `manifest` with `cli` added to its CLIs and every command and option planned for it, by `"?"`. */
export const seedCli = (manifest: Manifest, cli: Cli): Manifest => {
  if (manifest.clis.includes(cli)) throw new Error(`${cli} is in the parity manifest already`)
  const plan = (entry: Entry): Presence => {
    const row: Presence = typeof entry === "string" ? { in: entry } : entry
    return {
      in: row.in === "all" ? [...manifest.clis] : row.in,
      ...(row.reason ? { reason: row.reason } : {}),
      planned: { ...row.planned, [cli]: "?" },
    }
  }
  const planAll = (entries: Record<string, Entry>) =>
    Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, plan(entry)]))
  return {
    ...manifest,
    clis: [...manifest.clis, cli],
    globalOptions: planAll(manifest.globalOptions),
    commands: Object.fromEntries(
      Object.entries(manifest.commands).map(([path, row]) => [
        path,
        {
          ...plan(row),
          ...(row.subtree ? { subtree: true } : {}),
          ...(row.options ? { options: planAll(row.options) } : {}),
        },
      ]),
    ),
  }
}

/** `parity.json` as Biome formats it: two-space JSON, each list of CLIs on one line. */
export const formatManifest = (manifest: unknown): string =>
  `${JSON.stringify(manifest, null, 2).replace(/\[\s+((?:"[^"]*",?\s*)+)\]/g, (_, items: string) => `[${items.trim().split(/,\s*/).join(", ")}]`)}\n`
