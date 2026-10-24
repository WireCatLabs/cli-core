import { CliError } from "@wirecat/cli-base"
import type { Level } from "./permissions.js"

const RENAMED = [
  ["models.audio.download", "models.download"],
  ["models.text.download", "models.download"],
  ["models.text.key", "models.keys"],
  ["models.audio", "models"],
  ["models.text", "models"],
  ["doctor.report", "doctor.reports"],
  ["contacts.aliases.rm", "contacts.aliases.remove"],
  ["contacts.alias.rm", "contacts.aliases.remove"],
  ["contacts.alias", "contacts.aliases"],
  ["contacts.profile", "contacts.info"],
  ["contacts.timeline", "contacts.events"],
  ["chats.links.revoke", "chats.links.remove"],
  ["chats.link.revoke", "chats.links.remove"],
  ["chats.link", "chats.links"],
  ["chats.members.audit", "chats.members.check"],
  ["chats.requests.accept", "chats.requests.confirm"],
  ["chats.requests.decline", "chats.requests.reject"],
  ["metadata.get", "metadata.show"],
  ["metadata.refresh", "metadata.sync"],
  ["tasks.plan", "tasks.update"],
  ["tags.auto", "tags.rebuild"],
  ["attachments.text.set", "attachments.update"],
  ["attachments.text", "attachments.update"],
  ["conversations.build", "conversations.links.rebuild"],
  ["conversations.embed", "conversations.embeddings"],
  ["conversations.batches.next", "conversations.batches.show"],
  ["conversations.consents.revoke", "conversations.consents.remove"],
  ["stats.messages.counters.refresh", "stats.messages.counters.sync"],
  ["store.fetch", "messages.sync"],
  ["store.gaps.plan", "store.gaps.show"],
  ["store.reindex", "store.rebuild"],
] as const

/** Canonical names for internal permission keys; saved moved paths are refused below. */
export const canonicalPermissionKey = (key: string): string => {
  if (key.startsWith("bot.")) return `bot.${canonicalPermissionKey(key.slice(4))}`
  const renamed = RENAMED.find(([old]) => key === old || key.startsWith(`${old}.`))
  return renamed ? renamed[1] + key.slice(renamed[0].length) : key
}

/** WC-PERM-8: a moved saved path must name the replacement before any command runs. */
export const canonicalPermissions = (levels: Readonly<Record<string, Level>>): Record<string, Level> => {
  for (const key of Object.keys(levels)) {
    const canonical = canonicalPermissionKey(key)
    if (key !== canonical)
      throw new CliError(
        "configuration_error",
        `permission path moved — rename permissions.${key} to permissions.${canonical}`,
        { permission: key, replacement: canonical, retryable: false },
      )
  }
  return { ...levels }
}
