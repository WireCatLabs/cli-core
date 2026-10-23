/** What `chats members check` judges from a member list and the store. */
export type AuditReason =
  | "bot"
  | "scam"
  | "fake"
  | "deleted"
  | "no_photo"
  | "no_username"
  | "odd_name"
  | "never_wrote"
  | "link_first"
  | "burst_join"
  | "mass_invited"

/** What only a look at one person adds: their profile, all their stored messages, the registries. */
export type PersonReason = "new_account" | "no_bio" | "same_text" | "photo_recent" | RegistryReason

export type RegistryReason = "cas_banned" | "lols_banned" | "lols_scammer"

export type BotReason = AuditReason | PersonReason

/**
 * Light on purpose: real people without a photo, a username or a bio are common. A messenger's own
 * mark or a ban list's entry weighs more, because somebody already looked.
 */
export const WEIGHTS: Record<BotReason, number> = {
  bot: 3,
  scam: 3,
  fake: 3,
  deleted: 1,
  no_photo: 1,
  no_username: 1,
  odd_name: 1,
  never_wrote: 1,
  link_first: 2,
  burst_join: 1,
  mass_invited: 1,
  new_account: 2,
  no_bio: 1,
  same_text: 2,
  photo_recent: 1,
  cas_banned: 3,
  lols_banned: 3,
  lols_scammer: 3,
}

export const LINK = /https?:\/\/|t\.me\/|www\./i
const DIGITS = /\d{5,}/

/** No name, a long run of digits, or a link in it. */
export const oddName = (name: string | null) => !name?.trim() || DIGITS.test(name) || LINK.test(name)
