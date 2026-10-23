import { describe, expect, it } from "vitest"
import {
  assertStatsPermissionsCurrent,
  keyForCommand,
  layerPermissions,
  levelFor,
  permissionOverrides,
  readKeysForCommand,
} from "./permissions.js"

describe("the level of a command path", () => {
  it("checks the canonical statistics path and underlying data resources", () => {
    expect(keyForCommand(["stats", "messages", "show"])).toBe("stats.messages.show")
    expect(readKeysForCommand(["stats", "messages", "show"])).toEqual(["stats.messages.show", "messages"])
    expect(readKeysForCommand(["stats", "chats", "show"])).toEqual(["stats.chats.show", "messages", "chats"])
    expect(readKeysForCommand(["bot", "stats", "messages", "show"])).toEqual([
      "bot.stats.messages.show",
      "bot.messages",
    ])
  })
  it("**takes the most specific key the owner set**, and allows a path nothing names", () => {
    const levels = { messages: "readonly", "messages.send": "allow" } as const

    expect(levelFor(levels, "messages.send").level).toBe("allow")
    expect(levelFor(levels, "messages.edit")).toEqual({ level: "readonly", key: "messages" })
    expect(levelFor(levels, "contacts.add")).toEqual({ level: "allow", key: null })
  })

  it("**leaves help and scenarios to every level**: `help options` and `guide` read no account", () => {
    expect(keyForCommand(["help"])).toBeNull()
    expect(keyForCommand(["guide"])).toBeNull()
  })

  it("**lets a built-in default only tighten** a broader key of the owner's", () => {
    expect(levelFor({ messages: "readonly" }, "messages.delete").level).toBe("readonly")
    expect(levelFor({ messages: "allow" }, "messages.delete").level).toBe("ask")
    expect(levelFor({ "messages.delete": "allow" }, "messages.delete").level).toBe("allow")
  })
})

describe("a bot's permissions", () => {
  it("**keys every bot command under `bot`**, apart from its housekeeping", () => {
    expect(keyForCommand(["flood", "clear"])).toBeNull()
    expect(keyForCommand(["schedule", "agent"])).toBeNull()
    expect(keyForCommand(["contacts", "context"])).toBe("messages")
    expect(keyForCommand(["contacts", "prepare"])).toBe("messages")
    expect(keyForCommand(["bot", "messages", "send"])).toBe("bot.messages.send")
    expect(keyForCommand(["bot", "chats", "members", "remove"])).toBe("bot.chats.members.remove")
    expect(keyForCommand(["bot", "watch"])).toBe("bot.messages")
    expect(keyForCommand(["bot", "commands", "set"])).toBe("bot.commands.set")
    expect(keyForCommand(["bot", "api", "send-message"])).toBe("bot.api.send-message")
    expect(keyForCommand(["bot", "auth", "set"])).toBeNull()
    expect(keyForCommand(["bot", "recipients", "add"])).toBeNull()
  })

  it("**asks before a bot deletes**, as the personal account does", () => {
    expect(levelFor({}, "bot.messages.delete").level).toBe("ask")
  })
})

describe("startup permission overrides", () => {
  it("overrides saved descendants as a nearer layer, without changing the saved map", () => {
    const saved = { "messages.send": "deny", "messages.delete": "deny" } as const
    const { levels } = layerPermissions([
      ["flag", permissionOverrides(["messages=allow", "messages.send=ask"])],
      ["file", saved],
    ])
    expect(levelFor(levels, "messages.send").level).toBe("ask")
    expect(levelFor(levels, "messages.delete").level).toBe("ask")
    expect(saved["messages.send"]).toBe("deny")
    expect(levelFor(permissionOverrides(["messages.delete=allow"]), "messages.delete").level).toBe("allow")
  })
  it.each(["send=allow", "messages.send=yes", "messages.send=allow=deny", "messages.*=allow", "=allow"])(
    "rejects %s",
    (entry) => {
      expect(() => permissionOverrides([entry])).toThrow("--permission")
    },
  )
  it("takes the last override for a repeated key", () => {
    expect(permissionOverrides(["messages.send=deny", "messages.send=allow"])).toEqual({ "messages.send": "allow" })
  })
})

it("refuses old statistics permission keys and names the paths that replace them", () => {
  expect(() => assertStatsPermissionsCurrent(["stats", "messages", "show"], { "messages.stats": "deny" })).toThrow(
    "stats.messages.show",
  )
  expect(() => assertStatsPermissionsCurrent(["stats", "tasks", "show"], { "tasks.stats": "readonly" })).toThrow(
    "stats.tasks.show",
  )
  expect(() => assertStatsPermissionsCurrent(["messages", "list"], { "messages.stats": "deny" })).not.toThrow()
})
