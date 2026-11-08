import * as v from "valibot"
import { account } from "./account.js"
import { accountSession } from "./account-session.js"
import { id, text } from "./fields.js"

export const accountChange = v.strictObject({ operation_id: id, account: v.omit(account, ["provider", "scope"]) })
export const endedAccountSessions = v.strictObject({ operation_id: id, sessions: v.array(accountSession) })

const audience = v.picklist(["everyone", "contacts", "nobody"])
const shownAudience = v.picklist(["everyone", "contacts", "nobody", "contacts_except"])
export const accountPrivacy = v.strictObject({
  find_by_phone: v.optional(audience),
  phone_number: v.optional(audience),
  calls: v.optional(audience),
  chat_invites: v.optional(audience),
  hide_online: v.optional(v.boolean()),
  read_receipts: v.optional(v.boolean()),
  profile_photo: v.optional(shownAudience),
  about: v.optional(shownAudience),
  last_seen: v.optional(shownAudience),
})
export const accountPrivacyChange = v.strictObject({ operation_id: id, privacy: accountPrivacy })

const removalKind = v.picklist(["sign_in", "keyring", "config", "file", "store"])
export const accountRemoval = v.strictObject({
  profile: text,
  data: v.picklist(["kept", "deleted"]),
  dry_run: v.boolean(),
  account: v.nullable(v.strictObject({ provider: text, account: text })),
  revoked: v.nullable(v.boolean()),
  config_file: text,
  removed: v.array(v.strictObject({ kind: removalKind, target: text })),
  kept: v.array(v.strictObject({ kind: removalKind, target: text, reason: text })),
})
