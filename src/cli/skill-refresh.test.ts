import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { createProgram } from "./program.js"
import { skillCommand, skillSourceOf } from "./skill-command.js"
import { refreshSkills, skipsSkillRefresh } from "./skill-refresh.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test CLI", version: "2.0.0" }

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "skill-refresh-"))
  const env = { HOME: join(root, "home"), HERMES_HOME: join(root, "hermes") }
  const skill = join(root, "SKILL.md")
  writeFileSync(skill, "---\nname: chat-cli\n---\n\n# chat, new\n")
  const claude = join(env.HOME, ".claude", "skills", "chat-cli", "SKILL.md")
  const agents = join(env.HOME, ".agents", "skills", "chat-cli", "SKILL.md")
  const hermes = join(env.HERMES_HOME, "skills", "chat-cli", "SKILL.md")
  const put = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const refresh = () =>
    refreshSkills({ app, skill: pathToFileURL(skill), env, markerPath: join(root, "state", "skill-refresh.json") })
  return { root, claude, agents, hermes, put, refresh }
}

const OLD = '---\nname: chat-cli\nmetadata:\n  version: "1.0.0"\n---\n\n# chat, old\n'

describe("refreshing installed skills on a new version", () => {
  it("rewrites a stale copy and says so in one line", () => {
    const { claude, agents, put, refresh } = setup()
    put(claude, OLD)
    put(agents, OLD)

    expect(refresh()).toBe("Updated the chat instructions for Claude Code and other agents to 2.0.0")
    for (const path of [claude, agents]) {
      expect(readFileSync(path, "utf8")).toBe(
        '---\nname: chat-cli\nmetadata:\n  version: "2.0.0"\n---\n\n# chat, new\n',
      )
    }
  })

  it("**never installs where no copy is**: a missing target is the owner's choice", () => {
    const { claude, agents, put, refresh } = setup()
    put(claude, OLD)

    expect(refresh()).toBe("Updated the chat instructions for Claude Code to 2.0.0")
    expect(existsSync(agents)).toBe(false)
  })

  it("**leaves an unversioned copy byte for byte**: no released skill install wrote it", () => {
    const { claude, put, refresh } = setup()
    const own = "---\nname: chat-cli\n---\n\n# my own notes\n"
    put(claude, own)

    expect(refresh()).toBeUndefined()
    expect(readFileSync(claude, "utf8")).toBe(own)
  })

  it("never writes through a symlink, which points at a file the tool did not write", () => {
    const { root, claude, put, refresh } = setup()
    const checkout = join(root, "checkout", "SKILL.md")
    put(checkout, OLD)
    mkdirSync(dirname(claude), { recursive: true })
    symlinkSync(checkout, claude)

    expect(refresh()).toBeUndefined()
    expect(readFileSync(checkout, "utf8")).toBe(OLD)
  })

  it("refreshes Hermes's own stale copy without asking Hermes", () => {
    const { hermes, put, refresh } = setup()
    put(hermes, OLD)

    expect(refresh()).toBe("Updated the chat instructions for Hermes to 2.0.0")
    expect(readFileSync(hermes, "utf8")).toContain('version: "2.0.0"')
  })

  it("tries once per version: the next run does nothing, even after the copy is old again", () => {
    const { claude, put, refresh } = setup()
    put(claude, OLD)
    refresh()
    put(claude, OLD)

    expect(refresh()).toBeUndefined()
    expect(readFileSync(claude, "utf8")).toBe(OLD)
  })

  it("turns a failure into one note, and does not try again on the next run", () => {
    const { root, claude, put } = setup()
    put(claude, OLD)
    const markerPath = join(root, "state", "skill-refresh.json")
    const broken = () =>
      refreshSkills({
        app,
        skill: pathToFileURL(join(root, "gone.md")),
        env: { HOME: join(root, "home") },
        markerPath,
      })

    expect(broken()).toMatch(/^Could not update the chat instructions for agents \(.+\); `chat skill install` does it$/)
    expect(broken()).toBeUndefined()
    expect(readFileSync(claude, "utf8")).toBe(OLD)
  })
})

describe("when the refresh runs", () => {
  const ownHome = { HOME: userInfo().homedir }

  it("runs for the owner's own folders", () => {
    expect(skipsSkillRefresh(app, ownHome)).toBe(false)
  })

  it("is off in a test, in a moved run and with CHAT_NO_SKILL_REFRESH", () => {
    expect(skipsSkillRefresh(app, { ...ownHome, VITEST: "true" })).toBe(true)
    expect(skipsSkillRefresh(app, { ...ownHome, CHAT_STATE_DIR: "/elsewhere" })).toBe(true)
    expect(skipsSkillRefresh(app, { HOME: "/tmp/elsewhere" })).toBe(true)
    expect(skipsSkillRefresh(app, { ...ownHome, CHAT_NO_SKILL_REFRESH: "1" })).toBe(true)
  })

  it("finds the SKILL.md a program installs through its skill command", () => {
    const skill = pathToFileURL(join(tmpdir(), "SKILL.md"))
    const program = createProgram({ app, commands: () => [skillCommand(app, skill)] })

    expect(skillSourceOf(program, app.appName)).toBe(skill)
    expect(skillSourceOf(createProgram({ app, commands: () => [] }), app.appName)).toBeUndefined()
  })

  it("finds it for a CLI that mounts a skill command of its own in place of the shared one", () => {
    const skill = pathToFileURL(join(tmpdir(), "own", "SKILL.md"))
    const own = { ...app, appName: "own-cli" }
    skillCommand(own, skill)
    const program = createProgram({ app: own, commands: () => [new Command("skill")] })

    expect(skillSourceOf(program, own.appName)).toBe(skill)
  })
})
