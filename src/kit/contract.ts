import assert from "node:assert/strict"
import type { ErrorCode } from "@wirecat/cli-base"
import type { Chat, Id, Message } from "../domain/models.js"
import { isCliFailure } from "../errors/failures.js"
import { capability, type HistoryBatch, type MessengerAdapter, type ServerReads } from "../ports/messenger.js"
import { newSendId } from "../sends/send-id.js"
import { BUSY_PAGE, contractSeed, type IdMaker, type Seed, wordIds } from "./seed.js"

export interface ContractCase {
  name: string
  /** What the adapter's fake must do beyond holding the seed, where a case asks more of it. */
  needs?: string
  /** Throws an `AssertionError` on a broken promise; `skipped` names the optional method the adapter lacks. */
  run(): Promise<undefined | { skipped: string }>
}

export interface ContractOptions {
  /** A fresh adapter over `seed` — the CLI's own fake, filled from it. Called once for every case. */
  connect: (seed: Seed) => MessengerAdapter | Promise<MessengerAdapter>
  /** How the seed names things; non-digit `wordIds` unless the messenger's ids have a shape of their own. */
  ids?: IdMaker
  /** As the messenger's `fetching.orderBy`: whether `history`'s `before` is a message id or an ISO time. */
  orderBy?: "id" | "time"
  /** How long `watch` may take to say it listens, and to end once aborted. */
  waitMs?: number
  /** As the messenger's `history`: a `"server"` messenger's adapter must have every `ServerReads` method. */
  history?: "server" | "store"
}

const SERVER_READS = ["chats", "history", "around", "contact"] as const satisfies readonly (keyof ServerReads)[]

type Reading = MessengerAdapter & ServerReads

const serverReads = (adapter: MessengerAdapter): Reading | undefined =>
  SERVER_READS.every((method) => typeof adapter[method] === "function") ? (adapter as Reading) : undefined

const NO_SERVER_READS = { skipped: "the adapter has no server reads (chats, history, around, contact)" }

/** Every method of the optional groups, which `capability` hands over or refuses. */
export const OPTIONAL_METHODS = [
  "fetchCounters",
  ...SERVER_READS,
  "historyAfter",
  "historyBefore",
  "topics",
  "inspect",
  "edit",
  "forward",
  "delete",
  "pin",
  "unpin",
  "react",
  "markRead",
  "markTopicRead",
  "poll",
  "vote",
  "closePoll",
  "createPoll",
  "watch",
  "feed",
  "download",
  "transcribe",
  "scheduled",
  "members",
  "admins",
  "chatEvents",
  "sessions",
  "lookup",
  "addressBook",
  "people",
  "createGroup",
  "join",
  "leave",
  "group",
  "updateGroup",
  "resetInviteLink",
  "addMembers",
  "removeMembers",
  "addAdmin",
  "removeAdmin",
  "folders",
  "createFolder",
  "updateFolder",
  "deleteFolder",
  "addContact",
  "removeContact",
  "block",
  "unblock",
  "renameContact",
  "importContacts",
  "updateProfile",
  "endOtherSessions",
] as const satisfies readonly (keyof MessengerAdapter)[]

const refuses = async (work: Promise<unknown>, code?: ErrorCode): Promise<void> => {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(isCliFailure(error), `expected a CliError with a code from the closed list, got ${String(error)}`)
    if (code) assert.equal(error.code, code)
    return true
  })
}

const within = async (work: Promise<unknown>, failure: string, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `${failure} within ${ms}ms` })), ms)
  })
  try {
    await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

const idsOf = (messages: Message[]) => messages.map((message) => message.id)

/** Every `id`, `chatId` and `senderId` anywhere in `value`, so a number among them is caught. */
const everyId = (value: unknown, found: unknown[] = []): unknown[] => {
  if (Array.isArray(value)) for (const item of value) everyId(item, found)
  else if (value && typeof value === "object")
    for (const [key, field] of Object.entries(value)) {
      if (["id", "chatId", "senderId"].includes(key) && field !== null) found.push(field)
      else if (key !== "providerMetadata") everyId(field, found)
    }
  return found
}

/**
 * The port's promises as cases any test runner can run: each connects through `connect`, checks
 * with `node:assert/strict` and closes the adapter. None needs a live service.
 *
 * ```ts
 * for (const one of contractCases({ connect: (seed) => myAdapter(fakeClientFrom(seed)) }))
 *   it(one.name, async (context) => {
 *     const result = await one.run()
 *     if (result) context.skip(result.skipped)
 *   })
 * ```
 */
export const contractCases = ({
  connect,
  ids = wordIds,
  orderBy = "id",
  waitMs = 2_000,
  history = "server",
}: ContractOptions): ContractCase[] => {
  const seedOf = (loggedIn = true) => contractSeed({ ids, loggedIn })
  const busyOf = (seed: Seed) => seed.messages.filter((message) => message.chatId === seed.busy)
  const unknownChat = ids("chat", 99, new Date(0))
  const unknownMessage = ids("message", 999, new Date(Date.parse("2026-09-01T08:00:00.000Z")))

  const using =
    (body: (adapter: MessengerAdapter, seed: Seed) => Promise<undefined | { skipped: string }>, loggedIn = true) =>
    async () => {
      const seed = seedOf(loggedIn)
      const adapter = await connect(seed)
      try {
        return await body(adapter, seed)
      } finally {
        await adapter.close()
      }
    }
  const cases = (
    list: [
      name: string,
      body: (adapter: MessengerAdapter, seed: Seed) => Promise<undefined | { skipped: string }>,
      needs?: string,
    ][],
  ): ContractCase[] => list.map(([name, body, needs]) => ({ name, run: using(body), ...(needs ? { needs } : {}) }))
  const lacking = (adapter: MessengerAdapter, method: keyof MessengerAdapter) =>
    typeof adapter[method] === "function" ? undefined : { skipped: `the adapter has no ${method}` }
  const reading =
    (body: (adapter: Reading, seed: Seed) => Promise<undefined | { skipped: string }>) =>
    async (adapter: MessengerAdapter, seed: Seed) => {
      const server = serverReads(adapter)
      return server ? body(server, seed) : NO_SERVER_READS
    }

  return [
    ...(history === "server"
      ? [
          {
            name: "a messenger whose history is on the server has every server read",
            run: using(async (adapter) => {
              const missing = SERVER_READS.filter((method) => typeof adapter[method] !== "function")
              assert.deepEqual(missing, [], 'add them, or declare `history: "store"` on the Messenger')
              return undefined
            }),
          },
        ]
      : []),
    ...cases([
      [
        "self() names the logged-in account, and me() agrees",
        async (adapter, seed) => {
          assert.equal(adapter.self(), seed.account?.id)
          assert.equal((await adapter.me()).id, seed.account?.id)
        },
      ],
      [
        "chats pages by limit and offset and lists every chat once",
        reading(async (adapter, seed) => {
          const first = await adapter.chats({ limit: 2, offset: 0 })
          const rest = await adapter.chats({ limit: 10, offset: 2 })
          assert.equal(first.items.length, 2)
          assert.equal(first.hasMore, true)
          assert.equal(rest.hasMore, false)
          const listed = [...first.items, ...rest.items].map((chat) => chat.id)
          assert.deepEqual(listed.toSorted(), seed.chats.map((chat) => chat.id).toSorted())
        }),
      ],
      [
        "history answers the newest page, oldest first",
        reading(async (adapter, seed) => {
          const page = await adapter.history(seed.busy, { limit: BUSY_PAGE })
          assert.deepEqual(idsOf(page.items), idsOf(busyOf(seed).slice(-BUSY_PAGE)))
          assert.equal(page.hasMore, true)
        }),
      ],
      [
        "history pages back to hasMore: false and answers every message once",
        reading(async (adapter, seed) => {
          const pages: Message[][] = []
          let before: string | undefined
          for (let round = 0; round < 10; round += 1) {
            const page = await adapter.history(seed.busy, { limit: BUSY_PAGE, ...(before ? { before } : {}) })
            pages.unshift(page.items)
            const oldest = page.items[0]
            if (!page.hasMore || !oldest) break
            before = orderBy === "id" ? oldest.id : oldest.timestamp
          }
          assert.deepEqual(idsOf(pages.flat()), idsOf(busyOf(seed)))
        }),
      ],
      [
        "around answers a window oldest first, with one anchor on the message asked for",
        reading(async (adapter, seed) => {
          const busy = busyOf(seed)
          const middle = busy[5] as Message
          const window = await adapter.around(seed.busy, middle.id, { before: 2, after: 2 })
          assert.deepEqual(idsOf(window), idsOf(busy.slice(3, 8)))
          assert.deepEqual(
            window.filter((message) => message.anchor).map((message) => message.id),
            [middle.id],
          )
          const edge = await adapter.around(seed.busy, (busy[0] as Message).id, { before: 2, after: 1 })
          assert.deepEqual(idsOf(edge), idsOf(busy.slice(0, 2)))
        }),
      ],
      [
        "around refuses a message the chat does not have with not_found",
        reading(async (adapter, seed) => {
          await refuses(adapter.around(seed.busy, unknownMessage, { before: 1, after: 1 }), "not_found")
        }),
      ],
      [
        "resolve finds a chat by its id and by a title only it has",
        async (adapter, seed) => {
          assert.equal((await adapter.resolve(seed.busy)).id, seed.busy)
          const title = seed.chats.find((chat) => chat.id === seed.busy)?.title as string
          assert.equal((await adapter.resolve(title)).id, seed.busy)
        },
      ],
      [
        "resolve refuses a title two chats share with validation_error, never picks one",
        async (adapter, seed) => {
          await refuses(adapter.resolve(seed.twins), "validation_error")
        },
      ],
      [
        "resolve refuses a chat that does not exist with not_found, or takes its id as a chat of kind unknown",
        // A messenger may take an id without connecting, so a write its guard refuses never logs in first (max-cli).
        // It may not answer another chat, or invent a title.
        async (adapter) => {
          let chat: Chat
          try {
            chat = await adapter.resolve(unknownChat)
          } catch (error) {
            assert.ok(isCliFailure(error), `expected a CliError with a code from the closed list, got ${String(error)}`)
            assert.equal(error.code, "not_found")
            return
          }
          assert.deepEqual(
            { id: chat.id, kind: chat.kind, title: chat.title },
            { id: unknownChat, kind: "unknown", title: null },
          )
        },
      ],
      [
        "a read of a chat that does not exist fails with a code from the closed list, not a library error",
        async (adapter) => {
          await refuses(adapter.chat(unknownChat))
          const server = serverReads(adapter)
          if (server) await refuses(server.history(unknownChat, { limit: 1 }))
        },
      ],
      [
        "chat answers the chat and who is in it",
        async (adapter, seed) => {
          const card = await adapter.chat(seed.busy)
          assert.equal(card.id, seed.busy)
          assert.ok(card.members?.some((member) => member.id === seed.person))
        },
      ],
      [
        "contact answers a person with the chats shared with them, and refuses a group",
        reading(async (adapter, seed) => {
          const card = await adapter.contact(seed.person)
          assert.equal(card.id, seed.person)
          assert.ok(card.chats.some((chat) => chat.id === seed.dialog))
          await refuses(adapter.contact(seed.busy))
        }),
      ],
      [
        "send answers the message sent and the send id it was given",
        async (adapter, seed) => {
          const sendId = adapter.newSendId?.() ?? newSendId()
          const sent = await adapter.send(seed.dialog, "see you there", { sendId })
          assert.equal(sent.sendId, sendId)
          assert.equal(sent.message.chatId, seed.dialog)
          assert.equal(sent.message.text, "see you there")
          const server = serverReads(adapter)
          if (!server) return
          const newest = await server.history(seed.dialog, { limit: 1 })
          assert.deepEqual(idsOf(newest.items), [sent.message.id])
        },
        "the fake keeps what was sent, so history answers it",
      ],
      [
        "ids are strings in everything the reads answer",
        async (adapter, seed) => {
          const server = serverReads(adapter)
          const answers = [
            await adapter.me(),
            await adapter.resolve(seed.dialog),
            await adapter.chat(seed.busy),
            ...(server
              ? [
                  await server.chats({ offset: 0 }),
                  await server.history(seed.busy, { limit: 20 }),
                  await server.around(seed.busy, (busyOf(seed)[1] as Message).id, { before: 1, after: 1 }),
                  await server.contact(seed.person),
                ]
              : []),
          ]
          const notStrings = everyId(answers).filter((id) => typeof id !== "string")
          assert.deepEqual(notStrings, [])
        },
      ],
      [
        "reads change nothing: chats and history answer the same after every read",
        reading(async (adapter, seed) => {
          const look = async () => ({
            chats: await adapter.chats({ offset: 0 }),
            busy: await adapter.history(seed.busy, { limit: 20 }),
            dialog: await adapter.history(seed.dialog, { limit: 20 }),
          })
          const before = await look()
          await adapter.me()
          await adapter.resolve(seed.dialog)
          await adapter.chat(seed.dialog)
          await adapter.contact(seed.person)
          await adapter.around(seed.dialog, (before.dialog.items[0] as Message).id, { before: 1, after: 1 })
          const time = Date.parse(seed.messages[0]?.timestamp ?? "")
          await adapter.historyAfter?.(seed.dialog, { limit: 5, after: { time } })
          await adapter.historyBefore?.(seed.dialog, { limit: 5, time: Date.now() })
          const stable = (value: unknown): unknown =>
            JSON.parse(
              JSON.stringify(value, (key, field: unknown) => {
                if (key !== "counterObservations" || field === null || typeof field !== "object") return field
                return Object.fromEntries(
                  Object.entries(field).map(([counter, observation]) => {
                    const { observedAt: _time, ...facts } = observation as Record<string, unknown>
                    return [counter, facts]
                  }),
                )
              }),
            )
          assert.deepEqual(stable(await look()), stable(before))
        }),
      ],
      [
        "capability() hands over each optional method the adapter has and refuses each it lacks",
        async (adapter) => {
          for (const method of OPTIONAL_METHODS) {
            const value = adapter[method] as unknown
            assert.ok(value === undefined || typeof value === "function", `${method} is neither a method nor absent`)
            if (typeof value === "function") assert.equal(typeof capability(adapter, method, method), "function")
            else assert.throws(() => capability(adapter, method, method), { code: "validation_error" })
          }
        },
      ],
      [
        "historyAfter answers the oldest newer than a message or a moment, oldest first, and ends on an empty page",
        async (adapter, seed) => {
          const skipped = lacking(adapter, "historyAfter")
          if (skipped) return skipped
          const busy = busyOf(seed)
          const after = busy[2] as Message
          const byId = await adapter.historyAfter?.(seed.busy, { limit: 3, after: { id: after.id } })
          assert.deepEqual(idsOf(byId?.items ?? []), idsOf(busy.slice(3, 6)))
          assert.equal(byId?.hasMore, true)
          const byTime = await adapter.historyAfter?.(seed.busy, {
            limit: 20,
            after: { time: Date.parse(after.timestamp) },
          })
          assert.deepEqual(idsOf(byTime?.items ?? []), idsOf(busy.slice(3)))
          // A short page proves no end (Telegram drops deleted messages from one); only an empty one does.
          const newest = busy.at(-1) as Message
          const past = await adapter.historyAfter?.(seed.busy, { limit: 20, after: { id: newest.id } })
          assert.deepEqual(past?.items, [])
          assert.equal(past?.hasMore, false)
        },
      ],
      [
        "historyBefore answers the newest sent before a moment, oldest first",
        async (adapter, seed) => {
          const skipped = lacking(adapter, "historyBefore")
          if (skipped) return skipped
          const busy = busyOf(seed)
          const time = Date.parse((busy[5] as Message).timestamp)
          const page = await adapter.historyBefore?.(seed.busy, { limit: 2, time })
          assert.deepEqual(idsOf(page?.items ?? []), idsOf(busy.slice(3, 5)))
          assert.equal(page?.hasMore, true)
        },
      ],
      [
        "watch calls onReady once listening and ends when the signal aborts",
        async (adapter) => {
          const skipped = lacking(adapter, "watch")
          if (skipped) return skipped
          const controller = new AbortController()
          let ready = () => {}
          const listening = new Promise<void>((resolve) => {
            ready = resolve
          })
          const watching = adapter.watch?.(() => {}, controller.signal, ready)
          await within(listening, "watch never called onReady", waitMs)
          controller.abort()
          await within(Promise.resolve(watching), "watch did not end when the signal aborted", waitMs)
        },
        "`connect` opens a connection that listens, as `{ listen: true }` does",
      ],
      [
        "feed pushes only the seed's chats and messages, with ids as strings, and ends when the signal aborts",
        async (adapter, seed) => {
          const skipped = lacking(adapter, "feed")
          if (skipped) return skipped
          const controller = new AbortController()
          const batches: HistoryBatch[] = []
          let pushed = () => {}
          const first = new Promise<void>((resolve) => {
            pushed = resolve
          })
          const feeding = adapter.feed?.((batch) => {
            batches.push(batch)
            pushed()
          }, controller.signal)
          await within(first, "feed pushed nothing", waitMs)
          controller.abort()
          await within(Promise.resolve(feeding), "feed did not end when the signal aborted", waitMs)
          const chats = new Set(seed.chats.map((chat) => chat.id))
          const messages = new Set(seed.messages.map((message) => `${message.chatId}/${message.id}`))
          for (const batch of batches) {
            for (const chat of batch.chats ?? []) assert.ok(chats.has(chat.id), `chat ${chat.id} is not in the seed`)
            for (const message of batch.messages ?? [])
              assert.ok(messages.has(`${message.chatId}/${message.id}`), `message ${message.id} is not in the seed`)
          }
          assert.deepEqual(
            everyId(batches).filter((id) => typeof id !== "string"),
            [],
            "every id is a string",
          )
        },
        "the fake pushes the seed's history once connected, as `fakeAdapter(seed, { feed: true })` does",
      ],
    ]),
    {
      name: "self() is null before a login",
      needs: "the fake as a profile that never logged in: `seed.account` is null",
      run: using(async (adapter) => {
        assert.equal(adapter.self(), null)
      }, false),
    },
    {
      name: "a repeated send id leaves one message",
      needs: "the fake drops a repeat of a send id, as the messenger's server does",
      run: using(
        reading(async (adapter, seed) => {
          const sendId = adapter.newSendId?.() ?? newSendId()
          const first = await adapter.send(seed.dialog, "only once", { sendId })
          const again = await adapter.send(seed.dialog, "only once", { sendId })
          assert.equal(again.message.id, first.message.id)
          const after = await adapter.history(seed.dialog, { limit: 20 })
          assert.equal(after.items.filter((message) => message.text === "only once").length, 1)
        }),
      ),
    },
    ...(orderBy === "id"
      ? [
          {
            name: "a messenger whose store pages by id answers whole-number ids within 2^53",
            run: using(
              reading(async (adapter, seed) => {
                const page = await adapter.history(seed.busy, { limit: 20 })
                const unsafe = page.items
                  .map((message): Id => message.id)
                  .filter((id) => !/^-?\d+$/.test(id) || !Number.isSafeInteger(Number(id)))
                assert.deepEqual(unsafe, [], "page by time (`fetching.orderBy`) or give whole-number ids")
              }),
            ),
          },
        ]
      : []),
  ]
}
