import { annotate } from "@wirecat/cli-base/commands"
import { skillCommand as sharedSkillCommand } from "@wirecat/cli-base/skill"
import type { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { environmentOf, outputFor } from "./context.js"
import { grantsAuthority } from "./effects.js"
import { printItem } from "./envelope.js"

/**
 * `skill show` and `skill install`. `skill` is the CLI's own SKILL.md, shipped beside `dist/` in the
 * package and in a checkout alike, so the skill printed is always this version's.
 */
export const skillCommand = (app: AppIdentity, skill: URL): Command => {
  const command = sharedSkillCommand(
    app,
    skill,
    (command) => {
      const { env } = environmentOf(command)
      const output = outputFor(command)
      // cli-base prints each answer bare; the envelope is cli-core's.
      const renderer = { ...output.renderer, result: (value: unknown) => printItem(output, value) }
      return { ...output, renderer, ...(env ? { env } : {}) }
    },
    app.messenger === false ? {} : SHARED_SKILLS,
  )
  // An installed skill is instructions every later agent follows.
  const install = command.commands.find((sub) => sub.name() === "install")
  if (install) {
    grantsAuthority(install)
    annotate(install, { examples: [`${app.command} skill install --for agents`] })
  }
  const show = command.commands.find((sub) => sub.name() === "show")
  if (show)
    annotate(show, {
      examples: [
        `${app.command} skill show`,
        ...(app.messenger === false ? [] : [`${app.command} skill show follow-ups`]),
      ],
    })
  return command
}

/**
 * Skills this package ships for the messenger CLIs, printed by `skill show <name>`: `skills/` beside `dist/` and `src/`.
 * Both work on chats, so a CLI without them offers neither.
 */
const SHARED_SKILLS = {
  "follow-ups": new URL("../../skills/follow-ups/SKILL.md", import.meta.url),
  "link-conversations": new URL("../../skills/link-conversations/SKILL.md", import.meta.url),
}
