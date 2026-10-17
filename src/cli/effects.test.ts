import { captureStreams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { keyForCommand, WRITE_KEYS } from "../sends/permissions.js"
import { sharedProgram } from "../testing/shared-program.js"
import { changesAuthority, judgedEffects, judgedTargets, refuseUnderReadOnly } from "./effects.js"
import { createProgram, run } from "./program.js"

const program = createProgram(sharedProgram)

const runnable = (root: Command): { path: string; command: Command }[] => {
  const found: { path: string; command: Command }[] = []
  const visit = (command: Command, parents: string[]) => {
    const path = [...parents, command.name()]
    if ((command as unknown as { _actionHandler?: unknown })._actionHandler)
      found.push({ path: path.join(" "), command })
    for (const child of command.commands) visit(child, path)
  }
  for (const child of root.commands) visit(child, [])
  return found
}

describe("command effects", () => {
  const commands = runnable(program)

  it("are declared by every command that runs, reads included", () => {
    expect(commands.length).toBeGreaterThan(150)
    expect(commands.filter(({ command }) => !metaOf(command).effects).map(({ path }) => path)).toEqual([])
  })

  it("write somewhere wherever the profile's permissions call the command a write", () => {
    const wrong = commands.filter(({ path, command }) => {
      const key = keyForCommand(path.split(" "))
      const effects = metaOf(command).effects
      return key && WRITE_KEYS.includes(key) && effects && !writes(effects)
    })
    // Reads behind a key a profile must allow: the session list is private, and `conversations embed status`
    // shares the whole `conversations.embed` group's key (FIND-1262).
    expect(wrong.map(({ path }) => path)).toEqual(["account sessions list", "conversations embed status"])
  })

  it("mark the local writes the read-only lock refuses: what changes a later run's authority, and no read", () => {
    const marked = commands.filter(({ command }) => changesAuthority(command))
    expect(marked.filter(({ command }) => metaOf(command).effects?.local !== "write")).toEqual([])
    expect(marked.map(({ path }) => path).sort()).toEqual(
      [
        "bot auth remove",
        "bot auth set",
        "bot chats rules set",
        "bot chats rules unset",
        "bot recipients add",
        "bot recipients clear",
        "bot recipients remove",
        "chats rules set",
        "chats rules unset",
        "config set",
        "config unset",
        "flood clear",
        "mcp setup",
        "models text key remove",
        "models text key set",
        "recipients add",
        "recipients clear",
        "recipients remove",
        "replies add",
        "replies audience",
        "replies consents allow",
        "replies consents deny",
        "replies consents grant",
        "replies consents revoke",
        "replies edit",
        "replies off",
        "replies on",
        "replies pause",
        "replies resume",
        "schedule agent",
        "schedule command",
        "schedule remove",
        "server install",
        "server uninstall",
        "skill install",
      ].sort(),
    )
  })

  it("judge retry on the remote side, and keep a local-only write from running unasked", () => {
    expect(judgedEffects({ remote: "read", local: "write" })).toEqual({ remote: "read", local: "none" })
    expect(judgedEffects(undefined)).toBeUndefined()
    const targets = judgedTargets(program)
    expect(targets("messages sync")?.effects).toEqual({ remote: "read", local: "none" })
    expect(targets("messages send")?.effects).toEqual({ remote: "write", local: "none" })
    expect(targets("server restart")?.effects).toEqual({ remote: "none", local: "write" })
  })
})

describe("refuseUnderReadOnly", () => {
  const unlink = async (env: NodeJS.ProcessEnv) => {
    let ended = false
    const streams = captureStreams()
    const code = await run(
      ["session", "end"],
      {
        app: sharedProgram.app,
        commands: () => [
          new Command("session").addCommand(
            new Command("end").action(function (this: Command) {
              refuseUnderReadOnly(this, "unlink the device")
              ended = true
            }),
          ),
        ],
      },
      { streams, tty: false, env },
    )
    return { code, ended, stderr: streams.stderr.join("") }
  }

  it("stops a write the send guard never sees, before it runs, under the app's lock", async () => {
    const locked = await unlink({ CHAT_READ_ONLY: "1" })

    expect(locked.ended).toBe(false)
    expect(locked.code).toBe(5)
    expect(JSON.parse(locked.stderr).error).toMatchObject({
      code: "permission_error",
      message: "this process is read-only (CHAT_READ_ONLY) — it cannot unlink the device",
    })
  })

  it("lets it run without the lock, or with the lock set to 0", async () => {
    expect((await unlink({})).ended).toBe(true)
    expect((await unlink({ CHAT_READ_ONLY: "0" })).ended).toBe(true)
  })

  it("refuses to guess whose lock it is outside run()", () => {
    expect(() => refuseUnderReadOnly(new Command("end"), "unlink the device")).toThrow(/inside run\(\)/)
  })
})
