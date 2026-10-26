import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { listEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { DEFAULT_TASK_CATEGORIES, withTaskCategory } from "../../domain/task-categories.js"
import { ENTITIES, task, taskPair } from "../../entities/index.js"

import { openCache } from "../../store/open.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"
import { statsCommand } from "./stats-command.js"
import { tagsCommand } from "./tags-command.js"
import { tasksCommand } from "./tasks-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("tasks never connect")
  },
  chatArgument: "a chat",
}
const account = { provider: "chat", account: "500" }

const said = (id: string, text: string): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Ana",
  timestamp: `2026-10-06T10:0${id.slice(-1)}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const setup = async (config?: object) => {
  const root = mkdtempSync(join(tmpdir(), "tasks-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.chats.saveChats(account, [
    { id: "7", title: "Ana", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "7",
    [said("1", "I'll send the invoice tomorrow"), said("2", "who has the keys?")],
    {
      via: "test",
    },
  )
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
            statsCommand(messenger),
            tasksCommand(messenger),
            tagsCommand(messenger),
            storeCommand(messenger),
          ],
        },
        { streams, tty, env },
      )
      if (code === 0 && argv[0] === "tasks" && argv.includes("--json")) {
        const names = {
          "tasks add": "task_created",
          "tasks update": "task_card",
          "tasks link": "task_links",
          "tasks show": "task_card",
          "tasks related": "task_similar",
          "tasks duplicates": "task_pair",
          "tasks merge": "task_merge",
          "tasks unmerge": "task_unmerge",
          "tasks categories": "task_categories",
          "tasks scan": "task_scan",
          "tasks claim": "task_card",
          "tasks release": "task_card",
          "tasks close": "task_closed",
          "tasks reject": "task_card",
        } as const
        const entity = names[argv.slice(0, 2).join(" ") as keyof typeof names]
        if (entity) {
          const answer = JSON.parse(streams.stdout.join(""))
          const schema = ENTITIES[entity] as v.GenericSchema
          for (const item of answer.items ?? [answer.item]) v.parse(schema, item)
        }
      }
      return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
    }
  return Object.assign(runs(false), { pretty: runs(true), root, env: env as NodeJS.ProcessEnv })
}

const json = (result: { stdout: string[] }) => JSON.parse(result.stdout[0] ?? "null")
const item = (result: { stdout: string[] }) => json(result).item
const PROMISE = "msg:chat/500/7/1"

describe("tasks", () => {
  it("projects task-card fields and refuses an unknown field before changing a task", async () => {
    const call = await setup()
    const added = item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json"))
    const projected = await call("tasks", "show", added.id, "--json=key,title,status")
    expect(projected.code, projected.stderr).toBe(0)
    expect(Object.keys(item(projected)).sort()).toEqual(["key", "status", "title"])
    const before = item(await call("tasks", "show", added.id, "--json"))
    const refused = await call("tasks", "update", added.id, "--title", "Must stay unchanged", "--json=unknown_field")
    expect(refused.code).not.toBe(0)
    expect(JSON.parse(refused.stderr).error.reason).toBe("output.unknown-field")
    expect(item(await call("tasks", "show", added.id, "--json")).title).toBe(before.title)
  })

  it("requires an explicit duplicate-pair list leaf without opening the store", async () => {
    const root = mkdtempSync(join(tmpdir(), "duplicates-group-"))
    const env = {
      CHAT_PROFILE: "synthetic",
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CACHE_DIR: join(root, "cache"),
      MESSAGING_STORE: join(root, "store.sqlite"),
    }
    const streams = captureStreams()
    const code = await run(
      ["tasks", "duplicates", "--json"],
      { app, commands: () => [tasksCommand(messenger)] },
      { env, streams, tty: false },
    )
    expect(code).toBe(2)
    expect(streams.stdout).toEqual([])
    expect(JSON.parse(streams.stderr[0] ?? "").error).toMatchObject({ code: "validation_error" })
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })

  it("**tasks scan lists what a chat's history would open**, and opens it only with --yes", async () => {
    const call = await setup()
    const dry = json(await call("tasks", "scan", "7", "--last", "2", "--json"))
    expect(dry.items).toEqual([
      expect.objectContaining({
        chat: "7",
        messages: 2,
        added: 0,
        tasks: [{ source: "msg:chat/500/7/2", kind: "question", category: "access" }],
      }),
    ])
    expect(json(await call("tasks", "list", "--json")).items).toEqual([])

    const opened = json(await call("tasks", "scan", "7", "--yes", "--json"))
    expect(opened.items).toEqual([expect.objectContaining({ added: 1, tasks: [] })])
    expect(json(await call("tasks", "list", "--json")).items).toHaveLength(1)
  })

  it("**lists what someone owes the owner with assignee:**, after tasks add --assignee sender", async () => {
    const call = await setup()
    const added = item(
      await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--assignee", "sender", "--json"),
    )
    expect(added.card.assignments).toEqual([{ to: expect.stringMatching(/^person:\d+$/), role: "assignee" }])
    const listed = async (query: string) => json(await call("tasks", "list", query, "--json")).items.length
    expect([await listed("assignee:any"), await listed("assignee:none")]).toEqual([1, 0])

    await call("tasks", "update", added.id, "--assignee", "none", "--json")
    expect([await listed("assignee:any"), await listed("assignee:none")]).toEqual([0, 1])
  })

  it("**adds a task by locator and lists it with the message it points at**, once however often it is added", async () => {
    const call = await setup()
    const added = item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json"))
    expect(added).toMatchObject({ source: PROMISE, kind: "promise", state: "open", origin: "owner", created: true })

    expect(
      item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json")),
    ).toMatchObject({
      id: added.id,
      created: false,
    })
    const listed = json(await call("tasks", "list", "--json"))
    expect(v.parse(listEnvelopeSchema(task), listed).items).toMatchObject([
      { ref: `task:${added.id}`, chat: "chat:chat/500/7", source_message: PROMISE, kind: "promise" },
    ])
  })

  it("**closes a task, keeps the reason, and refuses to close it twice**", async () => {
    const call = await setup()
    const { id } = item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json"))

    const closed = item(await call("tasks", "close", id, "--as", "dismissed", "--reason", "no-reply-needed", "--json"))
    expect(closed).toMatchObject({ state: "dismissed", reason: "no-reply-needed", closed_by: "owner" })
    const again = await call("tasks", "close", id, "--as", "done", "--json")
    expect([again.code, again.stderr]).toEqual([2, expect.stringContaining("a closed task stays closed")])
    expect(json(await call("tasks", "list", "state:open", "--json")).items).toEqual([])
  })

  it("**an agent's terminal closes with --certainty; an unsure close waits on the owner's agenda** until close or reject", async () => {
    const call = await setup()
    const { id, key } = item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json"))
    call.env.AI_AGENT = "claude-code_2-1-296_agent"

    const bare = await call("tasks", "close", key, "--as", "done", "--json")
    expect([bare.code, bare.stderr]).toEqual([2, expect.stringContaining("certainty")])
    const unsure = await call.pretty("tasks", "close", key, "--as", "done", "--certainty", "0.5", "--reason", "sent?")
    expect(unsure.stderr).toContain(`chat tasks reject ${key}`)
    expect(item(await call("tasks", "show", key, "--json"))).toMatchObject({
      status: "open",
      close_suggestion: { as: "done", by: "claude-code", certainty: 0.5, reason: "sent?" },
    })
    expect((await call("tasks", "reject", key, "--json")).code).toBe(5)

    delete call.env.AI_AGENT
    expect(json(await call("tasks", "list", "close:suggested", "--json")).items).toMatchObject([
      { id, close_suggestion: { by: "claude-code" } },
    ])
    expect(item(await call("tasks", "agenda", "--json")).tasks).toMatchObject([
      { key, reasons: expect.arrayContaining(["close-suggested"]), close_suggestion: { as: "done" } },
    ])
    expect(item(await call("tasks", "reject", key, "--json"))).toMatchObject({ status: "open", close_suggestion: null })
    expect(json(await call("tasks", "list", "close:suggested", "--json")).items).toEqual([])

    call.env.AI_AGENT = "codex_0-162_agent"
    expect(item(await call("tasks", "close", key, "--as", "done", "--certainty", "0.9", "--json"))).toMatchObject({
      state: "done",
      close_certainty: 0.9,
      closed_by: "agent",
    })
  })

  it("**runs the timed follow-ups' task writes under the read-only lock**; a close only suggests, a plan keeps the old text", async () => {
    const call = await setup()
    call.env.CHAT_READ_ONLY = "1"
    const ok = async (...argv: string[]) => {
      const result = await call(...argv, "--json")
      expect([argv.join(" "), result.code, result.stderr]).toEqual([argv.join(" "), 0, ""])
      return result
    }

    await ok("tasks", "scan", "7", "--yes")
    const { id, key } = item(await ok("tasks", "add", PROMISE, "--type", "promise", "--category", "money"))
    const before = item(await ok("tasks", "show", key)).title
    await ok(
      "tasks",
      "update",
      key,
      "--title",
      "send Ana the invoice",
      "--description",
      "Owes: me",
      "--remind-time",
      "1d",
    )
    await ok("tasks", "link", key, "msg:chat/500/7/2")
    const scanned = json(await ok("tasks", "list")).items.find((one: { id: string }) => one.id !== id).id
    await ok("tasks", "duplicates", "defer", scanned, key)
    await ok("tasks", "duplicates", "reject", scanned, key)
    await ok("tasks", "merge", scanned, "--into", key)
    await ok("tasks", "unmerge", scanned)
    await ok("tasks", "claim", key)
    await ok("tasks", "release", key)
    const closed = item(await ok("tasks", "close", key, "--as", "done", "--certainty", "0.99"))
    expect(closed).toMatchObject({ state: "open", close_suggestion: { as: "done", certainty: 0.99 } })

    const asOwner = await call("tasks", "close", key, "--as", "done", "--as-owner", "--json")
    expect([asOwner.code, asOwner.stderr]).toEqual([5, expect.stringContaining("cannot close a task as the owner")])
    expect((await call("tasks", "reject", key, "--json")).code).toBe(5)

    delete call.env.CHAT_READ_ONLY
    expect((await call("tasks", "duplicates", "reject", scanned, key, "--json")).code).toBe(0)
    call.env.CHAT_READ_ONLY = "1"
    const overruled = await call("tasks", "duplicates", "defer", scanned, key, "--json")
    expect([overruled.code, overruled.stderr]).toEqual([5, expect.stringContaining("the owner already decided")])

    const store = await openStore({ path: call.env.MESSAGING_STORE as string })
    try {
      const events = await store.tasks.events(id)
      expect(events.find((one) => one.kind === "title")?.changes).toEqual({ title: [before, "send Ana the invoice"] })
    } finally {
      await store.close()
    }
  })

  it("**narrows by a query** over kind, chat and age, and names the fields it has", async () => {
    const call = await setup()
    await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json")
    await call("tasks", "add", "msg:chat/500/7/2", "--type", "question", "--category", "money", "--json")

    const types = (result: { stdout: string[] }) => json(result).items.map((task: { kind: string }) => task.kind)
    expect(types(await call("tasks", "list", "kind:question", "--json"))).toEqual(["question"])
    expect(types(await call("tasks", "list", "kind:question OR kind:promise", "--json")).sort()).toEqual([
      "promise",
      "question",
    ])
    expect(types(await call("tasks", "list", "chat:7", "--json"))).toHaveLength(2)
    expect(types(await call("tasks", "list", "NOT kind:question", "--json"))).toEqual(["promise"])
    expect(types(await call("tasks", "list", "created_at<2026-01-01", "--json"))).toEqual([])
    const paged = json(await call("tasks", "list", "--limit", "1", "--json"))
    expect([paged.items.length, paged.page.has_more, paged.next[0].step]).toEqual([1, true, "page.next"])
    const unknown = await call("tasks", "list", "type:question", "--json")
    expect([unknown.code, unknown.stderr]).toEqual([2, expect.stringContaining("query.unknown-field")])
    expect((await call("tasks", "list", "invoice", "--json")).stderr).toContain("query.bare-word")
  })

  it("**a backup keeps the tasks**: restored, a closed one is open again", async () => {
    const call = await setup()
    const { id } = item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json"))
    const file = join(call.root, "backup.db")
    expect((await call("store", "backup", file, "--json")).code).toBe(0)
    await call("tasks", "close", id, "--as", "done", "--json")

    expect((await call("store", "restore", file, "--json")).code).toBe(0)
    expect(json(await call("tasks", "list", "--json")).items).toMatchObject([{ id, state: "open" }])
  })

  it("counts open tasks per chat", async () => {
    const call = await setup()
    await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json")
    await call("tasks", "add", "msg:chat/500/7/2", "--type", "question", "--category", "money", "--json")

    expect(json(await call("stats", "tasks", "show", "--json")).item).toEqual({
      open: 2,
      rows: [{ chat: "chat:chat/500/7", open: 2, oldest_open_at: expect.any(String), median_close_ms: null }],
    })
    expect(json(await call("stats", "tasks", "show", "--type", "question", "--json")).item.rows).toMatchObject([
      { chat: "chat:chat/500/7", open: 1 },
    ])
    expect((await call("stats", "tasks", "show", "--jsonl")).code).not.toBe(0)
  })

  it("refuses what is not this account's locator, an unknown type, and writes on a read-only profile", async () => {
    const call = await setup()
    expect((await call("tasks", "add", "101", "--type", "promise", "--category", "money", "--json")).stderr).toContain(
      "is not a message locator",
    )
    expect(
      (await call("tasks", "add", "msg:chat/999/7/1", "--type", "promise", "--category", "money", "--json")).stderr,
    ).toContain("another account")
    expect((await call("tasks", "add", PROMISE, "--type", "gossip", "--category", "money", "--json")).stderr).toContain(
      "--type takes question, request, mention, promise",
    )
    expect(
      (await call("tasks", "add", PROMISE, "--type", "promise", "--category", "finance", "--json")).stderr,
    ).toContain("--category takes taxes, investments, subscriptions, bills, donations, insurance, bank,")
    expect((await call("tasks", "close", "nope", "--as", "done", "--json")).code).toBe(6)

    const readOnly = await setup({ profiles: { default: { permissions: { tasks: "readonly" } } } })
    const refused = await readOnly("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json")
    expect([refused.code === 0, refused.stderr]).toEqual([false, expect.stringContaining("tasks.add")])
  })

  it("**plans, links and shows a task, and lists it on the agenda**, from flags as typed", async () => {
    const call = await setup()
    const added = item(
      await call(
        "tasks",
        "add",
        PROMISE,
        "--type",
        "promise",
        "--category",
        "money",
        "--title",
        "Send the invoice",
        "--due",
        "2d",
        "--remind-time",
        "1d",
        "--json",
      ),
    )
    expect(added.card).toMatchObject({
      title: "Send the invoice",
      due_at: expect.any(String),
      next_check_at: expect.any(String),
    })

    const planned = item(
      await call("tasks", "update", added.id, "--due", "none", "--remind-time", "2026-01-01", "--json"),
    )
    expect(planned).toMatchObject({ due_at: null, next_check_at: new Date(2026, 0, 1).toISOString() })
    expect((await call("tasks", "update", added.id)).code).not.toBe(0)
    expect((await call("tasks", "update", added.id, "--due", "soon")).stderr).toContain("--due takes")

    const linked = item(
      await call(
        "tasks",
        "link",
        added.id,
        "https://example.com/invoice",
        "--chat",
        "7",
        "--kind",
        "evidence",
        "--json",
      ),
    )
    expect(
      linked.links.map(({ to, target_text }: { to: string | null; target_text: string | null }) => to ?? target_text),
    ).toEqual(["https://example.com/invoice", "chat:chat/500/7"])
    expect(item(await call("tasks", "show", planned.key, "--json")).links).toHaveLength(2)

    const agenda = json(await call("tasks", "agenda", "--due-within", "1d", "--within", "3650d", "--json"))
    expect(agenda.item.tasks).toMatchObject([{ id: added.id, reasons: ["check"] }])
    expect(json(await call("tasks", "agenda", "--within", "3650d", "chat_kind:channel", "--json")).item.owed).toEqual(
      [],
    )
    expect((await call("tasks", "agenda", "--waiting", "soon")).stderr).toContain("--waiting takes")
    await call("tasks", "update", added.id, "--assignee", "sender")
    const printed = (await call.pretty("tasks", "agenda", "--within", "3650d")).stdout.join("")
    expect(printed).toContain("Send the invoice")
    expect(printed).toContain("unsynced — moved, newest message not stored")
    expect(printed).toMatch(
      /assigned — others owe you, oldest first \(1\)\n {2}\S+ {2}person:\d+ {2}since .+Send the invoice/,
    )
  })

  it("**keys, categorizes, tags and claims a task**: one holder at a time, hidden from others on the agenda", async () => {
    const call = await setup()
    const listed = item(await call("tasks", "categories", "--json")).categories
    expect(listed.map(({ name }: { name: string }) => name)).toEqual(DEFAULT_TASK_CATEGORIES.map(({ name }) => name))
    const added = item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json"))
    expect(added).toMatchObject({ key: "PR-1", category: "money" })
    expect(item(await call("tasks", "update", "PR-1", "--category", "Documents", "--json")).category).toBe("documents")
    expect(json(await call("tasks", "list", "category:documents", "key:PR-1", "--json")).items).toHaveLength(1)
    expect(json(await call("tasks", "list", "category:money", "--json")).items).toEqual([])
    expect((await call("tasks", "update", "PR-1", "--category", "finance")).stderr).toContain("--category takes taxes")

    expect((await call("tags", "add", "urgent", "--task", "PR-1", "--json")).code).toBe(0)
    expect(json(await call("tasks", "list", "tag:urgent", "--json")).items).toMatchObject([{ key: "PR-1" }])
    expect(json(await call("tasks", "list", "tag:later", "--json")).items).toEqual([])
    const agendaOf = async (...filter: string[]) =>
      json(await call("tasks", "agenda", "--within", "3650d", ...filter, "--json")).item.tasks.map(
        (task: { key: string }) => task.key,
      )
    expect(await agendaOf("category:documents", "tag:Urgent")).toEqual(["PR-1"])
    expect(await agendaOf("category:money")).toEqual([])
    expect(await agendaOf("tag:later")).toEqual([])
    expect(await agendaOf("tag:urgent", "chat_kind:channel")).toEqual(["PR-1"])
    const mixed = await call("tasks", "agenda", "tag:urgent OR chat_kind:channel", "--json")
    expect([mixed.code, mixed.stderr]).toEqual([2, expect.stringContaining("query.unsupported-placement")])
    expect(json(await call("tags", "list", "--json")).items).toMatchObject([
      { tag: "urgent", type: "task", target: `task:${added.id}` },
    ])
    expect((await call("tags", "remove", "urgent", "--task", "PR-1", "--json")).code).toBe(0)
    expect(json(await call("tasks", "list", "tag:urgent", "--json")).items).toEqual([])

    const mine = ["--holder", "chat-7", "--json"]
    expect(item(await call("tasks", "claim", "PR-1", "--lease", "2h", ...mine))).toMatchObject({ claimed_by: "chat-7" })
    expect(item(await call("tasks", "claim", "PR-1", "--lease", "3h", ...mine)).claimed_by).toBe("chat-7")
    const other = ["--holder", "claude-code:other", "--json"]
    expect((await call("tasks", "claim", "PR-1", ...other)).stderr).toContain("chat-7 holds task PR-1 until")
    expect((await call("tasks", "release", "PR-1", ...other)).stderr).toContain("only they or the owner release it")
    expect(json(await call("tasks", "agenda", "--within", "3650d", ...mine)).item.tasks).toMatchObject([
      { key: "PR-1", claimed_by: "chat-7" },
    ])
    expect(json(await call("tasks", "agenda", "--within", "3650d", ...other)).item.tasks).toEqual([])
    expect(json(await call("tasks", "agenda", "--within", "3650d", "claimed:any", ...other)).item.tasks).toMatchObject([
      { key: "PR-1", claimed_by: "chat-7" },
    ])
    expect(
      json(await call("tasks", "agenda", "--within", "3650d", "claimed:others", ...other)).item.tasks,
    ).toHaveLength(1)
    expect(json(await call("tasks", "agenda", "--within", "3650d", "claimed:others", ...mine)).item.tasks).toEqual([])
    expect(json(await call("tasks", "agenda", "--within", "3650d", "claimed:none", ...mine)).item.tasks).toEqual([])
    expect((await call.pretty("tasks", "agenda", "--within", "3650d", "--holder", "chat-7")).stdout.join("")).toContain(
      "claimed by chat-7 until",
    )
    expect(item(await call("tasks", "release", "PR-1", ...mine)).claimed_by).toBeNull()

    const store = await openStore({ path: join(call.root, "m.db") })
    await store.tasks.claim("PR-1", "someone-else", new Date(Date.now() + 60_000))
    await store.close()
    expect(item(await call("tasks", "close", "PR-1", "--as", "done", "--json"))).toMatchObject({ state: "done" })
    expect(item(await call("tasks", "show", "PR-1", "--json")).claimed_by).toBeNull()
  })

  it("**lists tasks by who claimed them**, and a lapsed claim matches no one", async () => {
    const call = await setup()
    await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json")
    await call("tasks", "claim", "PR-1", "--holder", "session-7", "--json")
    const keys = async (filter: string) =>
      json(await call("tasks", "list", filter, "--json")).items.map((task: { key: string }) => task.key)

    expect(await keys("claimed_by:session-7")).toEqual(["PR-1"])
    expect(await keys("claimed_by:session-*")).toEqual(["PR-1"])
    expect(await keys("claimed_by:*")).toEqual(["PR-1"])
    expect(await keys("claimed_by:session-8")).toEqual([])
    expect(await keys("NOT claimed_by:*")).toEqual([])

    const store = await openStore({ path: join(call.root, "m.db") })
    await store.tasks.claim("PR-1", "session-7", new Date(Date.now() - 1))
    await store.close()
    expect(await keys("claimed_by:session-7")).toEqual([])
    expect(await keys("NOT claimed_by:*")).toEqual(["PR-1"])
  })

  it("prints for a person, and says so when there is nothing", async () => {
    const call = (await setup()).pretty
    expect((await call("tasks", "list")).stderr).toContain("no tasks")
    await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money")
    const shown = await call("tasks", "list")
    expect(shown.stdout.join("")).toContain("Ana: I'll send the invoice tomorrow")
    expect((await call("stats", "tasks", "show")).stdout.join("")).toContain("1 open")
  })

  it("**lists the tasks that may be the same job**, scored, in snake_case, and changes nothing", async () => {
    const call = await setup()
    const add = async (message: string, title: string) =>
      item(await call("tasks", "add", message, "--type", "request", "--category", "money", "--title", title, "--json"))
        .card.key
    const invoice = await add(PROMISE, "Send the invoice for 15 000 rub")
    const again = item(
      await call(
        "tasks",
        "add",
        "msg:chat/500/7/2",
        "--type",
        "request",
        "--category",
        "money",
        "--title",
        "Invoice 15000 rub to send",
        "--new",
        "--json",
      ),
    ).card.key

    const listed = json(await call("tasks", "related", invoice, "--json"))
    expect(listed.items).toMatchObject([
      { key: again, band: expect.stringMatching(/likely|maybe/), found_by: expect.arrayContaining(["text"]) },
    ])
    expect(listed.items[0].reasons).toContain("same amount")
    expect(json(await call("tasks", "list", "--json")).items).toHaveLength(2)
    expect((await call.pretty("tasks", "related", again)).stdout.join("")).toContain(invoice)
  })
})

it("**takes a category from the list the owner edited in the store**, and refuses one it removed", async () => {
  const call = await setup()
  const store = await openStore({ path: join(call.root, "m.db") })
  await store.tasks.saveCategories(
    withTaskCategory(withTaskCategory(DEFAULT_TASK_CATEGORIES, "garden", "plants | seedling"), "personal", undefined),
  )
  await store.close()

  expect(
    item(await call("tasks", "categories", "--json")).categories.map(({ name }: { name: string }) => name),
  ).toContain("garden")
  expect(
    item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "Garden", "--json")),
  ).toMatchObject({ category: "garden" })
  const removed = await call("tasks", "update", "PR-1", "--category", "personal", "--json")
  expect([removed.code, removed.stderr]).toEqual([2, expect.stringContaining("--category takes taxes")])
})

it("**names a category its tasks still carry after the owner removed it**, with how to find them", async () => {
  const call = await setup()
  const store = await openStore({ path: join(call.root, "m.db") })
  await store.tasks.saveCategories(withTaskCategory(DEFAULT_TASK_CATEGORIES, "garden", "plants | seedling"))
  await store.close()
  await call("tasks", "add", PROMISE, "--type", "promise", "--category", "garden", "--json")
  const again = await openStore({ path: join(call.root, "m.db") })
  await again.tasks.saveCategories(DEFAULT_TASK_CATEGORIES)
  await again.close()

  expect(item(await call("tasks", "categories", "--json")).unlisted).toEqual([{ name: "garden", open: 1, total: 1 }])
  expect((await call.pretty("tasks", "categories")).stdout.join("")).toContain("tasks list category:garden")
  expect(item(await call("tasks", "agenda", "--json")).unlisted_categories).toEqual([{ name: "garden", open_tasks: 1 }])
})

describe("tasks that may be one job", () => {
  const request = (message: string, title: string, ...more: string[]) => [
    "tasks",
    "add",
    message,
    "--type",
    "request",
    "--category",
    "money",
    "--title",
    title,
    ...more,
    "--json",
  ]

  it("**refuses a task that may be the same job and lists the candidates**; --into links, --new opens", async () => {
    const call = await setup()
    const invoice = item(await call(...request(PROMISE, "Send the invoice for 15 000 rub"))).card.key

    const refused = await call(...request("msg:chat/500/7/2", "Invoice 15000 rub to send"))
    expect(refused.code).toBe(2)
    expect(JSON.parse(refused.stderr).error).toMatchObject({
      code: "validation_error",
      reason: "task.duplicate-candidates",
      details: {
        candidates: [{ key: invoice, band: expect.stringMatching(/likely|maybe/), reasons: expect.any(Array) }],
      },
    })
    expect(json(await call("tasks", "list", "--json")).items).toHaveLength(1)

    const both = await call(...request("msg:chat/500/7/2", "Invoice", "--into", invoice, "--new"))
    expect([both.code, both.stderr]).toEqual([2, expect.stringContaining("choose one")])

    const attached = item(await call(...request("msg:chat/500/7/2", "Invoice 15000 rub to send", "--into", invoice)))
    expect(attached).toMatchObject({ key: invoice, created: false, attached: true, review: 0 })
    expect(json(await call("tasks", "list", "--json")).items).toHaveLength(1)
    expect(item(await call("tasks", "show", invoice, "--json")).links).toMatchObject([
      { kind: "evidence", to: expect.stringContaining("msg:chat/500/7/2") },
    ])
  })

  it("**--new opens the task anyway** and keeps the answer as a pair that is not one job", async () => {
    const call = await setup()
    const invoice = item(await call(...request(PROMISE, "Send the invoice for 15 000 rub"))).card.key
    const opened = item(await call(...request("msg:chat/500/7/2", "Invoice 15000 rub to send", "--new")))
    expect(opened).toMatchObject({ created: true })
    expect(json(await call("tasks", "duplicates", "list", "--json")).items).toEqual([])

    const database = await openCache(join(call.root, "m.db"))
    expect(
      database
        .prepare("SELECT decision FROM task_pairs WHERE other_id = (SELECT id FROM tasks WHERE key = ?)")
        .all(invoice),
    ).toEqual([{ decision: "new" }])
    database.close()
  })

  it("**lists pairs for review, marks one unsure for the owner, merges and unmerges, rejects**", async () => {
    const call = await setup()
    const invoice = item(await call(...request(PROMISE, "Send the invoice for 15 000 rub"))).card.key
    const again = item(await call(...request("msg:chat/500/7/2", "Invoice 15000 rub to send", "--new"))).card.key
    const database = await openCache(join(call.root, "m.db"))
    database
      .prepare(
        "UPDATE task_pairs SET decision = 'review', decided_by_type = NULL, decided_by_id = NULL, decided_at = NULL",
      )
      .run()
    database.close()

    const listed = json(await call("tasks", "duplicates", "list", "--json"))
    for (const pair of listed.items) expect(v.safeParse(taskPair, pair).success).toBe(true)

    expect(listed.items).toMatchObject([
      {
        task: { key: again },
        other: { key: invoice },
        decision: "review",
        decided_at: null,
        levels: expect.any(Object),
      },
    ])
    expect((await call.pretty("tasks", "duplicates", "list")).stdout.join("")).toContain(invoice)

    expect(item(await call("tasks", "duplicates", "defer", again, invoice, "--json"))).toMatchObject({
      decision: "unsure",
    })
    expect(json(await call("tasks", "duplicates", "list", "--json")).items).toEqual([])
    expect(json(await call("tasks", "duplicates", "list", "decision:unsure", "--json")).items).toHaveLength(1)

    const merged = item(await call("tasks", "merge", again, "--into", invoice, "--json"))
    expect(merged).toMatchObject({ pair: { decision: "merged" }, linked: 1, task: { key: invoice } })
    expect(v.safeParse(taskPair, merged.pair).success).toBe(true)
    expect(merged.pair).toHaveProperty("decided_at")
    expect(merged.task).toHaveProperty("created_at")
    const shown = item(await call("tasks", "show", again, "--json"))
    expect(shown).toMatchObject({ status: "dismissed" })
    expect(shown.links).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "duplicate-of" })]))
    expect(json(await call("tasks", "duplicates", "list", "decision:unsure", "--json")).items).toEqual([])

    const unmerged = item(await call("tasks", "unmerge", again, "--json"))
    expect(v.safeParse(taskPair, unmerged.pair).success).toBe(true)
    expect(unmerged).toMatchObject({ pair: { decision: "unmerged" }, task: { key: again, status: "open" } })

    expect(item(await call("tasks", "duplicates", "reject", again, invoice, "--json"))).toMatchObject({
      decision: "rejected",
    })
    const missing = await call("tasks", "merge", again, "--json")
    expect(missing.code).toBe(2)

    const related = item(await call("tasks", "link", again, `task:${invoice}`, "--kind", "duplicate-of", "--json"))
    expect(related.relations).toMatchObject([{ kind: "duplicate-of" }])
  })

  it("asks for the write permission of each decision", async () => {
    const call = await setup({ profiles: { default: { permissions: { "tasks.merge": "deny" } } } })
    expect((await call("tasks", "merge", "Q-1", "--into", "Q-2", "--json")).code).toBe(5)
  })
})

it("removes resource-local statistics without aliases and retains independent data denials", async () => {
  const call = await setup()
  expect((await call("tasks", "stats", "--json")).code).toBe(2)
  for (const key of ["stats.tasks.show", "tasks", "messages"]) {
    const denied = await setup({ profiles: { default: { permissions: { [key]: "deny" } } } })
    const result = await denied("stats", "tasks", "show", "--json")
    expect(result.code).toBe(5)
    expect(result.stdout).toEqual([])
  }
  const old = await setup({ profiles: { default: { permissions: { "tasks.stats": "deny" } } } })
  expect((await old("stats", "tasks", "show", "--json")).code).toBe(3)
})

it("**takes the account from the command** where the program has no messenger profile, as memo mounts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tasks-flags-"))
  const env = {
    ...process.env,
    MESSAGING_STORE: join(root, "m.db"),
    CHAT_STATE_DIR: join(root, "state"),
    NO_COLOR: "1",
  }
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.messages.saveMessages(account, "7", [said("1", "I'll send the invoice tomorrow")], { via: "test" })
  await store.close()
  const flagged: Messenger = {
    ...messenger,
    accountOf: (command) => {
      const { provider, account: id } = command.opts<{ provider?: string; account?: string }>()
      return provider && id ? { provider, account: id } : undefined
    },
  }
  const program = () => {
    const tasks = tasksCommand(flagged)
    for (const one of tasks.commands) one.option("--provider <provider>").option("--account <account>")
    return [tasks]
  }
  const call = async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(argv, { app, commands: program }, { streams, tty: false, env })
    return { code, body: JSON.parse(streams.stdout[0] ?? "null") }
  }

  const added = await call(
    "tasks",
    "add",
    PROMISE,
    "--type",
    "promise",
    "--category",
    "money",
    "--provider",
    "chat",
    "--account",
    "500",
    "--json",
  )
  expect(added.code).toBe(0)
  expect((await call("tasks", "list", "--provider", "chat", "--account", "500", "--json")).body.items).toHaveLength(1)
  expect((await call("tasks", "list", "--json")).code).not.toBe(0)
})

it("clears a project task parent through the canonical none value", async () => {
  const cli = await setup()
  const store = await openStore({ path: cli.env.MESSAGING_STORE })
  let id: string
  try {
    const project = await store.knowledge.addProject({ name: "Synthetic Parent Clear", key: "SPC", type: "work" })
    const parent = await store.tasks.create({ project: project.ref, title: "Parent", type: "chore" }, "owner")
    const child = await store.tasks.create(
      { project: project.ref, title: "Child", type: "chore", parent: parent.ref },
      "owner",
    )
    id = child.id
  } finally {
    await store.close()
  }
  const cleared = await cli("tasks", "update", id, "--parent", "none", "--json")
  expect(cleared.code, JSON.stringify(cleared)).toBe(0)
  expect(item(cleared)).toMatchObject({ id, parent: null })
})

it("claims and releases a project task, which belongs to no messenger account", async () => {
  const cli = await setup()
  const store = await openStore({ path: cli.env.MESSAGING_STORE })
  let id: string
  try {
    const project = await store.knowledge.addProject({ name: "Synthetic Claims", key: "SCL", type: "work" })
    id = (await store.tasks.create({ project: project.ref, title: "Draft", type: "chore" }, "owner")).id
  } finally {
    await store.close()
  }
  const claimed = await cli("tasks", "claim", id, "--holder", "session-3", "--json")
  expect(claimed.code, JSON.stringify(claimed)).toBe(0)
  expect(item(claimed).claimed_by).toBe("session-3")
  expect(item(await cli("tasks", "release", id, "--holder", "session-3", "--json")).claimed_by).toBeNull()
})
