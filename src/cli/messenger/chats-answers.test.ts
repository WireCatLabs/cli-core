import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { itemEnvelopeSchema, listEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Chat } from "../../domain/models.js"
import { ENTITIES, type EntityName } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { chatsCommand } from "./chats-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { pollsCommand } from "./polls-command.js"
import { topicsCommand } from "./topics-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const at = "2026-10-01T10:00:00.000Z"

const chat = (id: string, kind: Chat["kind"] = "group"): Chat => ({
  id,
  title: `Synthetic ${id}`,
  kind,
  unreadCount: 0,
  lastMessageAt: at,
  participantsCount: 3,
})
const chats = [chat("7"), chat("8", "dialog"), chat("9", "channel")]
const person = (id: string) => ({ id, name: `Person ${id}`, username: null })

const fake = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async ({ limit, offset }: { limit?: number; offset: number }) => ({
    items: chats.slice(offset, limit === undefined ? undefined : offset + limit),
    hasMore: limit !== undefined && offset + limit < chats.length,
  }),
  resolve: async (typed: string) => chats.find((one) => one.id === typed) ?? chat(typed),
  chat: async (typed: string) => ({ ...chat(typed), members: [person("9")] }),
  history: async () => ({ items: [], hasMore: false }),
  chatEvents: async (chatId: string) => ({
    chatId,
    since: at,
    more: false,
    events: [{ messageId: "5", timestamp: at, event: "join", by: { id: "9", name: null }, people: [person("9")] }],
  }),
  members: async (typed: string, { limit, offset }: { limit?: number; offset: number }) => {
    const everyone = ["1", "2", "3"].map((id) => ({ ...person(id), role: "member" as const, hasPhoto: false }))
    const end = limit === undefined ? everyone.length : offset + limit
    return { chatId: typed, items: everyone.slice(offset, end), hasMore: end < everyone.length, participantsCount: 3 }
  },
  admins: async () => [],
  inviteLinks: async (_chat: string, { limit, revoked }: { limit: number; revoked: boolean }) => {
    const links = ["a", "b", "c"].map((id) => ({
      link: `https://example.test/+${id}`,
      approval: false,
      expiresAt: null,
      maxUses: null,
      revoked,
      joined: 1,
    }))
    return { items: links.slice(0, limit), hasMore: limit < links.length }
  },
  joinRequests: async (_chat: string, { limit }: { limit: number }) => {
    const requests = ["1", "2", "3"].map((id) => ({ person: person(id), requestedAt: at }))
    return { items: requests.slice(0, limit), hasMore: limit < requests.length }
  },
  answerJoinRequest: async () => ({ already: false }),
  folders: async () => [{ id: "2", title: "Work", chatIds: ["7"], include: ["groups" as const] }],
  close: async () => {},
  logout: async () => {},
} as unknown as MessengerAdapter

const harness = (adapter: Partial<MessengerAdapter> = {}, own: Partial<Messenger> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "chats-answers-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  rememberAccount(app, "default", "500", env)
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => ({ ...fake, ...adapter }) as MessengerAdapter,
    chatArgument: "a chat",
    ...own,
  }
  return async (argv: string[], tty = false) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      {
        app,
        commands: () => [
          chatsCommand(messenger),
          contactsCommand(messenger),
          pollsCommand(messenger),
          topicsCommand(messenger),
        ],
      },
      { streams, tty, env },
    )
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
}

const valid = (entity: EntityName, list: boolean, stdout: string) => {
  const schema = ENTITIES[entity] as v.GenericSchema
  const parsed = v.safeParse(list ? listEnvelopeSchema(schema) : itemEnvelopeSchema(schema), JSON.parse(stdout))
  return parsed.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`)
}

/** The words of a `→ why: chat …` line a person is shown, as a shell would split them. */
const stepWords = (stderr: string): string[] => {
  const line = stderr.split("\n").find((one) => one.includes("→ "))
  if (!line) return []
  const command = line.slice(line.indexOf(": chat ") + ": chat ".length)
  return (command.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((word) =>
    word.startsWith('"') ? (JSON.parse(word) as string) : word,
  )
}

interface Row {
  argv: string[]
  entity: EntityName
  list: boolean
  adapter?: Partial<MessengerAdapter>
  own?: Partial<Messenger>
}

const ROWS: Row[] = [
  { argv: ["chats", "list", "--limit", "1"], entity: "chat", list: true },
  { argv: ["chats", "show", "7"], entity: "chat", list: false },
  { argv: ["chats", "events", "7", "time>=2d"], entity: "chat_event", list: true },
  { argv: ["chats", "members", "list", "7", "--limit", "2"], entity: "member", list: true },
  { argv: ["chats", "members", "check", "7", "score>=1"], entity: "member", list: true },
  { argv: ["chats", "links", "list", "7", "--limit", "2"], entity: "invite_link", list: true },
  { argv: ["chats", "links", "list", "7", "revoked:true"], entity: "invite_link", list: true },
  { argv: ["chats", "requests", "list", "7", "--limit", "2", "name:person"], entity: "join_request", list: true },
  { argv: ["chats", "folders", "list"], entity: "folder", list: true },
]

describe("chats, contacts and groups answer in the envelope of their entity", () => {
  it.each(ROWS)("$argv", async ({ argv, entity, list, adapter, own }) => {
    const call = harness(adapter, own)
    const answered = await call([...argv, "--json"])
    expect(answered.stderr).toBe("")
    expect(answered.code).toBe(0)
    expect(valid(entity, list, answered.stdout)).toBeUndefined()
    const body = JSON.parse(answered.stdout) as { page?: { has_more: boolean }; next?: { step: string }[] }
    if (!body.page?.has_more) return
    expect(body.next?.[0]?.step).toBe("page.next")
    const shown = await call(argv, true)
    const again = stepWords(shown.stderr)
    expect(again.length).toBeGreaterThan(0)
    const next = await call([...again, "--json"])
    expect(next.code).toBe(0)
    expect(valid(entity, list, next.stdout)).toBeUndefined()
  })
})

describe("chats list", () => {
  it("**names each chat by a chat: reference, newest first, a page at a time**", async () => {
    const call = harness()
    const first = JSON.parse((await call(["chats", "list", "--limit", "2", "--json"])).stdout)
    expect(first.items.map((one: { ref: string }) => one.ref)).toEqual(["chat:chat/500/7", "chat:chat/500/8"])
    expect(first.page).toEqual({ mode: "page", limit: 2, has_more: true, next_page: 2 })
    expect(first.next[0]).toMatchObject({ step: "page.next", command: "chats list", args: { page: 2, limit: 2 } })
  })

  it("**refuses a filter the source cannot answer, before connecting**", async () => {
    const call = harness({
      chats: async () => {
        throw new Error("never asked")
      },
    })
    const refused = await call(["chats", "list", "kind:group", "--json"])
    expect(refused.code).toBe(2)
    const { error } = JSON.parse(refused.stderr)
    expect(error).toMatchObject({ reason: "query.unsupported-field", details: { supported: [] } })
  })
})
