import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import type { Chat, Message } from "../../domain/models.js"
import { accountHome, inOwnerFolder, storePath } from "../../store/path.js"
import { type AccountKey, type MessageStore, openStore } from "../../store/store.js"
import { changesStore, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { accountFileFor, recalledAccount, rememberAccount } from "./accounts.js"
import { type Messenger, messengerContext } from "./context.js"
import { fill } from "./stored.js"

const id = v.pipe(v.string(), v.nonEmpty())
const time = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.transform((at) => new Date(at).toISOString()),
)
const name = v.nullish(v.string(), null)

const person = v.object({ id, name, username: name })

/** The adapter kit's `Seed` (`src/kit/seed.ts`) as a file: what a sync would have read, with the defaults filled in. */
const importFile = v.object({
  synthetic: v.literal(true),
  account: person,
  people: v.optional(v.array(person), []),
  chats: v.array(
    v.object({
      id,
      title: name,
      kind: v.picklist(["dialog", "group", "channel", "saved", "unknown"]),
      unreadCount: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0)), null),
      lastMessageAt: v.nullish(time, null),
      participantsCount: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0)), null),
    }),
  ),
  members: v.optional(v.record(v.string(), v.array(person)), {}),
  messages: v.optional(
    v.array(
      v.object({
        id,
        chatId: id,
        senderId: v.nullish(id, null),
        senderName: name,
        timestamp: time,
        editedAt: v.nullish(time, null),
        text: v.string(),
        outgoing: v.optional(v.boolean()),
        replyToId: v.optional(id),
      }),
    ),
    [],
  ),
})

type ImportFile = v.InferOutput<typeof importFile>

const readImport = (path: string): ImportFile => {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // The parser's message quotes the file, which may be anything its caller can read.
    throw new CliError("validation_error", `cannot read ${path} as JSON`)
  }
  if ((raw as { synthetic?: unknown } | null)?.synthetic !== true)
    throw new CliError(
      "validation_error",
      `${path} does not say "synthetic": true — store import loads made-up test data only, never a real account's`,
    )
  const parsed = v.safeParse(importFile, raw)
  if (!parsed.success) {
    const issue = parsed.issues[0]
    const at = v.getDotPath(issue) ?? "the file"
    throw new CliError("validation_error", `${path}: ${at}: expected ${issue.expected ?? "another value"}`)
  }
  const file = parsed.output
  const chats = new Set(file.chats.map((chat) => chat.id))
  for (const message of file.messages)
    if (!chats.has(message.chatId))
      throw new CliError(
        "validation_error",
        `${path}: message ${message.id} names chat ${message.chatId}, not in chats`,
      )
  for (const chatId of Object.keys(file.members))
    if (!chats.has(chatId)) throw new CliError("validation_error", `${path}: members name chat ${chatId}, not in chats`)
  return file
}

const messagesOf = (file: ImportFile): Message[] =>
  file.messages.map(({ outgoing, ...message }) => ({
    ...message,
    outgoing: outgoing === undefined ? message.senderId === file.account.id : outgoing,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }))

/** A chat's newest message stands in for its `lastMessageAt` when the file leaves it out, as a chat list would say. */
const chatsOf = (file: ImportFile, messages: Message[]): Chat[] => {
  const newest = new Map<string, string>()
  for (const { chatId, timestamp } of messages)
    if ((newest.get(chatId) ?? "") < timestamp) newest.set(chatId, timestamp)
  return file.chats.map((chat) => ({ ...chat, lastMessageAt: chat.lastMessageAt ?? newest.get(chat.id) ?? null }))
}

const heldCounts = async (store: MessageStore, key: AccountKey) => ({
  chats: await store.chats.countChats(key),
  messages: (await store.chats.chatStats(key)).reduce((sum, chat) => sum + chat.messages, 0),
})

const refuseOwnerFolders = (messenger: Messenger, profile: string, env: NodeJS.ProcessEnv, target: string) => {
  const home = accountHome()
  const ownState =
    home !== undefined &&
    accountFileFor(messenger.app, profile, env) === accountFileFor(messenger.app, profile, { HOME: home })
  if (!inOwnerFolder(target, home) && !ownState) return
  throw new CliError(
    "permission_error",
    `store import writes made-up data, and ${ownState ? `profile ${profile}'s state` : target} is the owner's real ` +
      "one — run it in a sandbox (WireCat Desktop's bin/sandbox), with HOME, MESSAGING_STORE and the tool's state " +
      "folder of its own",
  )
}

/** `store import` — made-up chats, people and messages into a test or sandbox store, through the sync's own writes. */
export const storeImportCommand = (messenger: Messenger): Command =>
  changesStore(
    annotate(new Command("import"), { output: { entity: "store_import" }, effects: LOCAL_WRITE })
      .summary("load made-up chats, people and messages from a file into a test or sandbox store")
      .description(
        'load a JSON file marked "synthetic": true (account, people, chats, members, messages) into this profile\'s ' +
          "account in the local store, as a sync would save them; the same file twice adds nothing and a changed " +
          "message is updated in place. Refuses the owner's real store. Without --yes, says what it would load and " +
          "changes nothing",
      )
      .argument("<file>", "the JSON file to load")
      .action(async function (this: Command, path: string) {
        const context = messengerContext(this, messenger)
        const { profile, env } = context
        const { command } = messenger.app
        const file = readImport(path)
        const target = storePath(env)
        refuseOwnerFolders(messenger, profile, env, target)
        if (!context.settings.profilesHere.includes(profile))
          throw new CliError(
            "not_found",
            `no profile named "${profile}" — make it first with \`${command} ${profile} config set …\``,
          )
        const key: AccountKey = { provider: messenger.provider, account: file.account.id }
        const remembered = recalledAccount(messenger.app, messenger.provider, profile, env)
        if (remembered && remembered.account !== key.account)
          throw new CliError(
            "validation_error",
            `profile ${profile} is account ${remembered.account}, and ${path} is account ${key.account} — ` +
              "import it into a profile of its own",
          )
        const messages = messagesOf(file)
        const chats = chatsOf(file, messages)
        const people = [...file.people, ...Object.values(file.members).flat()]
        // Over MCP an `ask` write goes ahead (NEED-773): nobody is there to add --yes.
        const yes = this.optsWithGlobals<{ yes?: boolean }>().yes === true || context.agent
        const planned = {
          store: target,
          profile,
          account: key.account,
          file: { chats: chats.length, people: new Set(people.map((one) => one.id)).size, messages: messages.length },
        }
        if (!yes) {
          context.renderer.note(
            `would load ${messages.length} messages in ${chats.length} chats into ${target} as profile ${profile} ` +
              `(account ${key.account}); nothing changed — add --yes to load them`,
          )
          renderAnswer(this, context, itemOf(snakeKeys({ ...planned, imported: false })))
          return
        }
        const answer = await context.run(async () => {
          const store = await openStore({ env, command, version: messenger.app.version })
          try {
            const mapped = (await store.accounts.profiles())[command]?.[profile]
            if (mapped && (mapped.provider !== key.provider || mapped.account !== key.account))
              throw new CliError(
                "validation_error",
                `the store has profile ${profile} as account ${mapped.account}, and ${path} is account ` +
                  `${key.account} — import it into a profile of its own`,
              )
            const before = await heldCounts(store, key)
            await store.accounts.saveAccount(key, { name: file.account.name })
            await store.accounts.saveProfile(command, profile, key)
            rememberAccount(messenger.app, profile, key.account, env)
            await store.people.savePeople(key, [file.account, ...people])
            await fill(store, key, { chats, messages })
            for (const [chatId, members] of Object.entries(file.members))
              await store.roster.saveMembers(
                key,
                chatId,
                members.map((member) => member.id),
              )
            const after = await heldCounts(store, key)
            return {
              ...planned,
              imported: true,
              added: { chats: after.chats - before.chats, messages: after.messages - before.messages },
            }
          } finally {
            await store.close()
          }
        })
        renderAnswer(this, context, itemOf(snakeKeys(answer)))
      }),
  )
