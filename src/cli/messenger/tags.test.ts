import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { listEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES, tagging } from "../../entities/index.js"
import { openStore, type TagTarget, type TaskTagTarget } from "../../store/store.js"
import { seedSearchRecipes } from "../../testing/search-recipes.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { searchCommand } from "./search-command.js"
import { tagsCommand } from "./tags-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("tags never connect")
  },
  chatArgument: "a chat",
}

/** The search recipes' fixture, without their tags: chats 7, 8, 9; Alice (10) and Bob (11). */
const setup = async (config?: object) => {
  const root = mkdtempSync(join(tmpdir(), "tags-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await seedSearchRecipes(store, { provider: "chat", account: "500" })
  for (const one of await store.tags.tags({ provider: "chat", account: "500" })) {
    const target: TagTarget | TaskTagTarget =
      one.type === "chat"
        ? { type: one.type, chatId: one.chatId as string }
        : one.type === "contact"
          ? { type: one.type, personId: one.personId as string }
          : one.type === "task"
            ? { type: one.type, taskId: one.taskId as string }
            : { type: one.type, chatId: one.chatId as string, messageId: one.messageId as string }
    await store.tags.removeTags({ provider: "chat", account: "500" }, target, [one.tag])
  }
  await store.close()
  const runs =
    (tty: boolean) =>
    async (...argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        argv,
        {
          app,
          commands: () => [
            tagsCommand(messenger),
            messagesCommand(messenger),
            searchCommand(messenger),
            storeCommand(messenger),
          ],
        },
        { streams, tty, env: { ...env, NO_COLOR: "1" } },
      )
      if (code === 0 && argv[0] === "tags" && argv.includes("--json") && ["add", "remove"].includes(argv[1] ?? "")) {
        v.parse(ENTITIES.tag_change, JSON.parse(streams.stdout.join("")).item)
      }
      return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
    }
  return Object.assign(runs(false), { pretty: runs(true), root })
}

const json = (result: { stdout: string[] }) => JSON.parse(result.stdout[0] ?? "null")

it("declares automatic tag previews and applied receipts, including failed chats", async () => {
  const chat = await setup()
  const preview = await chat("tags", "auto", "--chat", "7", "--chat", "missing", "--dry-run", "--json")
  expect(preview.code, preview.stderr).toBe(0)
  const body = JSON.parse(preview.stdout.join(""))
  const parsed = v.parse(ENTITIES.automatic_tags, body.item)
  expect(parsed.dry_run).toBe(true)
  expect(parsed.items).toHaveLength(2)
  expect(parsed.items[1]).toMatchObject({ chat_id: "missing", error: { code: "not_found" } })
  const applied = await chat("tags", "auto", "--chat", "7", "--json")
  expect(applied.code, applied.stderr).toBe(0)
  expect(v.parse(ENTITIES.automatic_tags, JSON.parse(applied.stdout.join("")).item).dry_run).toBe(false)
  const projected = await chat("tags", "add", "reading", "--chat", "7", "--json=target.chat_id,added")
  expect(projected.code, projected.stderr).toBe(0)
  expect(JSON.parse(projected.stdout.join("")).item).toEqual({ target: { chat_id: "7" }, added: ["reading"] })
})

describe("tags", () => {
  it("**tags a chat, a person and a message, and tag: finds what they label**", async () => {
    const call = await setup()
    expect(json(await call("tags", "add", "Work", "--chat", "Private fixture", "--json")).item).toEqual({
      target: { type: "chat", chat_id: "9" },
      added: ["work"],
      unchanged: [],
    })
    expect(json(await call("tags", "add", "work", "vip", "--contact", "Bob Synthetic", "--json")).item).toMatchObject({
      target: { type: "contact", person_id: "11" },
      added: ["work", "vip"],
    })
    expect(json(await call("tags", "add", "--message", "msg:chat/500/7/101", "work", "--json")).item).toMatchObject({
      target: { type: "message", chat_id: "7", message_id: "101", locator: "msg:chat/500/7/101" },
    })
    expect(json(await call("tags", "add", "work", "--chat", "7", "--message", "102", "--json")).item.target).toEqual({
      type: "message",
      chat_id: "7",
      message_id: "102",
      locator: "msg:chat/500/7/102",
    })
    expect(json(await call("tags", "add", "work", "--chat", "9", "--json")).item).toMatchObject({
      added: [],
      unchanged: ["work"],
    })

    const listed = v.parse(listEnvelopeSchema(tagging), json(await call("tags", "list", "tag:work", "--json")))
    expect(listed.page).toEqual({ mode: "page", limit: 20, has_more: false })
    expect(listed.items.map(({ type }: { type: string }) => type)).toEqual(["chat", "contact", "message", "message"])
    expect(json(await call("tags", "list", "type:contact", "--json")).items).toHaveLength(2)
    expect(json(await call("tags", "list", "tag:work sources:auto", "--json")).items).toEqual([])
    expect(json(await call("tags", "list", "tag:work", "-type:message", "--json")).items).toHaveLength(2)
    expect((await call("tags", "list", "--limt", "2", "--json")).code).toBe(2)

    const search = json(await call("search", "messages", "tag:work", "--json"))
    expect(search.items.map(({ ref }: { ref: string }) => ref.split("/").at(-1)).sort()).toEqual([
      "101",
      "102",
      "103",
      "106",
      "107",
      "108",
    ])

    expect(
      json(await call("tags", "remove", "vip", "gone", "--contact", "11", "--claim", "manual", "--json")).item,
    ).toMatchObject({
      removed: ["vip"],
      unchanged: ["gone"],
    })
    expect(json(await call("tags", "list", "tag:vip", "--json")).items).toEqual([])
  })

  it("**a backup keeps the tags**: restored, they list and match again", async () => {
    const call = await setup()
    await call("tags", "add", "work", "--chat", "7", "--json")
    const file = join(call.root, "backup.db")
    expect((await call("store", "backup", file, "--json")).code).toBe(0)
    await call("tags", "remove", "work", "--chat", "7", "--json")
    expect((await call("store", "restore", file, "--json")).code).toBe(0)
    expect(json(await call("tags", "list", "--json")).items).toMatchObject([{ tag: "work", target: "chat:chat/500/7" }])
    expect(json(await call("search", "messages", "tag:work", "--json")).items.length).toBeGreaterThan(0)
  })

  it("prints for a person, and says so when nothing is tagged", async () => {
    const call = (await setup()).pretty
    const empty = await call("tags", "list")
    expect([empty.code, empty.stdout.join("")]).toEqual([0, ""])
    expect(empty.stderr).toContain("nothing is tagged")
    const added = await call("tags", "add", "work", "--chat", "7")
    expect(added.stdout.join("")).toContain("chat 7: work")
    expect((await call("tags", "add", "work", "--chat", "7")).stderr).toContain("already there: work")
    expect((await call("tags", "list")).stdout.join("")).toContain("work  chat  Work fixture (chat:chat/500/7)")
    expect((await call("tags", "remove", "work", "--chat", "7")).stdout.join("")).toContain("work removed")
  })

  it.each([
    [["tags", "add", "work"], "name one thing"],
    [["tags", "add", "work", "--chat", "7", "--contact", "11"], "name one thing"],
    [["tags", "add", "work", "--message", "101"], "name one thing"],
    [["tags", "add", "two words", "--chat", "7"], "is not a tag"],
    [["tags", "add", "work", "--chat", "7", "--message", "msg:chat/500/7/101"], "a locator already names the chat"],
    [["tags", "add", "work", "--message", "msg:chat/999/7/101"], "another account"],
    [["tags", "list", "type:folder"], "type takes chat, contact, message"],
  ])("refuses %j with a validation error and an empty stdout", async (argv, message) => {
    const call = await setup()
    const result = await call(...argv, "--json")
    expect([result.code, result.stdout]).toEqual([2, []])
    expect(result.stderr).toContain(message)
  })

  it("answers not_found for what the store does not hold", async () => {
    const call = await setup()
    const result = await call("tags", "add", "work", "--chat", "7", "--message", "404", "--json")
    expect([result.code, result.stdout]).toEqual([6, []])
    expect((await call("tags", "add", "work", "--contact", "Nobody", "--json")).code).toBe(6)
  })

  it("**writes nothing where tags are read-only**, and still lists", async () => {
    const call = await setup({ profiles: { default: { permissions: { tags: "readonly" } } } })
    const refused = await call("tags", "add", "work", "--chat", "7", "--json")
    expect([refused.code, refused.stdout]).toEqual([5, []])
    expect(refused.stderr).toContain("permissions.tags.add allow")
    expect((await call("tags", "list", "--json")).code).toBe(0)
    const asked = await (await setup({ profiles: { default: { permissions: { "tags.remove": "ask" } } } }))(
      "tags",
      "remove",
      "work",
      "--chat",
      "7",
      "--json",
    )
    expect(asked.code).toBe(7)
  })
})
