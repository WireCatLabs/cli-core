import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import type { Predicate } from "@wirecat/cli-base/query"
import { afterEach, describe, expect, it } from "vitest"
import { rememberAccount } from "../cli/messenger/accounts.js"
import { contactsCommand } from "../cli/messenger/contacts-command.js"
import type { Messenger } from "../cli/messenger/context.js"
import { metadataCommand } from "../cli/messenger/metadata-command.js"
import { stored } from "../cli/messenger/stored.js"
import { tagsCommand } from "../cli/messenger/tags-command.js"
import { run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { classifyChannel } from "../domain/channel-tags.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { pickPerson } from "../resolve.js"
import { type MessageStore, openStore } from "../store/store.js"
import { seedSearchRecipes } from "../testing/search-recipes.js"
import { storedDeps } from "./deps.js"
import { servicesFor } from "./index.js"
import { searchStore } from "./messages-archive-search.js"

const nameTerm = (value: string) =>
  ({ kind: "predicate", field: "name", operator: "term", value, span: [0, 0] }) as unknown as Predicate

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  chatArgument: "a chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("local metadata must never connect")
  },
}
const key = { provider: "chat", account: "500" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "private-people-"))
  const path = join(root, "messages.db")
  const store = await openStore({ path })
  opened.push(store)
  await seedSearchRecipes(store, key)
  await store.chats.saveChats(key, [
    { id: "10", title: "Alice Synthetic", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.roster.saveMembers(key, "10", ["10", "500"])
  const deps = storedDeps(messenger, store, key, { check: () => {}, record: () => {} })
  const services = servicesFor(deps)
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: path,
  }
  rememberAccount(app, "default", key.account, env)
  const call = async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      { app, commands: () => [contactsCommand(messenger), metadataCommand(messenger), tagsCommand(messenger)] },
      { streams, tty: false, env },
    )
    return { code, result: JSON.parse(streams.stdout.join("") || "null"), stderr: streams.stderr.join("") }
  }
  return { root, path, store, services, call, deps }
}

describe("private people metadata", () => {
  it("keeps aliases to an account, notes to the owner, and both separate from remote names", async () => {
    const f = await setup()
    const other = { ...key, account: "501" }
    await f.store.people.savePeople(other, [{ id: "10", name: "Alice Synthetic" }])
    await f.services.privatePeople.alias("10", "Local label")
    const first = await f.services.privatePeople.add("Local label", "Own assessment")
    const second = await f.services.privatePeople.add("10", "Follow up Tuesday")
    expect(first.id).not.toBe(second.id)
    expect(await f.store.people.privateContact(other, "10")).toMatchObject({
      personId: "10",
      alias: null,
      notes: [{ id: first.id }, { id: second.id }],
    })
    expect(await f.services.people.show("Local label", { notes: true })).toMatchObject({
      id: "10",
      name: "Alice Synthetic",
      alias: "Local label",
      notes: [{ text: "Own assessment" }, { text: "Follow up Tuesday" }],
    })
    await f.store.people.savePeople(key, [{ id: "10", name: "Refreshed name" }])
    expect(await f.services.privatePeople.notes("10")).toHaveLength(2)
    expect((await f.services.people.show("10")).name).toBe("Refreshed name")
    await expect(f.store.people.privateContact({ provider: "max", account: "500" }, "10")).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("resolves aliases without guessing duplicates and supports Unicode contact search", async () => {
    const f = await setup()
    await f.services.privatePeople.alias("10", "ЛИЧНЫЙ ПСЕВДОНИМ")
    expect(
      (await f.services.people.list({ order: "name", name: nameTerm("личный"), offset: 0 })).items.map(
        (person) => person.id,
      ),
    ).toEqual(["10"])
    await f.services.privatePeople.alias("11", "ЛИЧНЫЙ ПСЕВДОНИМ")
    const lookup = await f.store.people.people(key.provider, { account: key.account })
    expect(() => pickPerson("личный псевдоним", lookup)).toThrow("matches 2 people")
    expect(pickPerson("10", lookup).id).toBe("10")
    await f.services.privatePeople.alias("10", null)
    expect((await f.store.people.people(key.provider, { account: key.account })).get("10")?.alias).toBeUndefined()
    await expect(f.services.privatePeople.alias("11", " ")).rejects.toMatchObject({ code: "validation_error" })
  })

  it("guards stale edits and removes note text", async () => {
    const f = await setup()
    const note = await f.services.privatePeople.add("10", "Initial assessment")
    const changed = await f.services.privatePeople.edit("10", note.id, "New assessment", 1)
    expect(changed.revision).toBe(2)
    await expect(f.services.privatePeople.edit("10", note.id, "Stale edit", 1)).rejects.toThrow("note changed")
    await expect(f.services.privatePeople.note("11", note.id)).rejects.toMatchObject({ code: "not_found" })
    await f.services.privatePeople.remove("10", note.id)
    await expect(f.services.privatePeople.note("10", note.id)).rejects.toMatchObject({ code: "not_found" })
    await expect(f.services.privatePeople.add("10", " ")).rejects.toMatchObject({ code: "validation_error" })
  })

  it("resolves a local alias to the stored direct-chat id and preserves remote resolution before login", async () => {
    const f = await setup()
    const remote: string[] = []
    const adapter = {
      resolve: async (reference: string) => {
        if (reference === "Local alias") throw new CliError("not_found", "no remote chat named by this local alias")
        remote.push(reference)
        return {
          id: reference,
          title: null,
          kind: "dialog",
          unreadCount: null,
          lastMessageAt: null,
          participantsCount: null,
        }
      },
    } as unknown as MessengerAdapter
    await f.services.privatePeople.alias("10", "Local alias")
    const wrapped = stored(adapter, { account: key, store: async () => f.store, warn: () => {}, events: () => {} })
    expect((await wrapped.resolve("Local alias")).id).toBe("10")
    const unknown = {
      provider: "chat",
      get account(): string {
        throw new Error("account not known before login")
      },
    }
    const early = stored(adapter, { account: unknown, store: async () => f.store, warn: () => {}, events: () => {} })
    expect((await early.resolve("Remote name")).id).toBe("Remote name")
    expect(remote).toEqual(["10", "Remote name"])
    const collision = stored(
      {
        ...adapter,
        resolve: async () => ({
          id: "other-group",
          title: "Local alias",
          kind: "group",
          unreadCount: 0,
          lastMessageAt: null,
          participantsCount: null,
        }),
      } as MessengerAdapter,
      {
        account: key,
        store: async () => f.store,
        warn: () => {},
        events: () => {},
      },
    )
    await expect(collision.resolve("Local alias")).rejects.toMatchObject({
      code: "validation_error",
      details: { candidates: [{ id: "10" }, { id: "other-group" }] },
    })
  })

  it("retains private identity scopes across linking and store reopening", async () => {
    const f = await setup()
    await f.store.people.savePeople({ provider: "max", account: "500" }, [{ id: "10", name: "Other provider" }])
    await f.services.privatePeople.alias("10", "Private alias")
    await f.services.privatePeople.add("10", "Retained own note")
    await f.store.people.linkIdentities(
      { provider: "chat", id: "10" },
      { provider: "max", id: "10" },
      { method: "manual", by: "owner" },
    )
    expect((await f.store.people.privateContact({ provider: "max", account: "500" }, "10")).notes).toEqual([])
    await f.store.people.unlinkIdentity({ provider: "max", id: "10" }, { method: "manual", by: "owner" })
    const reopened = await openStore({ path: f.path })
    opened.push(reopened)
    expect(await reopened.people.privateContact(key, "10")).toMatchObject({
      alias: "Private alias",
      notes: [{ text: "Retained own note" }],
    })
  })

  it("offers offline CLI CRUD, blocks local writes by profile and never transmits notes", async () => {
    const f = await setup()
    expect((await f.call("--offline", "contacts", "aliases", "set", "10", "Local", "--json")).code).toBe(0)
    const file = join(f.root, "own-note.txt")
    writeFileSync(file, "Own confidential fixture")
    const added = await f.call("--offline", "contacts", "notes", "add", "Local", "--text-file", file, "--json")
    expect(added.code).toBe(0)
    const id = added.result.item.id
    expect(added.result.item.contact).toMatch(/^contact:/)
    expect((await f.call("contacts", "notes", "list", "10", "--json")).result.items).toHaveLength(1)
    expect((await f.call("contacts", "notes", "show", "10", id, "--json")).result.item.text).toBe(
      "Own confidential fixture",
    )
    expect(
      (await f.call("contacts", "notes", "edit", "10", id, "--revision", "1", "--text-file", file, "--json")).result
        .item.revision,
    ).toBe(2)
    const both = await f.call("contacts", "notes", "add", "10", "--text-file", file, "--file", file, "--json")
    expect(both.code).toBe(2)
    expect((await f.call("contacts", "notes", "list", "10", "--json")).result.items).toHaveLength(1)
    expect((await f.call("contacts", "notes", "remove", "10", id, "--json")).result.item.removed).toBe(true)
    expect((await f.call("contacts", "aliases", "remove", "10", "--json")).result.item.alias).toBeNull()
    expect(
      (await f.call("--permission", "contacts=readonly", "contacts", "aliases", "set", "10", "Blocked", "--json")).code,
    ).not.toBe(0)
  })
})

describe("cached metadata and automatic tags", () => {
  it("classifies actual metadata fields with deterministic scores", () => {
    expect(classifyChannel({ title: "AI news", username: "work", description: "Новости о нейросетях" })).toEqual([
      { tag: "ai", score: 2 / 3, fields: ["title", "description"] },
      { tag: "news", score: 2 / 3, fields: ["title", "description"] },
    ])
    expect(classifyChannel({ title: null, username: null, description: null })).toEqual([])
  })

  it("preserves manual tags when auto tags overlap, disappear or are promoted to manual", async () => {
    const f = await setup()
    await f.store.chats.saveChatMetadata(key, { chatId: "7", title: "AI news", username: null, description: null })
    await f.store.tags.addTags(key, { type: "chat", chatId: "7" }, ["news", "personal"])
    await f.services.metadata.auto({ chats: ["7"] })
    expect((await f.store.tags.tags(key)).filter((one) => one.chatId === "7").map((one) => one.tag)).toEqual(
      expect.arrayContaining(["ai", "news", "personal"]),
    )
    expect(
      (await f.store.tags.tags(key, { tag: "news", source: "auto" })).find((entry) => entry.chatId === "7")?.sources,
    ).toEqual(["manual", "auto"])
    await f.store.tags.removeTags(key, { type: "chat", chatId: "7" }, ["news"], "auto")
    expect((await f.store.tags.tags(key, { tag: "news" })).find((entry) => entry.chatId === "7")).toBeDefined()
    await f.store.tags.removeTags(key, { type: "chat", chatId: "7" }, ["personal"], "manual")
    expect((await f.store.tags.tags(key, { tag: "personal" })).find((entry) => entry.chatId === "7")).toBeUndefined()
    await f.store.tags.addTags(key, { type: "chat", chatId: "7" }, ["personal"])
    expect((await searchStore(f.store, key, { text: "tag:ai", limit: 100 })).items.map((hit) => hit.id).sort()).toEqual(
      ["101", "102", "105", "106", "107", "109"],
    )
    await f.store.tags.addTags(key, { type: "chat", chatId: "7" }, ["ai"])
    await f.store.chats.saveChatMetadata(key, {
      chatId: "7",
      title: "No known topic",
      username: null,
      description: null,
    })
    await f.services.metadata.auto({ chats: ["7"] })
    expect((await f.store.tags.tags(key)).filter((one) => one.chatId === "7").map((one) => one.tag)).toEqual(
      expect.arrayContaining(["ai", "news", "personal"]),
    )
    await f.store.tags.removeTags(key, { type: "chat", chatId: "7" }, ["ai"])
    expect((await f.store.tags.tags(key)).some((one) => one.chatId === "7" && one.tag === "ai")).toBe(false)
  })

  it("refreshes supported metadata through a read capability and retains the snapshot after provider failure", async () => {
    const f = await setup()
    let fail = false
    const adapter = {
      group: async (chatId: string) => {
        if (fail) throw new CliError("provider_error", "synthetic read failure")
        return {
          id: chatId,
          title: "Crypto news",
          kind: "channel",
          description: "Public synthetic description",
          providerMetadata: { username: "fixture" },
        }
      },
    } as unknown as MessengerAdapter
    const services = servicesFor({ ...f.deps, offline: false, connection: async () => adapter })
    expect(await services.metadata.refresh("7")).toMatchObject({
      title: "Crypto news",
      description: "Public synthetic description",
      username: "fixture",
    })
    const before = await f.store.chats.chatMetadata(key, "7")
    fail = true
    expect((await services.metadata.auto({ chats: ["7"], refresh: true })).items[0]).toHaveProperty("error")
    expect(await f.store.chats.chatMetadata(key, "7")).toEqual(before)
  })

  it("**refreshes only chats with no metadata yet**: every stored group and channel, or the ones named", async () => {
    const f = await setup()
    const channel = { kind: "channel" as const, unreadCount: 0, lastMessageAt: null, participantsCount: 9 }
    await f.store.chats.saveChats(key, [
      { ...channel, id: "30", title: "Bare" },
      { ...channel, id: "31", title: "Described" },
    ])
    await f.store.chats.saveChatMetadata(key, { chatId: "31", title: "Described", username: null, description: "x" })

    const all = await f.services.metadata.missing()
    expect(all).toContain("30")
    expect(all).not.toContain("31")
    expect(all).not.toContain("10")
    expect(await f.services.metadata.missing(["31", "30"])).toEqual(["30"])

    const named = await f.call(
      "--offline",
      "metadata",
      "sync",
      "--chat",
      "31",
      "--chat",
      "30",
      "--only-missing",
      "--json",
    )
    expect(named.result.item.chats.map((item: { chat_id: string }) => item.chat_id)).toEqual(["30"])
    const every = await f.call("--offline", "metadata", "sync", "--only-missing", "--limit", "1", "--json")
    expect(every.result.item).toMatchObject({
      chats: [{ error: { code: "validation_error" } }],
      has_more: all.length > 1,
    })
    const neither = await f.call("metadata", "sync", "--json")
    expect(neither.stderr).toContain("--only-missing")
  })

  it("bounds work, separates account metadata and keeps dry-run and failed refresh unchanged", async () => {
    const f = await setup()
    expect((await f.services.metadata.get("7")).metadata).toBeNull()
    await f.store.chats.saveChatMetadata(key, { chatId: "7", title: "Crypto news", username: null, description: null })
    const before = await f.store.tags.tags(key)
    expect(await f.services.metadata.auto({ chats: ["7", "8"], limit: 1, dryRun: true })).toMatchObject({
      hasMore: true,
      dryRun: true,
    })
    expect(await f.store.tags.tags(key)).toEqual(before)
    const failed = await f.services.metadata.auto({ chats: ["7"], refresh: true })
    expect(failed.items[0]).toHaveProperty("error")
    expect((await f.services.metadata.get("7")).metadata?.title).toBe("Crypto news")
    await expect(f.services.metadata.auto({ limit: 501 })).rejects.toMatchObject({ code: "validation_error" })
    await expect(f.services.metadata.auto({ dryRun: true, refresh: true })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect((await f.call("metadata", "show", "--chat", "7", "--json")).result.item.metadata.title).toBe("Crypto news")
    expect(
      (await f.call("--offline", "metadata", "sync", "--chat", "7", "--limit", "1", "--json")).result.item.chats[0],
    ).toHaveProperty("error")
    expect((await f.call("metadata", "sync", "--chat", "7", "--limit", "501", "--json")).code).not.toBe(0)
    const preview = await f.call("tags", "rebuild", "--chat", "7", "--dry-run", "--json")
    expect(preview, preview.stderr).toMatchObject({ code: 0, result: { item: { dry_run: true } } })
  })
})
