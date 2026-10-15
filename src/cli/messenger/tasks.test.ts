import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { listEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { DEFAULT_TASK_CATEGORIES, withTaskCategory } from "../../domain/task-categories.js"
import { task } from "../../entities/index.js"
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
  await store.saveMessages(
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
      return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
    }
  return Object.assign(runs(false), { pretty: runs(true), root })
}

const json = (result: { stdout: string[] }) => JSON.parse(result.stdout[0] ?? "null")
const item = (result: { stdout: string[] }) => json(result).item
const PROMISE = "msg:chat/500/7/1"

describe("tasks", () => {
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
    ).toContain("--category takes money, documents, meeting, delivery, access, personal, other")
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
      await call("tasks", "plan", added.id, "--due", "none", "--remind-time", "2026-01-01", "--json"),
    )
    expect(planned).toMatchObject({ due_at: null, next_check_at: "2026-01-01T00:00:00.000Z" })
    expect((await call("tasks", "plan", added.id)).code).not.toBe(0)
    expect((await call("tasks", "plan", added.id, "--due", "soon")).stderr).toContain("--due takes")

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

    const agenda = json(await call("tasks", "agenda", "--due", "1d", "--within", "3650d", "--json"))
    expect(agenda.item.tasks).toMatchObject([{ id: added.id, reasons: ["check"] }])
    expect(json(await call("tasks", "agenda", "--within", "3650d", "chat_kind:channel", "--json")).item.owed).toEqual(
      [],
    )
    expect((await call("tasks", "agenda", "--waiting", "soon")).stderr).toContain("--waiting takes")
    const printed = (await call.pretty("tasks", "agenda", "--within", "3650d")).stdout.join("")
    expect(printed).toContain("Send the invoice")
    expect(printed).toContain("unsynced — moved, newest message not stored")
  })

  it("**keys, categorizes, tags and claims a task**: one holder at a time, hidden from others on the agenda", async () => {
    const call = await setup()
    const listed = item(await call("tasks", "categories", "--json")).categories
    expect(listed.map(({ name }: { name: string }) => name)).toEqual([
      "money",
      "documents",
      "meeting",
      "delivery",
      "access",
      "personal",
      "other",
    ])
    const added = item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "money", "--json"))
    expect(added).toMatchObject({ key: "PR-1", category: "money" })
    expect(item(await call("tasks", "plan", "PR-1", "--category", "Documents", "--json")).category).toBe("documents")
    expect(json(await call("tasks", "list", "category:documents", "key:PR-1", "--json")).items).toHaveLength(1)
    expect(json(await call("tasks", "list", "category:money", "--json")).items).toEqual([])
    expect((await call("tasks", "plan", "PR-1", "--category", "finance")).stderr).toContain("--category takes money")

    expect((await call("tags", "add", "urgent", "--task", "PR-1", "--json")).code).toBe(0)
    expect(json(await call("tasks", "list", "tag:urgent", "--json")).items).toMatchObject([{ key: "PR-1" }])
    expect(json(await call("tasks", "list", "tag:later", "--json")).items).toEqual([])
    const agendaOf = async (...filter: string[]) =>
      json(await call("tasks", "agenda", "--within", "3650d", ...filter, "--json")).item.tasks.map(
        (task: { key: string }) => task.key,
      )
    expect(await agendaOf("--category", "documents", "--tag", "Urgent")).toEqual(["PR-1"])
    expect(await agendaOf("--category", "money")).toEqual([])
    expect(await agendaOf("--tag", "later")).toEqual([])
    expect(json(await call("tags", "list", "--json")).items).toMatchObject([
      { tag: "urgent", type: "task", target: `task:${added.id}` },
    ])
    expect((await call("tags", "remove", "urgent", "--task", "PR-1", "--json")).code).toBe(0)
    expect(json(await call("tasks", "list", "tag:urgent", "--json")).items).toEqual([])

    const mine = ["--holder", "chat-7", "--json"]
    expect(item(await call("tasks", "claim", "PR-1", "--for", "2h", ...mine))).toMatchObject({ claimed_by: "chat-7" })
    expect(item(await call("tasks", "claim", "PR-1", "--for", "3h", ...mine)).claimed_by).toBe("chat-7")
    const other = ["--holder", "claude-code:other", "--json"]
    expect((await call("tasks", "claim", "PR-1", ...other)).stderr).toContain("chat-7 holds task PR-1 until")
    expect((await call("tasks", "release", "PR-1", ...other)).stderr).toContain("only they or the owner release it")
    expect(json(await call("tasks", "agenda", "--within", "3650d", ...mine)).item.tasks).toMatchObject([
      { key: "PR-1", claimed_by: "chat-7" },
    ])
    expect(json(await call("tasks", "agenda", "--within", "3650d", ...other)).item.tasks).toEqual([])
    expect(json(await call("tasks", "agenda", "--within", "3650d", "--claimed", ...other)).item.tasks).toMatchObject([
      { key: "PR-1", claimed_by: "chat-7" },
    ])
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

    const listed = json(await call("tasks", "similar", invoice, "--json"))
    expect(listed.items).toMatchObject([
      { key: again, band: expect.stringMatching(/likely|maybe/), found_by: expect.arrayContaining(["text"]) },
    ])
    expect(listed.items[0].reasons).toContain("same amount")
    expect(json(await call("tasks", "list", "--json")).items).toHaveLength(2)
    expect((await call.pretty("tasks", "similar", again)).stdout.join("")).toContain(invoice)
  })
})

it("**takes a category from the list the owner edited in the store**, and refuses one it removed", async () => {
  const call = await setup()
  const store = await openStore({ path: join(call.root, "m.db") })
  await store.tasks.saveCategories(
    withTaskCategory(withTaskCategory(DEFAULT_TASK_CATEGORIES, "travel", "trips | flight"), "personal", undefined),
  )
  await store.close()

  expect(
    item(await call("tasks", "categories", "--json")).categories.map(({ name }: { name: string }) => name),
  ).toContain("travel")
  expect(
    item(await call("tasks", "add", PROMISE, "--type", "promise", "--category", "Travel", "--json")),
  ).toMatchObject({ category: "travel" })
  const removed = await call("tasks", "plan", "PR-1", "--category", "personal", "--json")
  expect([removed.code, removed.stderr]).toEqual([2, expect.stringContaining("--category takes money")])
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

  it("**refuses a task that may be the same job and lists the candidates**; --attach links, --new opens", async () => {
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

    const both = await call(...request("msg:chat/500/7/2", "Invoice", "--attach", invoice, "--new"))
    expect([both.code, both.stderr]).toEqual([2, expect.stringContaining("choose one")])

    const attached = item(await call(...request("msg:chat/500/7/2", "Invoice 15000 rub to send", "--attach", invoice)))
    expect(attached).toMatchObject({ key: invoice, created: false, attached: true })
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
    expect(json(await call("tasks", "duplicates", "--json")).items).toEqual([])

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

    const listed = json(await call("tasks", "duplicates", "--json"))
    expect(listed.items).toMatchObject([
      {
        task: { key: again },
        other: { key: invoice },
        decision: "review",
        decided_at: null,
        levels: expect.any(Object),
      },
    ])
    expect((await call.pretty("tasks", "duplicates")).stdout.join("")).toContain(invoice)

    expect(item(await call("tasks", "duplicates", "unsure", again, invoice, "--json"))).toMatchObject({
      decision: "unsure",
    })
    expect(json(await call("tasks", "duplicates", "--json")).items).toEqual([])
    expect(json(await call("tasks", "duplicates", "--unsure", "--json")).items).toHaveLength(1)

    const merged = item(await call("tasks", "merge", again, "--into", invoice, "--json"))
    expect(merged).toMatchObject({ pair: { decision: "merged" }, linked: 1, task: { key: invoice } })
    expect(merged.pair).toHaveProperty("decided_at")
    expect(merged.task).toHaveProperty("created_at")
    const shown = item(await call("tasks", "show", again, "--json"))
    expect(shown).toMatchObject({ status: "dismissed" })
    expect(shown.links).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "duplicate-of" })]))
    expect(json(await call("tasks", "duplicates", "--unsure", "--json")).items).toEqual([])

    const unmerged = item(await call("tasks", "unmerge", again, "--json"))
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
  await store.saveMessages(account, "7", [said("1", "I'll send the invoice tomorrow")], { via: "test" })
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
