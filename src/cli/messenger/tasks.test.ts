import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"
import { statsCommand } from "./stats-command.js"
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
        { app, commands: () => [statsCommand(messenger), tasksCommand(messenger), storeCommand(messenger)] },
        { streams, tty, env },
      )
      return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
    }
  return Object.assign(runs(false), { pretty: runs(true), root })
}

const json = (result: { stdout: string[] }) => JSON.parse(result.stdout[0] ?? "null")
const PROMISE = "msg:chat/500/7/1"

describe("tasks", () => {
  it("**adds a task by locator and lists it with the message it points at**, once however often it is added", async () => {
    const call = await setup()
    const added = json(await call("tasks", "add", PROMISE, "--type", "promise", "--json"))
    expect(added).toMatchObject({ source: PROMISE, kind: "promise", state: "open", origin: "owner", created: true })

    expect(json(await call("tasks", "add", PROMISE, "--type", "promise", "--json"))).toMatchObject({
      id: added.id,
      created: false,
    })
    const listed = json(await call("tasks", "list", "--json"))
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].message).toEqual({
      senderName: "Ana",
      text: "I'll send the invoice tomorrow",
      timestamp: "2026-10-06T10:01:00.000Z",
    })
  })

  it("**closes a task, keeps the reason, and refuses to close it twice**", async () => {
    const call = await setup()
    const { id } = json(await call("tasks", "add", PROMISE, "--type", "promise", "--json"))

    const closed = json(await call("tasks", "close", id, "--as", "dismissed", "--reason", "no-reply-needed", "--json"))
    expect(closed).toMatchObject({ state: "dismissed", reason: "no-reply-needed", closedBy: "owner" })
    const again = await call("tasks", "close", id, "--as", "done", "--json")
    expect([again.code, again.stderr]).toEqual([2, expect.stringContaining("a closed task stays closed")])
    expect(json(await call("tasks", "list", "--state", "open", "--json")).items).toEqual([])
  })

  it("filters by type, chat and age", async () => {
    const call = await setup()
    await call("tasks", "add", PROMISE, "--type", "promise", "--json")
    await call("tasks", "add", "msg:chat/500/7/2", "--type", "question", "--json")

    const types = (result: { stdout: string[] }) => json(result).items.map((task: { kind: string }) => task.kind)
    expect(types(await call("tasks", "list", "--type", "question", "--json"))).toEqual(["question"])
    expect(types(await call("tasks", "list", "--type", "question,promise", "--json")).sort()).toEqual([
      "promise",
      "question",
    ])
    expect(types(await call("tasks", "list", "--chat", "7", "--json"))).toHaveLength(2)
    expect(types(await call("tasks", "list", "--before-time", "2026-01-01T00:00:00Z", "--json"))).toEqual([])
  })

  it("**a backup keeps the tasks**: restored, a closed one is open again", async () => {
    const call = await setup()
    const { id } = json(await call("tasks", "add", PROMISE, "--type", "promise", "--json"))
    const file = join(call.root, "backup.db")
    expect((await call("store", "backup", file, "--json")).code).toBe(0)
    await call("tasks", "close", id, "--as", "done", "--json")

    expect((await call("store", "restore", file, "--json")).code).toBe(0)
    expect(json(await call("tasks", "list", "--json")).items).toMatchObject([{ id, state: "open" }])
  })

  it("counts open tasks per chat", async () => {
    const call = await setup()
    await call("tasks", "add", PROMISE, "--type", "promise", "--json")
    await call("tasks", "add", "msg:chat/500/7/2", "--type", "question", "--json")

    expect(json(await call("stats", "tasks", "show", "--json")).items).toMatchObject([{ group: "7", open: 2 }])
    expect(json(await call("stats", "tasks", "show", "--type", "question", "--json")).items).toMatchObject([
      { group: "7", open: 1 },
    ])
  })

  it("refuses what is not this account's locator, an unknown type, and writes on a read-only profile", async () => {
    const call = await setup()
    expect((await call("tasks", "add", "101", "--type", "promise", "--json")).stderr).toContain(
      "is not a message locator",
    )
    expect((await call("tasks", "add", "msg:chat/999/7/1", "--type", "promise", "--json")).stderr).toContain(
      "another account",
    )
    expect((await call("tasks", "add", PROMISE, "--type", "gossip", "--json")).stderr).toContain(
      "--type takes question, request, mention, promise",
    )
    expect((await call("tasks", "close", "nope", "--as", "done", "--json")).code).toBe(6)

    const readOnly = await setup({ profiles: { default: { readOnly: true } } })
    const refused = await readOnly("tasks", "add", PROMISE, "--type", "promise", "--json")
    expect([refused.code === 0, refused.stderr]).toEqual([false, expect.stringContaining("tasks.add")])
  })

  it("**plans, links and shows a task, and lists it on the agenda**, from flags as typed", async () => {
    const call = await setup()
    const added = json(
      await call(
        "tasks",
        "add",
        PROMISE,
        "--type",
        "promise",
        "--title",
        "Send the invoice",
        "--due",
        "2d",
        "--check",
        "1d",
        "--json",
      ),
    )
    expect(added.card).toMatchObject({
      title: "Send the invoice",
      dueAt: expect.any(String),
      nextCheckAt: expect.any(String),
    })

    const planned = json(await call("tasks", "plan", added.id, "--due", "none", "--check", "2026-01-01", "--json"))
    expect(planned).toMatchObject({ dueAt: null, nextCheckAt: "2026-01-01T00:00:00.000Z" })
    expect((await call("tasks", "plan", added.id)).code).not.toBe(0)
    expect((await call("tasks", "plan", added.id, "--due", "soon")).stderr).toContain("--due takes")

    const linked = json(
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
      linked.links.map(({ to, targetText }: { to: string | null; targetText: string | null }) => to ?? targetText),
    ).toEqual(["https://example.com/invoice", "chat:chat/500/7"])
    expect(json(await call("tasks", "show", planned.key, "--json")).links).toHaveLength(2)

    const agenda = json(await call("tasks", "agenda", "--due", "1d", "--within", "3650d", "--json"))
    expect(agenda.tasks).toMatchObject([{ id: added.id, reasons: ["check"] }])
    expect((await call("tasks", "agenda", "--waiting", "soon")).stderr).toContain("--waiting takes")
    const printed = (await call.pretty("tasks", "agenda", "--within", "3650d")).stdout.join("")
    expect(printed).toContain("Send the invoice")
    expect(printed).toContain("unsynced — moved, newest message not stored")
  })

  it("prints for a person, and says so when there is nothing", async () => {
    const call = (await setup()).pretty
    expect((await call("tasks", "list")).stderr).toContain("no tasks")
    await call("tasks", "add", PROMISE, "--type", "promise")
    const shown = await call("tasks", "list")
    expect(shown.stdout.join("")).toContain("Ana: I'll send the invoice tomorrow")
    expect((await call("stats", "tasks", "show")).stdout.join("")).toContain("1 open")
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
