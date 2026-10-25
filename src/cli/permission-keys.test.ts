import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { WRITE_KEYS } from "../sends/permissions.js"
import { knownBeside, knownPermissionKeys, unknownPermissionIssues, unknownPermissionKeys } from "./permission-keys.js"

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : []
  })

const program = () => {
  const root = new Command("app")
  const messages = root.command("messages")
  messages.command("list")
  messages.command("send")
  root.command("doctor")
  root.command("odd")
  return root
}

describe("the permission keys a file may name", () => {
  it("**lists every write key the code checks**, so a new write cannot be refused as unknown", () => {
    const written = sources(join(import.meta.dirname, ".."))
      .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/\b(?:key|writes): "([a-z][a-z.-]*)"/g)])
      .map((match) => match[1] as string)
    expect(written.length).toBeGreaterThan(0)
    expect(written.filter((key) => !WRITE_KEYS.includes(key))).toEqual([])
  })

  it("knows every command, its parents and the write keys, and nothing else", () => {
    const known = knownPermissionKeys(program())
    expect([...known]).toEqual(expect.arrayContaining(["messages", "messages.list", "messages.send", "polls.vote"]))
    expect(known.has("doctor.reports")).toBe(true)
    expect(known.has("doctor.show")).toBe(false)
    expect(unknownPermissionKeys({ messages: "readonly", "messages.dlete": "allow" }, known)).toEqual([
      "messages.dlete",
    ])
  })

  it("**knows a command's full path**, and no narrower key under a command checked as another", () => {
    const root = new Command("app")
    root.command("messages").command("sync")
    root.command("bot").command("messages").command("sync")
    root.command("conversations").command("show")
    root.command("attachments").command("list")
    const known = knownPermissionKeys(root)
    expect([...known]).toEqual(expect.arrayContaining(["messages.sync", "bot.messages", "bot.messages.sync"]))
    for (const key of ["conversations.show", "attachments.list", "conversations.links.add", "bot.store.fetch"])
      expect(known.has(key)).toBe(false)
  })

  it("**checks the keys in force when an app builds its settings without the saved ones**", () => {
    const settings = {
      configPath: "/app.json",
      profile: "work",
      permissions: { "messages.dlete": "deny", "messages.sedn": "deny" } as const,
      permissionSources: { "messages.dlete": "config file", "messages.sedn": "flag" },
    }
    expect(unknownPermissionIssues(program(), settings, "app")).toEqual([
      expect.objectContaining({
        key: "permissions.messages.dlete",
        fix: "app work config unset permissions.messages.dlete",
      }),
    ])
  })

  it("takes a CLI's own key for a command `keyForCommand` does not know", () => {
    const known = knownPermissionKeys(program(), (command) => (command.name() === "odd" ? "chats.odd" : undefined))
    expect(known.has("chats.odd")).toBe(true)
  })

  it("names the known keys beside an unknown one", () => {
    const beside = knownBeside("messages.dlete", knownPermissionKeys(program()))
    expect(beside).toEqual(expect.arrayContaining(["messages.delete", "messages.list", "messages.send"]))
    expect(beside.every((key) => key.startsWith("messages.") && key.split(".").length === 2)).toBe(true)
  })
})
