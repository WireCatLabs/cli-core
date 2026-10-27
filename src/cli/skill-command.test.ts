import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { run } from "./program.js"
import { skillCommand } from "./skill-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test CLI", version: "1.0.0" }

const show = async (argv: string[], tool: typeof app & { messenger?: boolean } = app) => {
  const file = join(mkdtempSync(join(tmpdir(), "skill-")), "SKILL.md")
  writeFileSync(file, "---\nname: chat-cli\n---\n\n# chat\n\n")
  const streams = captureStreams()
  const code = await run(
    argv,
    { app: tool, commands: () => [skillCommand(tool, pathToFileURL(file))] },
    { streams, tty: false },
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("skill show", () => {
  it("prints the file itself into a pipe, so a redirect installs it", async () => {
    const { code, stdout } = await show(["skill", "show"])

    expect(code).toBe(0)
    expect(stdout).toEqual(["---\nname: chat-cli\n---\n\n# chat"])
  })

  it("answers JSON in the one-thing envelope when asked for it by name", async () => {
    const { stdout } = await show(["skill", "show", "--json"])

    expect(JSON.parse(stdout[0] ?? "")).toEqual({
      item: { name: "chat-cli", content: "---\nname: chat-cli\n---\n\n# chat" },
      meta: expect.objectContaining({ complete: true }),
    })
  })

  it("answers --jsonl with one item line and the end line", async () => {
    const lines = (await show(["skill", "show", "--jsonl"])).stdout.map((line) => JSON.parse(line))

    expect(lines).toEqual([
      { type: "item", data: { name: "chat-cli", content: "---\nname: chat-cli\n---\n\n# chat" } },
      expect.objectContaining({ type: "end", complete: true }),
    ])
  })

  it("**a CLI that is not a messenger offers no messenger skill**", async () => {
    const tool = { ...app, messenger: false }
    for (const name of ["follow-ups", "link-conversations"]) {
      const { code, stdout } = await show(["skill", "show", name], tool)
      expect(code).not.toBe(0)
      expect(stdout).toEqual([])
    }
    expect((await show(["skill", "show"], tool)).code).toBe(0)
  })

  it("**prints the shared link-conversations skill** with this CLI's command in it", async () => {
    const { code, stdout } = await show(["skill", "show", "link-conversations"])
    const out = stdout.join("\n")

    expect(code).toBe(0)
    expect(out).toMatch(/^---\nname: link-conversations\n/)
    expect(out).toContain("chat conversations batches show")
    expect(out).not.toContain("{{command}}")
  })

  it("**prints the shared follow-ups skill**, which only drafts and never sends", async () => {
    const out = (await show(["skill", "show", "follow-ups"])).stdout.join("\n")

    expect(out).toMatch(/^---\nname: follow-ups\n/)
    expect(out).toContain("chat tasks agenda --json")
    expect(out).toContain("You draft; the owner sends.")
    expect(out).not.toContain("{{command}}")
  })

  it("has the agent send the skill's own version with every answer, so links can be told apart by prompt", async () => {
    const out = (await show(["skill", "show", "link-conversations"])).stdout.join("\n")

    expect(out).toContain(`"skill": "${/version: "(\d+)"/.exec(out)?.[1]}"`)
  })
})

describe("the skill hint", () => {
  const agent = (config?: object) => {
    const root = mkdtempSync(join(tmpdir(), "hint-"))
    const env = {
      AI_AGENT: "claude-code",
      HOME: join(root, "home"),
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
    }
    if (config) {
      mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
      writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
    }
    const skill = join(root, "SKILL.md")
    writeFileSync(skill, "---\nname: chat-cli\n---\n\n# chat\n")
    const commands = () => [new Command("probe").action(() => {}), skillCommand(app, pathToFileURL(skill))]
    const go = async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run(argv, { app, commands }, { streams, tty: false, env })
      return { code, ...streams }
    }
    return { env, go }
  }

  it("tells an agent with no copy installed, on stderr only, once a day", async () => {
    const { go } = agent()

    const first = await go(["probe", "--json"])
    expect(first.code).toBe(0)
    expect(first.stdout).toEqual([])
    expect(first.stderr).toEqual(["agents: `chat skill install` installs this tool's guide"])
    expect((await go(["probe"])).stderr).toEqual([])
  })

  it("answers skill install and skill status in the one-thing envelope", async () => {
    const { go } = agent()

    const install = JSON.parse((await go(["skill", "install", "--for", "claude", "--json"])).stdout[0] ?? "")
    const status = JSON.parse((await go(["skill", "status", "--json"])).stdout[0] ?? "")

    expect(install).toMatchObject({ item: { name: "chat-cli", version: "1.0.0" }, meta: { complete: true } })
    expect(status.item.targets[0]).toMatchObject({ target: "claude", state: "current" })
    expect(status.meta).toMatchObject({ complete: true })
  })

  it("says nothing once the skill is installed", async () => {
    const { env, go } = agent()

    expect((await go(["skill", "install", "--json"])).code).toBe(0)
    expect(existsSync(join(env.HOME, ".claude", "skills", "chat-cli", "SKILL.md"))).toBe(true)
    expect((await go(["probe"])).stderr).toEqual([])
  })

  it("says nothing when the configuration turns skillHint off", async () => {
    const { go } = agent({ defaults: { skill_hint: false } })

    expect((await go(["probe"])).stderr).toEqual([])
  })

  it("says nothing under --quiet", async () => {
    const { go } = agent()

    expect((await go(["probe", "--quiet"])).stderr).toEqual([])
  })
})
