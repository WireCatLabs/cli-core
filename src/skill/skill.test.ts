import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Command } from "commander"
import { beforeEach, describe, expect, it } from "vitest"
import { CliError } from "../errors.js"
import { createRenderer } from "../renderer.js"
import { captureStreams, fakeClock } from "../testing/index.js"
import { readUpdateState, writeUpdateState } from "../update/index.js"
import { skillCommand, skillHint, skillPath, skillResource, skillVersion, withVersion } from "./index.js"

const SKILL = "---\nname: tg-cli\ndescription: Read Telegram.\n---\n\n# tg\n\nBody.\n"
const app = { command: "tg", appName: "tg-cli", version: "1.2.0" }

let dir: string
let env: Record<string, string>
let skill: URL

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-"))
  env = { HOME: join(dir, "home") }
  writeFileSync(join(dir, "SKILL.md"), SKILL)
  skill = pathToFileURL(join(dir, "SKILL.md"))
})

const run = async (args: string[]) => {
  const streams = captureStreams()
  const json = args.includes("--json")
  const program = new Command().option("--json").exitOverride()
  program.addCommand(
    skillCommand(app, skill, () => ({
      renderer: createRenderer({ format: json ? "json" : "pretty", color: false, streams }),
      streams,
      env,
    })),
  )
  await program.parseAsync(args, { from: "user" })
  return streams
}

describe("withVersion", () => {
  it("adds metadata.version as a string and leaves every other byte alone", () => {
    expect(withVersion(SKILL, "1.2.0")).toBe(
      '---\nname: tg-cli\ndescription: Read Telegram.\nmetadata:\n  version: "1.2.0"\n---\n\n# tg\n\nBody.\n',
    )
  })

  it("replaces a version already there", () => {
    const stamped = withVersion(withVersion(SKILL, "1.0.0"), "1.2.0")
    expect(stamped).toBe(withVersion(SKILL, "1.2.0"))
    expect(skillVersion(stamped)).toBe("1.2.0")
  })

  it("keeps the other metadata and its indentation", () => {
    const own = "---\nname: tg-cli\nmetadata:\n    author: a\nlicense: MIT\n---\n# tg\n"
    expect(withVersion(own, "1.2.0")).toBe(
      '---\nname: tg-cli\nmetadata:\n    version: "1.2.0"\n    author: a\nlicense: MIT\n---\n# tg\n',
    )
  })

  it("keeps Windows line endings", () => {
    const crlf = SKILL.replaceAll("\n", "\r\n")
    expect(withVersion(crlf, "1.2.0")).toBe(withVersion(SKILL, "1.2.0").replaceAll("\n", "\r\n"))
    expect(skillVersion(withVersion(withVersion(crlf, "1.0.0"), "1.2.0"))).toBe("1.2.0")
  })

  it("gives a file with no frontmatter one", () => {
    expect(withVersion("# tg\n", "1.2.0")).toBe('---\nmetadata:\n  version: "1.2.0"\n---\n# tg\n')
    expect(skillVersion("# tg\n")).toBeUndefined()
  })

  it("refuses metadata written on one line", () => {
    expect(() => withVersion("---\nmetadata: {a: b}\n---\n", "1.2.0")).toThrow(CliError)
  })
})

describe("skillVersion", () => {
  it("still reads the top-level version a pre-release build wrote", () => {
    expect(skillVersion("---\nname: tg-cli\nversion: 1.1.0\n---\n")).toBe("1.1.0")
  })
})

describe("skill show", () => {
  it("prints SKILL.md itself on stdout, even with nobody at a terminal", async () => {
    const { stdout, stderr } = await run(["skill", "show"])
    expect(stdout).toEqual([SKILL.trimEnd()])
    expect(stderr).toEqual([])
  })

  it("answers JSON when asked for it", async () => {
    const { stdout } = await run(["--json", "skill", "show"])
    expect(JSON.parse(stdout.join(""))).toEqual({ name: "tg-cli", content: SKILL.trimEnd() })
  })
})

describe("skill install", () => {
  const claude = () => skillPath("claude", "tg-cli", env)
  const agents = () => skillPath("agents", "tg-cli", env)

  it("writes the stamped skill for both agents under HOME, and says so on stderr", async () => {
    expect(claude().startsWith(dir)).toBe(true)
    const { stdout, stderr } = await run(["--json", "skill", "install"])

    expect(JSON.parse(stdout.join(""))).toEqual({ name: "tg-cli", version: "1.2.0", written: [claude(), agents()] })
    expect(stderr).toHaveLength(1)
    expect(readFileSync(claude(), "utf8")).toBe(withVersion(SKILL, "1.2.0"))
    expect(readFileSync(agents(), "utf8")).toBe(withVersion(SKILL, "1.2.0"))
  })

  it("gives the same files when run again", async () => {
    await run(["skill", "install"])
    await run(["skill", "install"])
    expect(readFileSync(claude(), "utf8")).toBe(withVersion(SKILL, "1.2.0"))
  })

  it("refuses a SKILL.md whose name is not the directory it installs into", async () => {
    writeFileSync(join(dir, "SKILL.md"), SKILL.replace("name: tg-cli", "name: tgcli"))
    await expect(run(["skill", "install"])).rejects.toThrow(/"tgcli".*"tg-cli"/)
    expect(() => readFileSync(claude())).toThrow()
  })

  it("installs for one agent when told which", async () => {
    const { stdout } = await run(["--json", "skill", "install", "--for", "claude"])
    expect(JSON.parse(stdout.join("")).written).toEqual([claude()])
    expect(() => readFileSync(agents())).toThrow()
  })
})

describe("skillHint", () => {
  const AGENT = { CLAUDECODE: "1" }
  const clock = fakeClock(1_000_000)
  const hint = (overrides: { env?: Record<string, string>; enabled?: boolean; argv?: string[] } = {}) =>
    skillHint({
      app,
      argv: overrides.argv ?? ["chats", "list"],
      env: { ...env, ...(overrides.env ?? AGENT) },
      statePath: join(dir, "state", "update-check.json"),
      now: () => clock.now().getTime(),
      ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
    })
  const install = (version: string, target: "claude" | "agents" = "claude") => {
    const path = skillPath(target, "tg-cli", env)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, withVersion(SKILL, version))
  }

  it("tells an agent the skill is missing", () => {
    expect(hint()).toBe("agents: `tg skill install` installs this tool's guide")
    expect(hint({ env: { AI_AGENT: "claude-code_2.1_agent" } })).toBeUndefined()
  })

  it("tells an agent whose copy is older than the CLI", () => {
    install("1.2.0")
    install("1.1.9", "agents")
    expect(hint()).toBeDefined()
  })

  it("stays quiet when the installed copy is current, even in one location only", () => {
    install("1.2.0")
    expect(hint()).toBeUndefined()
  })

  it("says nothing to a person", () => {
    expect(hint({ env: {} })).toBeUndefined()
  })

  it("says it at most once a day", () => {
    expect(hint()).toBeDefined()
    clock.advance(23 * 60 * 60 * 1000)
    expect(hint()).toBeUndefined()
    clock.advance(60 * 60 * 1000)
    expect(hint()).toBeDefined()
  })

  it("says nothing when turned off, or while the skill command itself runs", () => {
    expect(hint({ enabled: false })).toBeUndefined()
    expect(hint({ argv: ["skill", "install"] })).toBeUndefined()
    expect(hint()).toBeDefined()
  })

  it("shares the update notice's file without either losing the other's answer", () => {
    const statePath = join(dir, "state", "update-check.json")
    hint()
    expect(readUpdateState(statePath)).toBeUndefined()

    writeUpdateState(statePath, { checkedAt: 5, latest: "1.3.0" })
    clock.advance(60 * 60 * 1000)
    expect(hint()).toBeUndefined()
    expect(readUpdateState(statePath)).toMatchObject({ checkedAt: 5, latest: "1.3.0" })
  })
})

describe("skillResource", () => {
  it("serves SKILL.md as <command>://skill and names the install command", () => {
    const resource = skillResource(app, skill)
    expect(resource).toMatchObject({ uri: "tg://skill", mimeType: "text/markdown" })
    expect(resource.read()).toEqual({ contents: [{ uri: "tg://skill", mimeType: "text/markdown", text: SKILL }] })
    expect(resource.instruction).toContain("`tg skill install`")
  })
})
