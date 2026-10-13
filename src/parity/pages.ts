import type { CommandInfo } from "@wirecat/cli-base/commands"
import { type Cli, type CommandsJson, expected, type Manifest } from "./manifest.js"

const optionsOf = (flags: string): string[] => flags.match(/--[a-z][a-z-]*/g) ?? []

/**
 * Every `<cli> <command> --option` on a user page whose option the command does not have. An option
 * the manifest gives or plans for this CLI on that command passes — docs come first, the code follows —
 * and one this CLI lacks does not.
 */
export const pageProblems = (page: string, cli: Cli, manifest: Manifest, program: CommandsJson): string[] => {
  const commands = new Map<string, Set<string>>()
  const walk = (command: CommandInfo) => {
    commands.set(command.path.join(" "), new Set(command.options.flatMap((option) => optionsOf(option.flags))))
    command.commands.forEach(walk)
  }
  program.commands.forEach(walk)
  const globals = new Set(program.global_options.flatMap((option) => optionsOf(option.flags)))
  // Commander adds this automatically; command introspection lists only explicit options.
  globals.add("--help")

  const problems: string[] = []
  const line = new RegExp(`\\b${cli} ((?:[a-z][a-z-]* ?)+)([^\\n\`#|]*)`, "g")
  for (const [, words, rest] of page.matchAll(line)) {
    const typed = (words ?? "").trim().split(" ")
    // A first word that is not a command is a profile.
    const command = [typed, typed.slice(1)]
      .flatMap((candidate) => candidate.map((_, end) => candidate.slice(0, candidate.length - end).join(" ")))
      .find((path) => commands.has(path))
    if (command === undefined) continue
    const planned = manifest.commands[command]?.options ?? {}
    for (const option of (rest ?? "").match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []) {
      if (commands.get(command)?.has(option) || globals.has(option)) continue
      const entry = planned[option]
      if (entry !== undefined && expected(entry, cli) !== false) continue
      problems.push(`${cli} ${command} ${option}`)
    }
  }
  return problems
}
