import { CliError } from "@wirecat/cli-base"
import type { Id } from "../domain/models.js"
import { type CheckRow, type Finding, gather, MAX_ACTIONS, type Moderator } from "../moderation/check.js"
import { defaultRules, type GroupRules, ModerationRules, moderationPathFor } from "../moderation/rules.js"
import { moderateWith } from "../moderation/run.js"
import { capability, type MessengerAdapter } from "../ports/messenger.js"
import { guardedWrite } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"

export interface ShownRules {
  chatId: Id
  title: string | null
  file: string
  /** `false`: the group has no section yet, and these are the defaults. */
  saved: boolean
  rules: GroupRules
}

export interface ModerateOptions {
  /** ms; the saved point is neither read nor moved. */
  since?: number
  dryRun: boolean
  allowDangerous: boolean
  maxActions?: number
  confirm?: (finding: Finding) => Promise<boolean | undefined>
}

/** A group's rules, and the one command that acts on them (max-cli `NEED-306`). */
export interface ModerationService {
  rules(chat: string): Promise<ShownRules>
  set(chat: string, key: string, value: string): Promise<ShownRules>
  unset(chat: string, key: string): Promise<ShownRules>
  moderate(chat: string, options: ModerateOptions): Promise<{ chatId: Id; rows: CheckRow[]; notes: string[] }>
}

export const moderationService = (deps: ServiceDeps): ModerationService => {
  const file = () =>
    new ModerationRules(moderationPathFor(deps.messenger.app, deps.profile ?? "default", deps.env ?? process.env))
  const group = async (chat: string) => {
    if (deps.offline)
      throw new CliError("validation_error", "a group's rules are kept by its id, which the messenger gives")
    return (await deps.connection()).resolve(chat)
  }
  const shown = (chatId: Id, title: string | null, rules: ModerationRules): ShownRules => {
    const saved = rules.read(chatId)
    return { chatId, title, file: rules.path, saved: saved !== undefined, rules: saved ?? defaultRules(title) }
  }
  const refuseAge = (key: string) => {
    if (key.startsWith("newAccount.") && deps.messenger.knowsAccountAge === false) {
      throw new CliError(
        "validation_error",
        `${deps.messenger.name ?? "this messenger"} does not say how old an account is, so newAccount cannot work`,
      )
    }
  }

  return {
    rules: async (chat) => {
      const { id, title } = await group(chat)
      return shown(id, title, file())
    },

    set: async (chat, key, value) => {
      refuseAge(key)
      const { id, title } = await group(chat)
      const rules = file()
      rules.set(id, title, key, value)
      return shown(id, title, rules)
    },

    unset: async (chat, key) => {
      const { id, title } = await group(chat)
      const rules = file()
      rules.unset(id, title, key)
      return shown(id, title, rules)
    },

    moderate: async (chat, { since, dryRun, allowDangerous, maxActions = MAX_ACTIONS, confirm }) => {
      if (deps.offline) throw new CliError("validation_error", "`chats moderate` asks the messenger what is new")
      const connection = await deps.connection()
      const { id: chatId, title } = await connection.resolve(chat)
      const rules = file()
      const { inviteLinks } = deps.messenger
      return moderateWith({
        chatId,
        title,
        rules,
        point: { read: (id) => rules.checkedUntil(id), write: (id, at) => rules.markChecked(id, at) },
        gather: (from) => gather(connection, chatId, from),
        moderator: moderatorOf(connection, deps),
        command: deps.messenger.app.command,
        ...(inviteLinks ? { invites: inviteLinks } : {}),
        ...(since === undefined ? {} : { since }),
        dryRun,
        allowDangerous,
        maxActions,
        ...(confirm ? { confirm } : {}),
      })
    },
  }
}

/** Each action through the guard under `chats.moderate`: the group's levels already said yes, so `messages.delete` does not ask again. */
const moderatorOf = (adapter: MessengerAdapter, deps: ServiceDeps): Moderator => ({
  deleteMessage: async (chatId, messageId) => {
    const remove = capability(adapter, "delete", "delete messages")
    await guardedWrite(
      deps.guard,
      { operationId: newOperationId(), chatId, kind: "delete", count: 1, forEveryone: true, key: "chats.moderate" },
      () => remove(chatId, [messageId], { forEveryone: true }),
    )
  },
  removePerson: async (chatId, personId) => {
    const remove = capability(adapter, "removeMembers", "remove people from a group")
    await guardedWrite(
      deps.guard,
      {
        operationId: newOperationId(),
        chatId,
        kind: "chat",
        action: "members.remove",
        people: 1,
        key: "chats.moderate",
      },
      () => remove(chatId, [personId]),
    )
  },
})
