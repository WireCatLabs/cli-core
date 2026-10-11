import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import { ADMIN_RIGHTS, GROUP_SETTINGS } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, limit, READ, tool, WRITE } from "../tool.js"

type Answering = { chat: string; person?: string; all?: boolean; link?: string }

const answer = (service: ReturnType<typeof servicesFor>["admin"], args: Answering, accept: boolean) => {
  if ((args.person === undefined) === (args.all !== true))
    throw new CliError("validation_error", "give one person, or all — not both, not neither")
  if (args.link !== undefined && args.all !== true) throw new CliError("validation_error", "link goes with all")
  return args.person === undefined
    ? service.answerAllRequests(args.chat, accept, args.link === undefined ? {} : { link: args.link })
    : service.answerRequest(args.chat, args.person, accept)
}

/** Groups the owner makes, joins and leaves: other people see each one, so each is behind its permission level. */
export const adminTools = (messenger: Messenger): Record<string, AnyTool> => {
  const admin = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).admin
  const definitions: Record<string, AnyTool> = {
    chats_create: tool({
      title: "Create a group",
      description:
        "Create a group, or a channel, with these people in it; each of them is told they were added. " +
        "Only when the owner asked for this group with these people.",
      input: v.object({
        title: v.pipe(v.string(), v.minLength(1)),
        people: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
        channel: v.optional(v.pipe(v.boolean(), v.description("a channel people join by its link, not a group"))),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).create({ title: args.title, people: args.people ?? [], channel: args.channel === true }),
    }),
    chats_join: tool({
      title: "Join a group by its link",
      description:
        "Join a group or channel by an invite or public link; the others in it see it. Where its admins approve " +
        "who joins, the answer is { requested: true }: the request is sent. Only when the owner asked.",
      input: v.object({ link: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).join(args.link),
    }),
    chats_leave: tool({
      title: "Leave a group",
      description: "Leave a group or channel; the others in it see it. Only when the owner asked to leave this chat.",
      input: v.object({ chat: chatOf(messenger) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).leave(args.chat),
    }),
    chats_update: tool({
      title: "Change a group",
      description:
        "Rename a group or channel, change its description, or turn its settings on or off; its members see the " +
        "change. Only when the owner asked for this change.",
      input: v.object({
        chat: chatOf(messenger),
        title: v.optional(v.pipe(v.string(), v.minLength(1))),
        description: v.optional(v.string()),
        settings: v.optional(
          v.pipe(
            v.partial(
              v.object(
                Object.fromEntries((messenger.groupSettings ?? GROUP_SETTINGS).map((key) => [key, v.boolean()])),
              ),
            ),
            v.description("true turns a setting on, false off; one left out stays as it is"),
          ),
        ),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).update(args.chat, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.settings === undefined ? {} : { settings: args.settings }),
        }),
    }),
    chats_link_show: tool({
      title: "A group's invite link",
      description: "The invite link of a group or channel, when the owner may see it. Reading changes nothing.",
      input: v.object({ chat: chatOf(messenger) }),
      annotations: READ,
      online: (adapter, args, { guard }) => admin(adapter, guard).link(args.chat),
    }),
    chats_link_reset: tool({
      title: "Replace a group's invite link",
      description:
        "Make a new invite link for a group or channel; the old one stops working for everyone who has it. " +
        "Only when the owner asked.",
      input: v.object({ chat: chatOf(messenger) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).resetLink(args.chat),
    }),
    chats_link_create: tool({
      title: "Make another invite link",
      description:
        "Make an additional invite link for a group or channel: { chatId, link, approval, expiresAt, maxUses }. " +
        "Nobody is told until the link is shared. Only when the owner asked.",
      input: v.object({
        chat: chatOf(messenger),
        approval: v.optional(
          v.pipe(
            v.boolean(),
            v.description("who joins by it asks first, and an admin lets them in; not with max_uses"),
          ),
        ),
        expire_time: v.optional(
          v.pipe(v.string(), v.description("it stops working then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d")),
        ),
        max_uses: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(99_999))),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).createLink(args.chat, {
          approval: args.approval === true,
          ...(args.expire_time === undefined ? {} : { expires: args.expire_time }),
          ...(args.max_uses === undefined ? {} : { maxUses: args.max_uses }),
        }),
    }),
    chats_link_list: tool({
      title: "A group's invite links",
      description:
        "The owner's own invite links of a group, newest first: { chatId, items: [{ link, approval, expiresAt, " +
        "maxUses, primary, revoked, pending, joined }], hasMore }. revoked lists the stopped ones. Reading changes nothing.",
      input: v.object({
        chat: chatOf(messenger),
        revoked: v.optional(v.pipe(v.boolean(), v.description("the stopped links instead"))),
        limit,
      }),
      annotations: READ,
      online: (adapter, args, defaults) =>
        admin(adapter, defaults.guard).links(args.chat, {
          limit: args.limit ?? defaults.limit,
          revoked: args.revoked === true,
        }),
    }),
    chats_link_revoke: tool({
      title: "Revoke an invite link",
      description:
        "Stop one invite link; for the group's own link the answer is the new one the messenger made. " +
        "Only the link the owner named.",
      input: v.object({ chat: chatOf(messenger), link: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).revokeLink(args.chat, args.link),
    }),
    chats_link_update: tool({
      title: "Change an invite link",
      description:
        "Change one of the owner's invite links, the group's own one too: { chatId, link, approval, expiresAt, " +
        "maxUses }. Only the fields given change. Only when the owner asked.",
      input: v.object({
        chat: chatOf(messenger),
        link: v.pipe(v.string(), v.minLength(1)),
        approval: v.optional(
          v.pipe(
            v.boolean(),
            v.description("true: who joins by it asks first, not with max_uses; false: anyone with it joins at once"),
          ),
        ),
        expire_time: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "it stops working then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d; never takes the expiry away",
            ),
          ),
        ),
        max_uses: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(99_999))),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).updateLink(args.chat, args.link, {
          ...(args.approval === undefined ? {} : { approval: args.approval }),
          ...(args.expire_time === undefined ? {} : { expires: args.expire_time }),
          ...(args.max_uses === undefined ? {} : { maxUses: args.max_uses }),
        }),
    }),
    chats_requests_list: tool({
      title: "Requests to join a group",
      description:
        "Who asked to join a group or channel that needs an admin's approval, newest first: { chatId, items: " +
        "[{ person, requestedAt, about }], hasMore }. Only admins see them. Reading tells nobody.",
      input: v.object({
        chat: chatOf(messenger),
        limit,
        search: v.optional(v.pipe(v.string(), v.minLength(1), v.description("only names or @usernames with this"))),
        link: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("only those who asked through this invite link; not with search"),
          ),
        ),
      }),
      annotations: READ,
      online: (adapter, args, defaults) =>
        admin(adapter, defaults.guard).requests(args.chat, {
          limit: args.limit ?? defaults.limit,
          ...(args.search === undefined ? {} : { search: args.search }),
          ...(args.link === undefined ? {} : { link: args.link }),
        }),
    }),
    chats_requests_accept: tool({
      title: "Accept a request to join",
      description: "Let one person who asked to join into the group. Only the person and group the owner named.",
      input: v.object({
        chat: chatOf(messenger),
        person: v.optional(v.pipe(v.string(), v.minLength(1))),
        all: v.optional(v.pipe(v.boolean(), v.description("every pending request instead of one person"))),
        link: v.optional(v.pipe(v.string(), v.minLength(1), v.description("with all: only requests by this link"))),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => answer(admin(adapter, guard), args, true),
    }),
    chats_requests_decline: tool({
      title: "Decline a request to join",
      description: "Turn away one person who asked to join the group. Only the person and group the owner named.",
      input: v.object({
        chat: chatOf(messenger),
        person: v.optional(v.pipe(v.string(), v.minLength(1))),
        all: v.optional(v.pipe(v.boolean(), v.description("every pending request instead of one person"))),
        link: v.optional(v.pipe(v.string(), v.minLength(1), v.description("with all: only requests by this link"))),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => answer(admin(adapter, guard), args, false),
    }),
    chats_members_add: tool({
      title: "Add people to a group",
      description:
        "Add people to a group; each is told. Only the people the owner named, to the group the owner named.",
      input: v.object({
        chat: chatOf(messenger),
        people: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
        history: v.optional(
          v.pipe(
            v.boolean(),
            v.description("they also see the messages from before; refused where the messenger cannot"),
          ),
        ),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).addMembers(args.chat, args.people, args.history === true ? { history: true } : {}),
    }),
    chats_members_remove: tool({
      title: "Remove people from a group",
      description: "Remove people from a group; their messages stay. Only the people the owner named.",
      input: v.object({
        chat: chatOf(messenger),
        people: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).removeMembers(args.chat, args.people),
    }),
    chats_admins_add: tool({
      title: "Make someone an admin",
      description: "Make a member of a group an admin with these rights. Only when the owner asked, with these rights.",
      input: v.object({
        chat: chatOf(messenger),
        person: v.pipe(v.string(), v.minLength(1)),
        rights: v.pipe(v.array(v.picklist(messenger.adminRights ?? ADMIN_RIGHTS)), v.minLength(1)),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).addAdmin(args.chat, args.person, args.rights),
    }),
    chats_admins_remove: tool({
      title: "Take admin rights back",
      description: "Take a group admin's rights back; they stay a member. Only when the owner asked.",
      input: v.object({ chat: chatOf(messenger), person: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).removeAdmin(args.chat, args.person),
    }),
  }
  if (messenger.inviteLinkList === false) delete definitions.chats_link_list
  if (messenger.inviteLinkRevoke === false) delete definitions.chats_link_revoke
  if (messenger.inviteLinkUpdate !== true) delete definitions.chats_link_update
  return definitions
}
