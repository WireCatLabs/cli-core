import type { Command } from "commander"

export const SECTIONS = {
  read: "Read",
  write: "Write",
  organise: "Organise",
  automate: "Automate",
  setup: "Set up",
  other: "Other",
} as const
export type HelpSection = Exclude<keyof typeof SECTIONS, "other">

const sections = new WeakMap<Command, HelpSection>()

/**
 * Where `<tool> commands` lists the command and everything under it. Kept off `annotate`, whose metadata becomes
 * fields of `commands --json`, which must not change.
 */
export const inSection = <T extends Command>(command: T, section: HelpSection): T => {
  sections.set(command, section)
  return command
}

/**
 * The nearest section on the command or above it, then cli-core's own for a top-level group of that name; `other`
 * when neither is set. Looked up when listed, so a tool with its own program needs no install step.
 */
export const sectionOf = (command: Command): keyof typeof SECTIONS => {
  for (let at: Command | null = command; at; at = at.parent) {
    const section = sections.get(at) ?? (at.parent && !at.parent.parent ? CORE_SECTIONS[at.name()] : undefined)
    if (section) return section
  }
  return "other"
}

/** The groups cli-core builds, by name; a tool sets its own with `inSection`. */
const CORE_SECTIONS: Readonly<Record<string, HelpSection>> = {
  attachments: "read",
  chats: "read",
  contacts: "read",
  conversations: "read",
  images: "read",
  inbox: "read",
  meetings: "read",
  mentions: "read",
  messages: "read",
  review: "read",
  search: "read",
  stats: "read",
  topics: "read",
  watch: "read",
  flood: "write",
  polls: "write",
  reactions: "write",
  recipients: "write",
  sends: "write",
  metadata: "organise",
  searches: "organise",
  tags: "organise",
  tasks: "organise",
  bot: "automate",
  mcp: "automate",
  replies: "automate",
  runs: "automate",
  schedule: "automate",
  serve: "automate",
  server: "automate",
  account: "setup",
  commands: "setup",
  complete: "setup",
  config: "setup",
  doctor: "setup",
  guide: "setup",
  models: "setup",
  skill: "setup",
  store: "setup",
  upgrade: "setup",
}
