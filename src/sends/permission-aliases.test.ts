import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { knownPermissionKeys } from "../cli/permission-keys.js"
import { canonicalPermissionKey, canonicalPermissions } from "./permission-aliases.js"
import { assertOverridesTighten, layerPermissions, levelFor, permissionOverrides } from "./permissions.js"

const pairs = [
  ["contacts.alias.rm", "contacts.aliases.remove"],
  ["contacts.profile", "contacts.info"],
  ["chats.link.revoke", "chats.links.remove"],
  ["chats.requests.accept", "chats.requests.confirm"],
  ["metadata.refresh", "metadata.sync"],
  ["attachments.text", "attachments.update"],
  ["tasks.plan", "tasks.update"],
  ["conversations.build", "conversations.links.rebuild"],
  ["conversations.embed", "conversations.embeddings"],
] as const

describe("permission keys after canonical command renames", () => {
  it.each(pairs)("refuses the moved saved path %s with its replacement", (old, current) => {
    expect(canonicalPermissionKey(old)).toBe(current)
    for (const level of ["deny", "readonly", "ask", "allow"] as const) {
      expect(() => levelFor({ [old]: level }, current)).toThrow(`rename permissions.${old} to permissions.${current}`)
      expect(() => levelFor({ [`bot.${old}`]: level }, `bot.${current}`)).toThrow(
        `rename permissions.bot.${old} to permissions.bot.${current}`,
      )
      expect(levelFor({ [current]: level }, old).level).toBe(level)
    }
  })

  it("maps whole path segments and preserves child scopes", () => {
    expect(canonicalPermissionKey("contacts.alias.set")).toBe("contacts.aliases.set")
    expect(canonicalPermissionKey("contacts.aliases.rm")).toBe("contacts.aliases.remove")
    expect(canonicalPermissionKey("chats.linkage")).toBe("chats.linkage")
  })

  it("refuses a moved path before a nearer layer can hide its declaration", () => {
    expect(() =>
      layerPermissions([
        ["profile", { "contacts.aliases": "readonly" }],
        ["defaults", { "contacts.alias.set": "allow" }],
      ]),
    ).toThrow(/rename permissions.contacts.alias.set to permissions.contacts.aliases.set/)
  })

  it("refuses either declaration order, including equal levels", () => {
    for (const levels of [
      { "metadata.refresh": "deny", "metadata.sync": "allow" },
      { "metadata.sync": "allow", "metadata.refresh": "deny" },
      { "metadata.refresh": "deny", "metadata.sync": "deny" },
    ] as const)
      expect(() => canonicalPermissions(levels)).toThrow(
        /rename permissions.metadata.refresh to permissions.metadata.sync/,
      )
  })

  it("a startup override cannot lift a saved level by using the other spelling", () => {
    expect(() =>
      assertOverridesTighten(permissionOverrides(["contacts.alias.set=allow"]), { "contacts.aliases": "deny" }),
    ).toThrow()
    expect(() =>
      assertOverridesTighten(permissionOverrides(["metadata.sync=allow"]), { "metadata.refresh": "readonly" }),
    ).toThrow()
  })

  it("recognizes the canonical key even when a consumer selects a legacy-named shared command", () => {
    const program = new Command("fixture").addCommand(
      new Command("contacts").addCommand(new Command("alias").addCommand(new Command("set"))),
    )
    expect(knownPermissionKeys(program).has("contacts.aliases.set")).toBe(true)
  })
})
