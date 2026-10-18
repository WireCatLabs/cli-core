import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { parseDuration } from "../../domain/duration.js"
import {
  ADMIN_RIGHTS,
  type AdminRight,
  GROUP_SETTINGS,
  type GroupChange,
  type GroupSettingKey,
} from "../../domain/models.js"
import { readUpload, typesText } from "../../sends/upload.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { lines, renderItem, withPage } from "./chat-answers.js"
import { inviteLinks, joinRequests } from "./chat-lists.js"
import { LINKS_QUERY, REQUESTS_QUERY } from "./chat-queries.js"
import { type Messenger, messengerContext } from "./context.js"

const SETTING_FLAGS: Record<GroupSettingKey, [flag: string, help: string]> = {
  allCanPin: ["all-can-pin <on|off>", "every member may pin messages"],
  onlyAdminsAdd: ["only-admins-add <on|off>", "only admins may add members"],
  onlyAdminsCall: ["only-admins-call <on|off>", "only admins may start a call"],
  onlyOwnerEditsInfo: ["only-owner-edits-info <on|off>", "only the owner may change the name and photo"],
  membersSeeLink: ["members-see-link <on|off>", "members may see the invite link"],
  joinApproval: ["join-approval <on|off>", "people ask to join, and an admin lets them in"],
  onlyAdminsSend: ["only-admins-send <on|off>", "only admins may send messages"],
  onlyAdminsEditInfo: ["only-admins-edit-info <on|off>", "only admins may change the name, photo and description"],
  disappearingSeconds: [
    "disappear-time <duration|off>",
    "new messages disappear this long after sending: 24h, 7d, 90d; off keeps them",
  ],
}

const flagOf = (key: GroupSettingKey) => `--${SETTING_FLAGS[key][0].split(" ")[0]}`

/** Where commander puts the flag's value: `--disappear-time` is `disappearTime`, not the setting's own name. */
const optionKey = (key: GroupSettingKey) =>
  flagOf(key)
    .slice(2)
    .replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())

const settingsOf = (
  keys: readonly GroupSettingKey[],
  options: Record<string, unknown>,
): NonNullable<GroupChange["settings"]> => {
  const changes: NonNullable<GroupChange["settings"]> = {}
  for (const key of keys) {
    const value = options[optionKey(key)]
    if (value === undefined) continue
    if (key === "disappearingSeconds") {
      changes[key] = value === "off" ? 0 : Math.round(parseDuration(String(value), flagOf(key)) / 1000)
      continue
    }
    if (value !== "on" && value !== "off") {
      throw new CliError("validation_error", `${flagOf(key)} takes on or off, not "${String(value)}"`)
    }
    changes[key] = value === "on"
  }
  return changes
}

/** How `--photo` describes the file a profile or group photo takes: the messenger's types, where it names them. */
export const photoHelp = ({ profilePhotoTypes }: Messenger): string =>
  profilePhotoTypes === undefined ? "an image file" : `a ${typesText(profilePhotoTypes)} file`

export const readProfilePhoto = (messenger: Messenger, path: string, env: NodeJS.ProcessEnv) =>
  readUpload("photo", path, {
    app: messenger.app,
    env,
    ...(messenger.profilePhotoTypes === undefined ? {} : { photoTypes: messenger.profilePhotoTypes }),
  })

const updateCommand = (messenger: Messenger): Command => {
  const keys = messenger.groupSettings ?? GROUP_SETTINGS
  const update = annotate(new Command("update"), { effects: REMOTE_WRITE })
    .description("rename a group or channel, change its description, or turn one of its settings on or off")
    .argument("<chat>", messenger.chatArgument)
    .option("--title <title>", "the new name")
    .option("--description <text>", "the new description")
  if (messenger.groupPhoto === true) update.option("--photo <file>", `a new photo for it — ${photoHelp(messenger)}`)
  if (messenger.groupPhotoRemoval === true) update.option("--remove-photo", "take its photo away; not with --photo")
  for (const key of keys) update.option(`--${SETTING_FLAGS[key][0]}`, SETTING_FLAGS[key][1])
  return update.action(async function (this: Command, chat: string) {
    const context = messengerContext(this, messenger)
    const { title, description, photo, removePhoto, ...rest } = this.opts<{
      title?: string
      description?: string
      photo?: string
      removePhoto?: boolean
    }>()
    const settings = settingsOf(keys, rest)
    const upload = photo === undefined ? undefined : await readProfilePhoto(messenger, photo, context.env)
    renderItem(
      this,
      context,
      await context.withServices((services) =>
        services.admin.update(chat, {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(upload === undefined ? {} : { photo: upload }),
          ...(removePhoto === true ? { removePhoto: true } : {}),
        }),
      ),
    )
  })
}

const linkCommand = (messenger: Messenger): Command => {
  const link = new Command("link").description("a group's invite link")
  annotate(link.command("show"), { effects: REMOTE_READ })
    .description("the invite link, if you may see it")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderItem(this, context, await context.withServices((services) => services.admin.link(chat)))
    })
  if (messenger.inviteLinkCreate !== false)
    link.addCommand(
      annotate(new Command("create"), { effects: REMOTE_WRITE })
        .description("make another invite link; nobody is told until you share it")
        .argument("<chat>", messenger.chatArgument)
        .option("--approval", "who joins by it asks first, and an admin lets them in; it then has no use limit")
        .option("--expire-time <time>", "it stops working then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d from now")
        .option("--max-uses <n>", "at most this many people join by it, 1 to 99999", positiveCount("--max-uses"))
        .action(async function (this: Command, chat: string) {
          const context = messengerContext(this, messenger)
          const { approval, expireTime, maxUses } = this.opts<{
            approval?: boolean
            expireTime?: string
            maxUses?: number
          }>()
          renderItem(
            this,
            context,
            await context.withServices((services) =>
              services.admin.createLink(chat, {
                approval: approval === true,
                ...(expireTime === undefined ? {} : { expires: expireTime }),
                ...(maxUses === undefined ? {} : { maxUses }),
              }),
            ),
          )
        }),
    )
  if (messenger.inviteLinkList !== false)
    link.addCommand(
      withQuery(
        annotate(
          withPage(
            annotate(new Command("list"), { effects: REMOTE_READ })
              .description("your invite links, newest first, with how many joined and how many wait")
              .argument("<chat>", messenger.chatArgument),
          ),
          { output: { entity: "invite_link" } },
        ),
        LINKS_QUERY,
      ).action(async function (this: Command, chat: string, words: string[]) {
        const context = messengerContext(this, messenger)
        const body = await context.withServices((services) => inviteLinks(services, chat, words, context.settings))
        renderAnswer(
          this,
          context,
          body,
          lines(({ link, approval, expires_at, joined_count, pending_count, revoked }) =>
            [
              link,
              revoked ? "revoked" : "",
              approval ? "approval" : "",
              expires_at ? `until ${expires_at}` : "",
              joined_count === undefined ? "" : `${joined_count} joined`,
              pending_count ? `${pending_count} waiting` : "",
            ].join("  "),
          ),
        )
      }),
    )
  if (messenger.inviteLinkRevoke !== false)
    link.addCommand(
      annotate(new Command("revoke"), { effects: REMOTE_WRITE })
        .description("stop one link; for the group's own link, the answer is the new one")
        .argument("<chat>", messenger.chatArgument)
        .argument("<link>", "the link, as `chats link list` shows it")
        .action(async function (this: Command, chat: string, link: string) {
          const context = messengerContext(this, messenger)
          renderItem(this, context, await context.withServices((services) => services.admin.revokeLink(chat, link)))
        }),
    )
  if (messenger.inviteLinkUpdate === true)
    link.addCommand(
      annotate(new Command("update"), { effects: REMOTE_WRITE })
        .description("change one of your invite links, the group's own one too")
        .argument("<chat>", messenger.chatArgument)
        .argument("<link>", "the link, as `chats link list` shows it")
        .option("--approval", "who joins by it asks first, and an admin lets them in; it then has no use limit")
        .option("--no-approval", "anyone with it joins at once")
        .option(
          "--expire-time <time>",
          "it stops working then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d from now; `never` takes the expiry away",
        )
        .option("--max-uses <n>", "at most this many people join by it, 1 to 99999", positiveCount("--max-uses"))
        .action(async function (this: Command, chat: string, link: string) {
          const context = messengerContext(this, messenger)
          const { approval, expireTime, maxUses } = this.opts<{
            approval?: boolean
            expireTime?: string
            maxUses?: number
          }>()
          renderItem(
            this,
            context,
            await context.withServices((services) =>
              services.admin.updateLink(chat, link, {
                ...(approval === undefined ? {} : { approval }),
                ...(expireTime === undefined ? {} : { expires: expireTime }),
                ...(maxUses === undefined ? {} : { maxUses }),
              }),
            ),
          )
        }),
    )
  link.addCommand(
    annotate(new Command("reset"), { effects: REMOTE_WRITE })
      .description("replace the invite link; the old one stops working")
      .argument("<chat>", messenger.chatArgument)
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        renderItem(this, context, await context.withServices((services) => services.admin.resetLink(chat)))
      }),
  )
  return link
}

const adminsCommand = (messenger: Messenger): Command => {
  const offered = messenger.adminRights ?? ADMIN_RIGHTS
  const admins = new Command("admins").description("give or take back a member's admin rights")
  const picks = messenger.pickAdminRights !== false
  const add = annotate(new Command("add"), { effects: REMOTE_WRITE })
    .summary(picks ? "make a member an admin with these rights" : "make a member an admin, with every right")
    .description(
      picks
        ? "make a member an admin with these rights"
        : `make a member an admin, with every right: ${offered.join(", ")}`,
    )
    .argument("<chat>", messenger.chatArgument)
    .argument("<person>", "an id, or part of a name")
  if (picks) add.requiredOption("--can <rights>", `what they may do, comma-separated: ${offered.join(", ")}`)
  admins.addCommand(
    add.action(async function (this: Command, chat: string, person: string) {
      const context = messengerContext(this, messenger)
      const rights = picks ? rightsOf(offered, this.opts<{ can: string }>().can) : [...offered]
      renderItem(this, context, await context.withServices((services) => services.admin.addAdmin(chat, person, rights)))
    }),
  )
  admins.addCommand(
    annotate(new Command("remove"), { effects: REMOTE_WRITE })
      .description("take an admin's rights back; they stay a member")
      .argument("<chat>", messenger.chatArgument)
      .argument("<person>", "an id, or part of a name")
      .action(async function (this: Command, chat: string, person: string) {
        const context = messengerContext(this, messenger)
        renderItem(this, context, await context.withServices((services) => services.admin.removeAdmin(chat, person)))
      }),
  )
  return admins
}

export const rightsOf = (offered: readonly AdminRight[], typed: string): AdminRight[] => {
  const rights = [
    ...new Set(
      typed
        .split(",")
        .map((one) => one.trim())
        .filter(Boolean),
    ),
  ]
  const unknown = rights.filter((one) => !(offered as readonly string[]).includes(one))
  if (rights.length === 0 || unknown.length > 0) {
    throw new CliError(
      "validation_error",
      `--can takes rights from: ${offered.join(", ")}${unknown.length > 0 ? ` — not ${unknown.join(", ")}` : ""}`,
    )
  }
  return rights as AdminRight[]
}

const requestsCommand = (messenger: Messenger): Command => {
  const requests = new Command("requests").description("requests to join a group that needs an admin's approval")
  requests.addCommand(
    withQuery(
      annotate(
        withPage(
          annotate(new Command("list"), { effects: REMOTE_READ })
            .description("who asked to join, newest first; only admins see them, and reading tells nobody")
            .argument("<chat>", messenger.chatArgument),
        ),
        { output: { entity: "join_request" } },
      ),
      REQUESTS_QUERY,
    ).action(async function (this: Command, chat: string, words: string[]) {
      const context = messengerContext(this, messenger)
      const body = await context.withServices((services) => joinRequests(services, chat, words, context.settings))
      renderAnswer(
        this,
        context,
        body,
        lines(({ person_id, name, username, requested_at }) =>
          [person_id, name ?? "", username ? `@${username}` : "", requested_at ?? ""].join("  "),
        ),
      )
    }),
  )
  const everyone = messenger.joinRequestsAll !== false
  for (const [verb, accept, help] of [
    ["accept", true, "let them in; the group sees them join"],
    ["decline", false, "turn the request away"],
  ] as const) {
    const answer = annotate(new Command(verb), { effects: REMOTE_WRITE })
      .description(help)
      .argument("<chat>", messenger.chatArgument)
      .argument(everyone ? "[person]" : "<person>", "who asked: an id from `chats requests list`")
    if (everyone)
      answer
        .option("--all", "every pending request, counted against the hourly limit first")
        .option("--link <link>", "with --all: only the requests made by this invite link")
    requests.addCommand(
      answer.action(async function (this: Command, chat: string, person: string | undefined) {
        const context = messengerContext(this, messenger)
        const { all, link } = this.opts<{ all?: boolean; link?: string }>()
        if ((person === undefined) === (all !== true))
          throw new CliError("validation_error", "give one person, or --all — not both, not neither")
        if (link !== undefined && all !== true) throw new CliError("validation_error", "--link goes with --all")
        renderItem(
          this,
          context,
          await context.withServices(
            (services): Promise<object> =>
              person === undefined
                ? services.admin.answerAllRequests(chat, accept, link === undefined ? {} : { link })
                : services.admin.answerRequest(chat, person, accept),
          ),
        )
      }),
    )
  }
  return requests
}

/** `chats create`, `join`, `leave`, `update` and `link`: the help text is max-cli's, the one both tools say (standard, help rule 2). */
export const groupCommands = (messenger: Messenger): Command[] => [
  annotate(new Command("create"), { effects: REMOTE_WRITE })
    .description("create a group or a channel; the people added are told")
    .argument("<title>", "the group's name")
    .argument("[person...]", "people to add: an id, or part of a name")
    .option("--channel", "a private channel instead of a group; people join it by its link")
    .action(async function (this: Command, title: string, people: string[]) {
      const context = messengerContext(this, messenger)
      const { channel } = this.opts<{ channel?: boolean }>()
      renderItem(
        this,
        context,
        await context.withServices((services) => services.admin.create({ title, people, channel: channel === true })),
      )
    }),

  annotate(new Command("join"), { effects: REMOTE_WRITE })
    .description("join a group or channel by its link; the others in it see that you joined")
    .argument("<link>", `an invite link, or a public one`)
    .action(async function (this: Command, link: string) {
      const context = messengerContext(this, messenger)
      renderItem(this, context, await context.withServices((services) => services.admin.join(link)))
    }),

  annotate(new Command("leave"), { effects: REMOTE_WRITE })
    .description("leave a group or channel; the others in it see that you left")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderItem(this, context, await context.withServices((services) => services.admin.leave(chat)))
    }),

  updateCommand(messenger),
  linkCommand(messenger),
  requestsCommand(messenger),
  adminsCommand(messenger),
]
