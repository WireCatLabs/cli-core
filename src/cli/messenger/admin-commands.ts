import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { ADMIN_RIGHTS, type AdminRight, GROUP_SETTINGS, type GroupSettings } from "../../domain/models.js"
import { readUpload } from "../../sends/upload.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

const SETTING_FLAGS: Record<keyof GroupSettings, [flag: string, help: string]> = {
  allCanPin: ["all-can-pin", "every member may pin messages"],
  onlyAdminsAdd: ["only-admins-add", "only admins may add members"],
  onlyAdminsCall: ["only-admins-call", "only admins may start a call"],
  onlyOwnerEditsInfo: ["only-owner-edits-info", "only the owner may change the name and photo"],
  membersSeeLink: ["members-see-link", "members may see the invite link"],
  joinApproval: ["join-approval", "people ask to join, and an admin lets them in"],
}

const settingsOf = (
  keys: readonly (keyof GroupSettings)[],
  options: Record<string, unknown>,
): Partial<GroupSettings> => {
  const changes: Partial<GroupSettings> = {}
  for (const key of keys) {
    const value = options[key]
    if (value === undefined) continue
    if (value !== "on" && value !== "off") {
      throw new CliError("validation_error", `--${SETTING_FLAGS[key][0]} takes on or off, not "${String(value)}"`)
    }
    changes[key] = value === "on"
  }
  return changes
}

const updateCommand = (messenger: Messenger): Command => {
  const keys = messenger.groupSettings ?? GROUP_SETTINGS
  const update = annotate(new Command("update"), { mutates: true })
    .description("rename a group or channel, change its description, or turn one of its settings on or off")
    .argument("<chat>", messenger.chatArgument)
    .option("--title <title>", "the new name")
    .option("--description <text>", "the new description")
  if (messenger.groupPhoto === true) update.option("--photo <file>", "a new photo for it — an image file")
  for (const key of keys) update.option(`--${SETTING_FLAGS[key][0]} <on|off>`, SETTING_FLAGS[key][1])
  return update.action(async function (this: Command, chat: string) {
    const context = messengerContext(this, messenger)
    const { title, description, photo, ...rest } = this.opts<{ title?: string; description?: string; photo?: string }>()
    const settings = settingsOf(keys, rest)
    const upload =
      photo === undefined ? undefined : await readUpload("photo", photo, { app: messenger.app, env: context.env })
    context.renderer.result(
      await context.withServices((services) =>
        services.admin.update(chat, {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(upload === undefined ? {} : { photo: upload }),
        }),
      ),
    )
  })
}

const linkCommand = (messenger: Messenger): Command => {
  const link = new Command("link").description("a group's invite link")
  link
    .command("show")
    .description("the invite link, if you may see it")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.admin.link(chat)))
    })
  link.addCommand(
    annotate(new Command("create"), { mutates: true })
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
        context.renderer.result(
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
    link
      .command("list")
      .description("your invite links, newest first, with how many joined and how many wait")
      .argument("<chat>", messenger.chatArgument)
      .option("--revoked", "the links you stopped, instead")
      .option("--limit <n>", "how many", positiveCount("--limit"))
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        const { revoked } = this.opts<{ revoked?: boolean }>()
        const { limit } = context.settings
        const found = await context.withServices((services) =>
          services.admin.links(chat, { limit, revoked: revoked === true }),
        )
        if (context.format === "json") context.renderer.result(found)
        else context.renderer.stream(found.items)
        if (found.hasMore) context.renderer.note(`more links: raise --limit above ${limit}`)
      })
  if (messenger.inviteLinkRevoke !== false)
    link.addCommand(
      annotate(new Command("revoke"), { mutates: true })
        .description("stop one link; for the group's own link, the answer is the new one")
        .argument("<chat>", messenger.chatArgument)
        .argument("<link>", "the link, as `chats link list` shows it")
        .action(async function (this: Command, chat: string, link: string) {
          const context = messengerContext(this, messenger)
          context.renderer.result(await context.withServices((services) => services.admin.revokeLink(chat, link)))
        }),
    )
  if (messenger.inviteLinkUpdate === true)
    link.addCommand(
      annotate(new Command("update"), { mutates: true })
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
          context.renderer.result(
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
    annotate(new Command("reset"), { mutates: true })
      .description("replace the invite link; the old one stops working")
      .argument("<chat>", messenger.chatArgument)
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.admin.resetLink(chat)))
      }),
  )
  return link
}

const adminsCommand = (messenger: Messenger): Command => {
  const offered = messenger.adminRights ?? ADMIN_RIGHTS
  const admins = new Command("admins").description("give or take back a member's admin rights")
  admins.addCommand(
    annotate(new Command("add"), { mutates: true })
      .description("make a member an admin with these rights")
      .argument("<chat>", messenger.chatArgument)
      .argument("<person>", "an id, or part of a name")
      .requiredOption("--can <rights>", `what they may do, comma-separated: ${offered.join(", ")}`)
      .action(async function (this: Command, chat: string, person: string) {
        const context = messengerContext(this, messenger)
        const rights = rightsOf(offered, this.opts<{ can: string }>().can)
        context.renderer.result(await context.withServices((services) => services.admin.addAdmin(chat, person, rights)))
      }),
  )
  admins.addCommand(
    annotate(new Command("remove"), { mutates: true })
      .description("take an admin's rights back; they stay a member")
      .argument("<chat>", messenger.chatArgument)
      .argument("<person>", "an id, or part of a name")
      .action(async function (this: Command, chat: string, person: string) {
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.admin.removeAdmin(chat, person)))
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
  requests
    .command("list")
    .description("who asked to join, newest first; only admins see them, and reading tells nobody")
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--search <text>", "only people whose name or @username has this")
    .option("--link <link>", "only people who asked through this invite link; not with --search")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { limit } = context.settings
      const { search, link } = this.opts<{ search?: string; link?: string }>()
      const window = { limit, ...(search === undefined ? {} : { search }), ...(link === undefined ? {} : { link }) }
      const found = await context.withServices((services) => services.admin.requests(chat, window))
      if (context.format === "json") context.renderer.result(found)
      else context.renderer.stream(found.items)
      if (found.hasMore) context.renderer.note(`more requests: raise --limit above ${limit}`)
    })
  for (const [verb, accept, help] of [
    ["accept", true, "let them in; the group sees them join"],
    ["decline", false, "turn the request away"],
  ] as const) {
    requests.addCommand(
      annotate(new Command(verb), { mutates: true })
        .description(help)
        .argument("<chat>", messenger.chatArgument)
        .argument("[person]", "who asked: an id from `chats requests list`")
        .option("--all", "every pending request, counted against the hourly limit first")
        .option("--link <link>", "with --all: only the requests made by this invite link")
        .action(async function (this: Command, chat: string, person: string | undefined) {
          const context = messengerContext(this, messenger)
          const { all, link } = this.opts<{ all?: boolean; link?: string }>()
          if ((person === undefined) === (all !== true))
            throw new CliError("validation_error", "give one person, or --all — not both, not neither")
          if (link !== undefined && all !== true) throw new CliError("validation_error", "--link goes with --all")
          context.renderer.result(
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
  annotate(new Command("create"), { mutates: true })
    .description("create a group or a channel; the people added are told")
    .argument("<title>", "the group's name")
    .argument("[person...]", "people to add: an id, or part of a name")
    .option("--channel", "a private channel instead of a group; people join it by its link")
    .action(async function (this: Command, title: string, people: string[]) {
      const context = messengerContext(this, messenger)
      const { channel } = this.opts<{ channel?: boolean }>()
      context.renderer.result(
        await context.withServices((services) => services.admin.create({ title, people, channel: channel === true })),
      )
    }),

  annotate(new Command("join"), { mutates: true })
    .description("join a group or channel by its link; the others in it see that you joined")
    .argument("<link>", `an invite link, or a public one`)
    .action(async function (this: Command, link: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.admin.join(link)))
    }),

  annotate(new Command("leave"), { mutates: true })
    .description("leave a group or channel; the others in it see that you left")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.admin.leave(chat)))
    }),

  updateCommand(messenger),
  linkCommand(messenger),
  requestsCommand(messenger),
  adminsCommand(messenger),
]
