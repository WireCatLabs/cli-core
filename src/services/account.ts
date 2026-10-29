import { CliError } from "@wirecat/cli-base"
import type { Account, AccountSession, Id, PrivacySettings } from "../domain/models.js"
import { capability, type MessengerAdapter, type ProfileChange } from "../ports/messenger.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import type { AccountAction } from "../sends/journal.js"
import { newOperationId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"

/** The owner's own profile and logins. */
export interface AccountService {
  /** The account as it now stands. */
  update(change: ProfileChange): Promise<Operated<{ account: Account }>>
  /** Logs the owner out of every other device, the phone included. */
  endOtherSessions(): Promise<Operated<{ sessions: AccountSession[] }>>
  /** `until`: `forever`, an ISO 8601 time, or null to hear the chat again. */
  mute(chat: string, until: string | null): Promise<Operated<{ chatId: Id; mutedUntil: string | null }>>
  archive(chat: string, archived: boolean): Promise<Operated<{ chatId: Id; archived: boolean }>>
  /** A chat at the top of the chat list; `messages pin` pins a message instead. */
  pinChat(chat: string, pinned: boolean): Promise<Operated<{ chatId: Id; pinned: boolean }>>
  markUnread(chat: string): Promise<Operated<{ chatId: Id; unread: true }>>
  updatePrivacy(change: PrivacySettings): Promise<Operated<{ privacy: PrivacySettings }>>
}

export const accountService = (deps: ServiceDeps): AccountService => {
  const online = async (command: string) => {
    if (deps.offline) throw new CliError("validation_error", `\`${command}\` changes the account; not with --offline`)
    return deps.connection()
  }
  const onOneChat = async (
    command: string,
    chat: string,
    action: AccountAction,
    write: (connection: MessengerAdapter) => (chatId: Id) => Promise<void>,
  ) => {
    const connection = await online(command)
    const act = write(connection)
    const { id: chatId } = await connection.resolve(chat)
    const operationId = newOperationId()
    await guardedWrite(deps.guard, { operationId, chatId, kind: "account", action }, () => act(chatId))
    return { operationId, chatId }
  }
  return {
    update: async (change) => {
      if (Object.values(change).every((value) => value === undefined)) {
        throw new CliError("validation_error", "nothing to change — give a name, a description or a photo")
      }
      if (change.firstName !== undefined && change.firstName.trim() === "") {
        throw new CliError("validation_error", "a first name cannot be empty")
      }
      const update = capability(await online("account update"), "updateProfile", "change the profile")
      const operationId = newOperationId()
      const account = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "profile" },
        () => update(change),
      )
      return { operationId, account }
    },

    endOtherSessions: async () => {
      const end = capability(await online("account sessions end"), "endOtherSessions", "end other sessions")
      const operationId = newOperationId()
      const sessions = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "sessions-end" },
        () => end(),
      )
      return { operationId, sessions }
    },

    mute: async (chat, until) => {
      const connection = await online(until === null ? "chats unmute" : "chats mute")
      const mute = capability(connection, "mute", "mute a chat")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(
        deps.guard,
        { operationId, chatId, kind: "account", action: until === null ? "chat-unmute" : "chat-mute" },
        () => mute(chatId, until),
      )
      return { operationId, chatId, mutedUntil: until }
    },

    archive: async (chat, archived) => ({
      ...(await onOneChat(
        archived ? "chats archive" : "chats unarchive",
        chat,
        archived ? "chat-archive" : "chat-unarchive",
        (connection) => {
          const archive = capability(connection, "archiveChat", "archive a chat")
          return (chatId) => archive(chatId, archived)
        },
      )),
      archived,
    }),

    pinChat: async (chat, pinned) => ({
      ...(await onOneChat(
        pinned ? "chats pin" : "chats unpin",
        chat,
        pinned ? "chat-pin" : "chat-unpin",
        (connection) => {
          const pin = capability(connection, "pinChat", "pin a chat")
          return (chatId) => pin(chatId, pinned)
        },
      )),
      pinned,
    }),

    markUnread: async (chat) => ({
      ...(await onOneChat("chats mark-unread", chat, "chat-mark-unread", (connection) =>
        capability(connection, "markChatUnread", "mark a chat unread"),
      )),
      unread: true as const,
    }),

    updatePrivacy: async (change) => {
      if (Object.values(change).every((value) => value === undefined)) {
        throw new CliError("validation_error", "nothing to change — name a setting")
      }
      const update = capability(await online("account privacy set"), "updatePrivacy", "change privacy settings")
      const operationId = newOperationId()
      const privacy = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "privacy" },
        () => update(change),
      )
      return { operationId, privacy }
    },
  }
}
