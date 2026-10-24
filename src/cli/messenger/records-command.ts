import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import {
  type Audience,
  MEDIA_KINDS,
  type MediaKind,
  type PrivacyKey,
  type PrivacySettings,
} from "../../domain/models.js"
import { sendTime } from "../../domain/send-time.js"
import { capability } from "../../ports/messenger.js"
import type { Services } from "../../services/index.js"
import { ownerOnlyOption, REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { CALLS_QUERY, STICKERS_QUERY } from "./list-result-queries.js"

const kindsOf = (typed: string | undefined): MediaKind[] => {
  const kinds = typed === undefined ? [...MEDIA_KINDS] : typed.split(",").map((kind) => kind.trim())
  for (const kind of kinds) {
    if (!(MEDIA_KINDS as readonly string[]).includes(kind))
      throw new CliError("validation_error", `--type takes ${MEDIA_KINDS.join(", ")}, not "${kind}"`)
  }
  return kinds as MediaKind[]
}

/** `chats media` — what a chat's gallery shows, asked of the server, so it finds what was never fetched. */
export const mediaCommand = (messenger: Messenger): Command =>
  annotate(new Command("media"), { effects: REMOTE_READ })
    .description("a chat's photos, videos, files, audio and links, from the messenger's server; reading marks nothing")
    .argument("<chat>", messenger.chatArgument)
    .option("--type <names>", `only these kinds, comma-separated: ${MEDIA_KINDS.join(", ")}`)
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--cursor <cursor>", "go on from where page.next says the last page stopped")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { type, cursor } = this.opts<{ type?: string; cursor?: string }>()
      const kinds = kindsOf(type)
      const limit = context.settings.limit
      const page = await context.withMessenger(async (adapter) => {
        const { id } = await adapter.resolve(chat)
        return capability(
          adapter,
          "media",
          "list a chat's media",
        )(id, {
          kinds,
          limit,
          ...(cursor === undefined ? {} : { before: cursor }),
        })
      })
      const oldest = page.items[0]?.id
      renderAnswer(
        this,
        context,
        listOf("chats media", {
          items: page.items.map(snakeKeys),
          limit,
          has_more: page.hasMore && oldest !== undefined,
          paging: "cursor",
          ...(oldest === undefined ? {} : { cursor: oldest }),
          args: { chat, ...(type === undefined ? {} : { type }) },
        }),
      )
    })

/** `stickers list` — the sets the account added, or one set's stickers with the ids `messages send --sticker` takes. */
export const stickersCommand = (messenger: Messenger): Command => {
  const stickers = new Command("stickers").description("the stickers the account has added")
  withQuery(
    annotate(stickers.command("list"), {
      effects: REMOTE_READ,
      examples: [`${messenger.app.command} personal stickers list`],
    }),
    STICKERS_QUERY,
  )
    .description("sticker sets, or with --set the stickers in one; reading changes nothing")
    .option("--set <id>", "the stickers in this set")
    .action(async function (this: Command, words: string[]) {
      listQuery(typedQuery(words), STICKERS_QUERY, "stickers list")
      const context = messengerContext(this, messenger)
      const { set } = this.opts<{ set?: string }>()
      const items = await context.withMessenger(
        (adapter): Promise<readonly unknown[]> =>
          set === undefined
            ? capability(adapter, "stickerSets", "list sticker sets")()
            : capability(adapter, "stickers", "list stickers")(set),
      )
      renderAnswer(
        this,
        context,
        listOf("stickers list", {
          items: items.map(snakeKeys),
          limit: Math.max(1, items.length),
          has_more: false,
        }),
      )
    })
  return stickers
}

/** `calls list` — the account's call history, newest first. */
export const callsCommand = (messenger: Messenger): Command => {
  const calls = new Command("calls").description("the account's calls")
  withQuery(
    annotate(calls.command("list"), {
      effects: REMOTE_READ,
      examples: [`${messenger.app.command} personal calls list`],
    }),
    CALLS_QUERY,
  )
    .description("calls made and received, newest first; reading changes nothing")
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .action(async function (this: Command, words: string[]) {
      listQuery(typedQuery(words), CALLS_QUERY, "calls list")
      const context = messengerContext(this, messenger)
      const limit = context.settings.limit
      const page = await context.withMessenger((adapter) => capability(adapter, "calls", "list calls")({ limit }))
      renderAnswer(
        this,
        context,
        listOf("calls list", { items: page.items.map(snakeKeys), limit, has_more: page.hasMore }),
      )
    })
  return calls
}

/** `chats delete` and `chats clear` — for this account only; at the default level they ask first. */
export const chatDeletionCommands = (messenger: Messenger): Command[] => [
  annotate(new Command("delete"), {
    output: { entity: "chat_removal" },
    effects: REMOTE_WRITE,
    examples: [`${messenger.app.command} personal chats delete "Book club"`],
  })
    .description("delete a chat from this account; the others in it keep it and its messages")
    .argument("<chat>", messenger.chatArgument)
    .addOption(
      ownerOnlyOption("--allow-dangerous", "go ahead without the question an ask level puts before a deletion"),
    )
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.admin.deleteChat(chat)))),
      )
    }),
  annotate(new Command("clear"), {
    output: { entity: "chat_removal" },
    effects: REMOTE_WRITE,
    examples: [`${messenger.app.command} personal chats clear "Book club"`],
  })
    .description("delete every message in a chat for this account; the others in it keep theirs")
    .argument("<chat>", messenger.chatArgument)
    .addOption(
      ownerOnlyOption("--allow-dangerous", "go ahead without the question an ask level puts before a deletion"),
    )
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.admin.clearHistory(chat)))),
      )
    }),
]

/** `chats mute` and `unmute` — the owner's own notifications for one chat; nobody in it is told. */
export const muteCommands = (messenger: Messenger): Command[] => [
  annotate(new Command("mute"), {
    output: { entity: "chat_muting" },
    effects: REMOTE_WRITE,
    examples: [
      `${messenger.app.command} chats mute "Book club"`,
      `${messenger.app.command} chats mute "Book club" --until 2h`,
    ],
  })
    .description("stop notifications from a chat, for good or until a time; nobody in it is told")
    .argument("<chat>", messenger.chatArgument)
    .option("--until <time>", "only until then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d from now")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { until } = this.opts<{ until?: string }>()
      const when = until === undefined ? "forever" : sendTime(until, Date.now(), "--until")
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.account.mute(chat, when)))),
      )
    }),
  annotate(new Command("unmute"), {
    output: { entity: "chat_muting" },
    effects: REMOTE_WRITE,
    examples: [`${messenger.app.command} chats unmute "Book club"`],
  })
    .description("hear a muted chat again")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.account.mute(chat, null)))),
      )
    }),
]

const onChatCommand = (
  messenger: Messenger,
  name: string,
  description: string,
  entity: "chat_archive" | "chat_pin" | "chat_unread",
  change: (services: Services, chat: string) => Promise<object>,
): Command =>
  annotate(new Command(name), {
    output: { entity },
    effects: REMOTE_WRITE,
    examples: [`${messenger.app.command} chats ${name} 123456789`],
  })
    .description(description)
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(this, context, itemOf(snakeKeys(await context.withServices((services) => change(services, chat)))))
    })

/** `chats archive` and `unarchive` — the messenger's archive of chats, not the local store. */
export const archiveCommands = (messenger: Messenger): Command[] => [
  onChatCommand(
    messenger,
    "archive",
    "move a chat into the archive; nobody in it is told",
    "chat_archive",
    (services, chat) => services.account.archive(chat, true),
  ),
  onChatCommand(
    messenger,
    "unarchive",
    "bring an archived chat back to the chat list",
    "chat_archive",
    (services, chat) => services.account.archive(chat, false),
  ),
]

/** `chats pin` and `unpin` — where the chat sits in the owner's list; `messages pin` pins a message for everyone. */
export const chatPinCommands = (messenger: Messenger): Command[] => [
  onChatCommand(
    messenger,
    "pin",
    "keep a chat at the top of your chat list; nobody in it is told",
    "chat_pin",
    (services, chat) => services.account.pinChat(chat, true),
  ),
  onChatCommand(messenger, "unpin", "let a pinned chat move down the chat list again", "chat_pin", (services, chat) =>
    services.account.pinChat(chat, false),
  ),
]

/** `chats mark-unread` — undone by `chats mark-read`, which the other side does see. */
export const markUnreadCommand = (messenger: Messenger): Command =>
  onChatCommand(
    messenger,
    "mark-unread",
    "mark a chat unread on your own devices; nobody in it is told",
    "chat_unread",
    (services, chat) => services.account.markUnread(chat),
  )

const AUDIENCES: readonly Audience[] = ["everyone", "contacts", "nobody"]

const audienceOf = (flag: string, value: string): Audience => {
  if (!(AUDIENCES as readonly string[]).includes(value))
    throw new CliError("validation_error", `${flag} takes ${AUDIENCES.join(", ")}, not "${value}"`)
  return value as Audience
}

const PRIVACY_SETTINGS: readonly PrivacyKey[] = ["findByPhone", "phoneNumber", "calls", "chatInvites", "hideOnline"]

const SWITCHES: ReadonlySet<PrivacyKey> = new Set(["hideOnline", "readReceipts"])

const PRIVACY_FLAGS: Record<PrivacyKey, [flag: string, help: string]> = {
  findByPhone: ["find-by-phone", "who finds the account by its number: everyone, contacts or nobody"],
  phoneNumber: ["phone-number", "who sees the number: everyone, contacts or nobody"],
  calls: ["calls", "whose calls ring: everyone, contacts or nobody"],
  chatInvites: ["chat-invites", "who may add the account to groups and channels: everyone, contacts or nobody"],
  hideOnline: ["hide-online", "hide online status and last seen"],
  readReceipts: ["read-receipts", "send read receipts"],
  profilePhoto: ["profile-photo", "who sees the profile photo: everyone, contacts or nobody"],
  about: ["about-text", "who sees the about text: everyone, contacts or nobody"],
  lastSeen: ["last-seen", "who sees when the account was last online: everyone, contacts or nobody"],
}

const optionKey = (key: PrivacyKey) =>
  PRIVACY_FLAGS[key][0].replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())

const privacyChange = (keys: readonly PrivacyKey[], typed: Record<string, string | undefined>): PrivacySettings => {
  const change: Record<string, Audience | boolean> = {}
  for (const key of keys) {
    const value = typed[optionKey(key)]
    if (value === undefined) continue
    const flag = `--${PRIVACY_FLAGS[key][0]}`
    if (!SWITCHES.has(key)) {
      change[key] = audienceOf(flag, value)
      continue
    }
    if (value !== "on" && value !== "off")
      throw new CliError("validation_error", `${flag} takes on or off, not "${value}"`)
    change[key] = value === "on"
  }
  return change as PrivacySettings
}

const exampleOf = (tool: string, key: PrivacyKey) =>
  `${tool} account privacy set --${PRIVACY_FLAGS[key][0]} ${SWITCHES.has(key) ? "on" : "contacts"}`

/** `account privacy` — who may find, call or invite the account, as the messenger reports it. */
export const privacyCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
  const keys = messenger.privacySettings ?? PRIVACY_SETTINGS
  const privacy = new Command("privacy").description("who may find, call or add the account")
  annotate(privacy.command("show"), {
    output: { entity: "account_privacy" },
    effects: REMOTE_READ,
    examples: [`${tool} account privacy show`, `${tool} account privacy show --json`],
  })
    .description("the account's privacy settings; reading changes nothing")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const privacy = await context.withMessenger((adapter) =>
        capability(adapter, "privacy", "read privacy settings")(),
      )
      renderAnswer(this, context, itemOf(snakeKeys(privacy)))
    })
  const audience = keys.find((key) => !SWITCHES.has(key))
  const toggle = keys.find((key) => SWITCHES.has(key))
  const set = annotate(new Command("set"), {
    output: { entity: "account_privacy_change" },
    effects: REMOTE_WRITE,
    examples: [audience, toggle].flatMap((key) => (key === undefined ? [] : [exampleOf(tool, key)])),
  }).description("change who may find, call or add the account; the settings not named stay")
  for (const key of keys)
    set.option(`--${PRIVACY_FLAGS[key][0]} ${SWITCHES.has(key) ? "<on|off>" : "<who>"}`, PRIVACY_FLAGS[key][1])
  privacy.addCommand(
    set.action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const change = privacyChange(keys, this.opts<Record<string, string | undefined>>())
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.account.updatePrivacy(change)))),
      )
    }),
  )
  return privacy
}
