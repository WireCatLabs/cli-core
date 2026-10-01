/**
 * The CLI's own SKILL.md for coding agents: printing it, installing it where agents look for skills,
 * telling an agent once a day that its copy is missing or old, and serving it to an MCP client.
 *
 * Nothing here prints by itself. The command writes through the renderer and streams the host hands
 * it, and the hint is a string the host puts on stderr — never stdout, which an agent parses.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Command, Option } from "commander"
import type { Renderer } from "../renderer.js"
import type { Streams } from "../streams.js"
import { CHECK_EVERY_MS, isNewer, readNoticeState, writeUpdateState } from "../update/index.js"

type Env = Readonly<Record<string, string | undefined>>

export interface SkillApp {
  /** `tg` — what an agent types. */
  command: string
  /** `tg-cli` — the skill's directory name, and the `name` in its frontmatter. */
  appName: string
  version: string
}

export const SKILL_TARGETS = ["claude", "agents"] as const
export type SkillTarget = (typeof SKILL_TARGETS)[number]

const homeOf = (env: Env): string => env.HOME || env.USERPROFILE || homedir()

/** `~/.claude/skills` is Claude Code's; `~/.agents/skills` is read by Codex and Gemini CLI. */
export const skillPath = (target: SkillTarget, appName: string, env: Env): string =>
  join(homeOf(env), target === "claude" ? ".claude" : ".agents", "skills", appName, "SKILL.md")

const FRONTMATTER = /^---(\r?\n)([\s\S]*?\r?\n)?---(\r?\n|$)/

/** The `version:` field of the frontmatter, or `undefined` when there is none. */
export const skillVersion = (content: string): string | undefined => {
  const body = FRONTMATTER.exec(content)?.[2] ?? ""
  return /^version:[ \t]*["']?([^"'\r\n]*?)["']?[ \t]*\r?$/m.exec(body)?.[1]
}

/** Adds or replaces `version:` in the frontmatter; every other byte stays as it was. */
export const withVersion = (content: string, version: string): string => {
  const match = FRONTMATTER.exec(content)
  if (!match) return `---\nversion: ${version}\n---\n${content}`
  const [whole, eol = "\n", body = "", close = ""] = match
  const field = /^version:.*$/m
  const next = field.test(body) ? body.replace(field, `version: ${version}`) : `${body}version: ${version}${eol}`
  return `---${eol}${next}---${close}${content.slice(whole.length)}`
}

/** Writes the stamped SKILL.md to each target, creating directories; the same run twice gives the same files. */
export const installSkill = (
  app: SkillApp,
  skill: URL,
  { targets = SKILL_TARGETS, env = process.env }: { targets?: readonly SkillTarget[]; env?: Env } = {},
): string[] => {
  const content = withVersion(readFileSync(skill, "utf8"), app.version)
  return targets.map((target) => {
    const path = skillPath(target, app.appName, env)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  })
}

/** What the command writes to and where home is, for this invocation — the host's own output resolution. */
export type SkillEnvironment = (command: Command) => { renderer: Renderer; streams: Streams; env?: Env }

export const skillCommand = (app: SkillApp, skill: URL, environment: SkillEnvironment): Command => {
  const command = new Command("skill").description("the instructions an agent is given for this tool")
  const machine = (self: Command) => {
    const { json, jsonl } = self.optsWithGlobals<{ json?: boolean; jsonl?: boolean }>()
    return json === true || jsonl === true
  }

  command
    .command("show")
    .description(
      `print SKILL.md — \`${app.command} skill install\` puts it where Claude Code, Codex and Gemini CLI look for it`,
    )
    .action(function (this: Command) {
      const { renderer, streams } = environment(this)
      const content = readFileSync(skill, "utf8").trimEnd()
      // The file itself even into a pipe: saving it is a redirect, and a redirect is where every
      // other command switches to JSON. Asked for by name, it is JSON like the rest.
      if (machine(this)) renderer.result({ name: app.appName, content })
      else streams.data(content)
    })

  command
    .command("install")
    .description(
      `write SKILL.md to ~/.claude/skills/${app.appName}/ (Claude Code) and ~/.agents/skills/${app.appName}/ (Codex, Gemini CLI)`,
    )
    .addOption(
      new Option("--for <agents>", "which agents to install for").choices(["claude", "agents", "all"]).default("all"),
    )
    .action(function (this: Command, { for: chosen }: { for: "claude" | "agents" | "all" }) {
      const { renderer, env } = environment(this)
      const targets = chosen === "all" ? SKILL_TARGETS : [chosen]
      const written = installSkill(app, skill, { targets, ...(env ? { env } : {}) })
      renderer.result({ name: app.appName, version: app.version, written })
      renderer.success(`${app.appName} ${app.version} skill installed: ${written.join(", ")}`)
    })

  return command
}

export interface SkillHintRequest {
  app: SkillApp
  /** The words the CLI was run with: no hint while it runs `skill` or `complete`. */
  argv: readonly string[]
  env: Env
  /** The update notice's state file — one file for both daily notices. */
  statePath: string
  /** The setting `skillHint`; `false` turns the hint off. */
  enabled?: boolean
  now?: () => number
}

const isAgent = (env: Env): boolean => Boolean(env.AI_AGENT || env.CLAUDECODE)

const needsInstall = (app: SkillApp, env: Env): boolean => {
  const installed = SKILL_TARGETS.flatMap((target) => {
    try {
      return [skillVersion(readFileSync(skillPath(target, app.appName, env), "utf8"))]
    } catch {
      return []
    }
  })
  // A location never installed to is a choice (`--for claude`); only no copy at all, or an old one, is worth a line.
  return installed.length === 0 || installed.some((version) => version === undefined || isNewer(app.version, version))
}

/**
 * One line for an agent whose copy of SKILL.md is missing or older than this CLI, at most once a
 * day, or `undefined`. The host prints it on stderr. Any failure is silence.
 */
export const skillHint = ({ app, argv, env, statePath, enabled = true, now = Date.now }: SkillHintRequest) => {
  try {
    if (!enabled || !isAgent(env)) return undefined
    if (argv.includes("skill") || argv.includes("complete")) return undefined
    const at = now()
    const shown = readNoticeState(statePath).skillHintAt
    if (shown !== undefined && at - shown < CHECK_EVERY_MS) return undefined
    if (!needsInstall(app, env)) return undefined
    writeUpdateState(statePath, { skillHintAt: at })
    return `agents: \`${app.command} skill install\` installs this tool's guide`
  } catch {
    return undefined
  }
}

export interface SkillResource {
  uri: string
  name: string
  title: string
  description: string
  mimeType: "text/markdown"
  read: () => { contents: { uri: string; mimeType: "text/markdown"; text: string }[] }
  /** A line for the server's `instructions`. */
  instruction: string
}

/**
 * What an MCP server registers to serve SKILL.md as `<command>://skill`, for a client with no shell —
 * `server.registerResource(r.name, r.uri, { title, description, mimeType }, r.read)`. The SDK stays the host's.
 */
export const skillResource = (app: SkillApp, skill: URL): SkillResource => {
  const uri = `${app.command}://skill`
  return {
    uri,
    name: "skill",
    title: `${app.appName} SKILL.md`,
    description: `How to use ${app.command}: the guide an agent is given for this tool.`,
    mimeType: "text/markdown",
    read: () => ({ contents: [{ uri, mimeType: "text/markdown", text: readFileSync(skill, "utf8") }] }),
    instruction: `- The full guide is the resource ${uri}; \`${app.command} skill install\` installs it as an agent skill.`,
  }
}
