import { CliError } from "@wirecat/cli-base"
import { capability } from "../cli/messenger/port.js"
import type {
  AdminRight,
  GroupCard,
  GroupChange,
  Id,
  InviteLink,
  InviteLinkChange,
  JoinRequest,
  Page,
} from "../domain/models.js"
import { sendTime } from "../domain/send-time.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"

export interface NewGroup {
  title: string
  /** As typed: ids, handles or names. */
  people: string[]
  channel: boolean
}

/** Groups the owner makes, joins and leaves — each a write others see, through the guard. */
export interface AdminService {
  create(group: NewGroup): Promise<Operated<{ chat: GroupCard }>>
  join(link: string): Promise<Operated<{ chat: GroupCard } | { requested: true }>>
  leave(chat: string): Promise<Operated<{ chatId: Id }>>
  /** For this account only; asks first at the default level. */
  deleteChat(chat: string): Promise<Operated<{ chatId: Id }>>
  /** Every message, for this account only; asks first at the default level. */
  clearHistory(chat: string): Promise<Operated<{ chatId: Id }>>
  update(chat: string, change: GroupChange): Promise<Operated<{ chat: GroupCard }>>
  /** The invite link, or `not_found` when the owner may not see it. */
  link(chat: string): Promise<{ chatId: Id; title: string | null; link: string }>
  resetLink(chat: string): Promise<Operated<{ chat: GroupCard }>>
  /** `expires` as typed: a time, or a delay like `7d`. */
  createLink(
    chat: string,
    options: { approval: boolean; expires?: string; maxUses?: number },
  ): Promise<Operated<{ chatId: Id } & InviteLink>>
  /** Who asked to join, newest first; only the group's admins see them. */
  requests(
    chat: string,
    window: { limit: number; search?: string; link?: string },
  ): Promise<Page<JoinRequest> & { chatId: Id }>
  answerRequest(
    chat: string,
    person: string,
    accept: boolean,
  ): Promise<Operated<{ chatId: Id; personId: Id; accepted: boolean; already: boolean }>>
  /** Counted first, so an accept the hourly limit cannot take is refused before anyone is answered. */
  answerAllRequests(
    chat: string,
    accept: boolean,
    options: { link?: string },
  ): Promise<{ chatId: Id; accepted: boolean; counted: number; operationId?: string }>
  links(chat: string, window: { limit: number; revoked: boolean }): Promise<Page<InviteLink> & { chatId: Id }>
  revokeLink(chat: string, link: string): Promise<Operated<{ chatId: Id } & InviteLink>>
  /** Only the fields given change; `expires` as `createLink` takes it, or `never`. */
  updateLink(
    chat: string,
    link: string,
    change: { approval?: boolean; expires?: string; maxUses?: number },
  ): Promise<Operated<{ chatId: Id } & InviteLink>>
  addMembers(
    chat: string,
    people: string[],
    options: { history?: boolean },
  ): Promise<Operated<{ chatId: Id; added: Id[]; notAdded: Id[] }>>
  removeMembers(chat: string, people: string[]): Promise<Operated<{ chatId: Id; removed: Id[] }>>
  addAdmin(
    chat: string,
    person: string,
    rights: AdminRight[],
  ): Promise<Operated<{ chatId: Id; personId: Id; rights: AdminRight[] }>>
  removeAdmin(chat: string, person: string): Promise<Operated<{ chatId: Id; personId: Id }>>
}

export const adminService = (deps: ServiceDeps): AdminService => {
  const online = async (command: string) => {
    if (deps.offline) throw new CliError("validation_error", `\`${command}\` changes a chat; not with --offline`)
    return deps.connection()
  }

  return {
    create: async ({ title, people, channel }) => {
      if (title.trim() === "") throw new CliError("validation_error", "a group needs a title")
      const connection = await online("chats create")
      const create = capability(connection, "createGroup", "create a group")
      const personIds = people.length === 0 ? [] : await capability(connection, "people", "find people")(people)
      const operationId = newOperationId()
      const chat = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "chat", action: "create", personIds, people: personIds.length },
        () => create(title.trim(), personIds, { channel }),
        (made) => ({ chatId: made.id }),
      )
      return { operationId, chat }
    },

    join: async (link) => {
      const connection = await online("chats join")
      const join = capability(connection, "join", "join a chat by its link")
      const operationId = newOperationId()
      const joined = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "chat", action: "join" },
        () => join(link.trim()),
        (answer) => ("requested" in answer ? {} : { chatId: answer.id }),
      )
      return "requested" in joined ? { operationId, requested: true } : { operationId, chat: joined }
    },

    leave: async (chat) => {
      const connection = await online("chats leave")
      const leave = capability(connection, "leave", "leave a chat")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "leave" }, () => leave(chatId))
      return { operationId, chatId }
    },

    deleteChat: async (chat) => {
      const connection = await online("chats delete")
      const remove = capability(connection, "deleteChat", "delete a chat")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "delete" }, () => remove(chatId))
      return { operationId, chatId }
    },

    clearHistory: async (chat) => {
      const connection = await online("chats clear")
      const clear = capability(connection, "clearHistory", "clear a chat's history")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "clear" }, () => clear(chatId))
      return { operationId, chatId }
    },

    update: async (chat, change) => {
      const settings = Object.keys(change.settings ?? {}).length
      const profile = change.title !== undefined || change.description !== undefined || change.photo !== undefined
      if (!profile && settings === 0) {
        throw new CliError("validation_error", "nothing to change — give a title, a description, a photo or a setting")
      }
      if (change.title !== undefined && change.title.trim() === "") {
        throw new CliError("validation_error", "a group needs a title")
      }
      const connection = await online("chats update")
      const update = capability(connection, "updateGroup", "change a group")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const action = profile ? "update" : "settings"
      const card = await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action }, () =>
        update(chatId, change),
      )
      return { operationId, chat: card }
    },

    link: async (chat) => {
      const group = await capability(await online("chats link show"), "group", "read a group")(chat)
      if (group.link === null) {
        throw new CliError(
          "not_found",
          `${group.title ?? group.id} shows you no invite link — only admins, or members when the group allows it`,
        )
      }
      return { chatId: group.id, title: group.title, link: group.link }
    },

    resetLink: async (chat) => {
      const connection = await online("chats link reset")
      const reset = capability(connection, "resetInviteLink", "replace an invite link")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const card = await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "link.reset" }, () =>
        reset(chatId),
      )
      return { operationId, chat: card }
    },

    createLink: async (chat, { approval, expires, maxUses }) => {
      const expiresAt = linkLimits({ approval, expires, maxUses })
      const connection = await online("chats link create")
      const create = capability(connection, "createInviteLink", "make another invite link")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const made = await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "link.create" }, () =>
        create(chatId, {
          approval,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(maxUses === undefined ? {} : { maxUses }),
        }),
      )
      return { operationId, chatId, ...made }
    },

    requests: async (chat, window) => {
      if (deps.offline)
        throw new CliError("validation_error", "join requests are read from the messenger; not with --offline")
      // Telegram searches the whole pending list or one link's, never both (mtcute getInviteLinkMembers).
      if (window.search !== undefined && window.link !== undefined)
        throw new CliError("validation_error", "--search and --link narrow the list two ways; use one")
      if (window.search?.trim() === "" || window.link?.trim() === "")
        throw new CliError("validation_error", "--search and --link need a value")
      const connection = await deps.connection()
      const list = capability(connection, "joinRequests", "read join requests")
      const { id: chatId } = await connection.resolve(chat)
      return { chatId, ...(await list(chatId, window)) }
    },

    answerRequest: async (chat, person, accept) => {
      const connection = await online(`chats requests ${accept ? "accept" : "decline"}`)
      const answer = capability(connection, "answerJoinRequest", "answer join requests")
      const [personId] = await capability(connection, "people", "find people")([person])
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      // The recipient list names the group only: whoever asked to join cannot be on it in advance.
      const { already } = await guardedWrite(
        deps.guard,
        { operationId, chatId, kind: "chat", action: accept ? "requests.accept" : "requests.decline", people: 1 },
        () => answer(chatId, personId as Id, accept),
      )
      return { operationId, chatId, personId: personId as Id, accepted: accept, already }
    },

    answerAllRequests: async (chat, accept, { link }) => {
      const connection = await online(`chats requests ${accept ? "accept" : "decline"} --all`)
      const list = capability(connection, "joinRequests", "read join requests")
      const answerAll = capability(connection, "answerAllJoinRequests", "answer every join request at once")
      const { id: chatId } = await connection.resolve(chat)
      const page = await list(chatId, { limit: 100, ...(link === undefined ? {} : { link }) })
      const counted = page.total ?? page.items.length
      if (page.total === undefined && page.hasMore)
        throw new CliError("validation_error", "too many requests to count; answer them by person, or by --link")
      if (counted === 0) return { chatId, accepted: accept, counted }
      const operationId = newOperationId()
      await guardedWrite(
        deps.guard,
        {
          operationId,
          chatId,
          kind: "chat",
          action: accept ? "requests.accept" : "requests.decline",
          count: counted,
          people: counted,
        },
        () => answerAll(chatId, accept, link),
      )
      return { operationId, chatId, accepted: accept, counted }
    },

    links: async (chat, window) => {
      if (deps.offline)
        throw new CliError("validation_error", "invite links are read from the messenger; not with --offline")
      const connection = await deps.connection()
      const list = capability(connection, "inviteLinks", "list invite links")
      const { id: chatId } = await connection.resolve(chat)
      return { chatId, ...(await list(chatId, window)) }
    },

    revokeLink: async (chat, link) => {
      if (link.trim() === "")
        throw new CliError("validation_error", "which link? give it as `chats link list` shows it")
      const connection = await online("chats link revoke")
      const revoke = capability(connection, "revokeInviteLink", "revoke an invite link")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const answer = await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "link.revoke" }, () =>
        revoke(chatId, link.trim()),
      )
      return { operationId, chatId, ...answer }
    },

    updateLink: async (chat, link, { approval, expires, maxUses }) => {
      if (link.trim() === "")
        throw new CliError("validation_error", "which link? give it as `chats link list` shows it")
      if (approval === undefined && expires === undefined && maxUses === undefined)
        throw new CliError(
          "validation_error",
          "nothing to change: give --approval, --no-approval, --expire-time or --max-uses",
        )
      const limited = linkLimits({ approval, expires: expires === "never" ? undefined : expires, maxUses })
      const expiresAt = expires === "never" ? null : limited
      const connection = await online("chats link update")
      const update = capability(connection, "updateInviteLink", "change an invite link")
      const { id: chatId } = await connection.resolve(chat)
      const change: InviteLinkChange = {
        ...(approval === undefined ? {} : { approval }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(maxUses === undefined ? {} : { maxUses }),
      }
      const operationId = newOperationId()
      const answer = await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "link.update" }, () =>
        update(chatId, link.trim(), change),
      )
      return { operationId, chatId, ...answer }
    },

    addMembers: async (chat, people, options) => {
      const connection = await online("chats members add")
      const add = capability(connection, "addMembers", "add people to a group")
      const personIds = await capability(connection, "people", "find people")(people)
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const { notAdded } = await guardedWrite(
        deps.guard,
        { operationId, chatId, kind: "chat", action: "members.add", personIds, people: personIds.length },
        () => add(chatId, personIds, options),
      )
      return { operationId, chatId, added: personIds.filter((id) => !notAdded.includes(id)), notAdded }
    },

    removeMembers: async (chat, people) => {
      const connection = await online("chats members remove")
      const remove = capability(connection, "removeMembers", "remove people from a group")
      const personIds = await capability(connection, "people", "find people")(people)
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(
        deps.guard,
        { operationId, chatId, kind: "chat", action: "members.remove", people: personIds.length },
        () => remove(chatId, personIds),
      )
      return { operationId, chatId, removed: personIds }
    },

    addAdmin: async (chat, person, rights) => {
      if (rights.length === 0) throw new CliError("validation_error", "an admin needs at least one right")
      const connection = await online("chats admins add")
      const add = capability(connection, "addAdmin", "make someone an admin")
      const [personId] = await capability(connection, "people", "find people")([person])
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "admins.add" }, () =>
        add(chatId, personId as Id, rights),
      )
      return { operationId, chatId, personId: personId as Id, rights }
    },

    removeAdmin: async (chat, person) => {
      const connection = await online("chats admins remove")
      const remove = capability(connection, "removeAdmin", "take admin rights back")
      const [personId] = await capability(connection, "people", "find people")([person])
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "admins.remove" }, () =>
        remove(chatId, personId as Id),
      )
      return { operationId, chatId, personId: personId as Id }
    },
  }
}

const linkLimits = ({
  approval,
  expires,
  maxUses,
}: {
  approval?: boolean | undefined
  expires?: string | undefined
  maxUses?: number | undefined
}) => {
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 99_999))
    throw new CliError("validation_error", "--max-uses takes a whole number from 1 to 99999")
  // Measured on Telegram 2026-10-08: turning approval on drops the limit, and says nothing.
  if (approval === true && maxUses !== undefined)
    throw new CliError("validation_error", "a link that asks first takes no use limit; give --approval or --max-uses")
  return expires === undefined ? undefined : sendTime(expires, Date.now(), "--expire-time")
}
