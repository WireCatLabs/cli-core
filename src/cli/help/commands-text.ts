import type { CommandInfo } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { findCommand } from "../command-contract.js"
import { SECTIONS, sectionOf } from "./sections.js"

const DESCRIPTION = 90
const COLUMN = 52

/** The first clause that fits: a line per command is the point, the whole text is in `--help`. */
const short = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= DESCRIPTION) return line
  const cut = line.slice(0, DESCRIPTION)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), DESCRIPTION / 2))}…`
}

/**
 * `<tool> commands` for a person or an agent reading text: every command that runs, one line each, under its
 * section. `scope` is the group asked for (`commands messages`), whose commands are all listed.
 */
export const commandsText = (root: Command, commands: readonly CommandInfo[], scope?: readonly string[]): string => {
  const cli = root.name()
  const runs = (info: CommandInfo): CommandInfo[] => [
    ...(info.commands.length === 0 || info.runnable ? [info] : []),
    ...info.commands.flatMap(runs),
  ]
  const bySection = new Map<keyof typeof SECTIONS, CommandInfo[]>(
    Object.keys(SECTIONS).map((key) => [key as keyof typeof SECTIONS, []]),
  )
  for (const info of commands.flatMap(runs)) bySection.get(sectionOf(findCommand(root, info.path)))?.push(info)
  const where = scope ? `${cli} ${scope.join(" ")}` : cli
  const lines = [
    `${where} commands, by section. One command's arguments and options: ${cli} <command> --help.`,
    `As JSON: ${cli} commands${scope ? ` ${scope.join(" ")}` : ""} --json. (writes) marks a command that changes something.`,
  ]
  for (const [section, infos] of bySection) {
    if (infos.length === 0) continue
    lines.push("", SECTIONS[section])
    for (const { usage, summary, description, effects } of infos) {
      const what = short(summary ?? description)
      const mark = effects === undefined || writes(effects) ? " (writes)" : ""
      lines.push(`  ${usage.padEnd(COLUMN)}  ${what}${mark}`.trimEnd())
    }
  }
  return `${lines.join("\n")}\n`
}
