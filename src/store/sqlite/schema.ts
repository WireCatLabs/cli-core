import {
  type AnySQLiteColumn,
  blob,
  desc,
  index,
  integer,
  primaryKey,
  real,
  sql,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "./drizzle/core.js"
import { canonicalTags } from "./schema/canonical-tags.js"

/**
 * The store's base tables — what `drizzle-kit generate` diffs against. Every column is explained in
 * `docs/storage/schema.md`; the two must agree. A change here becomes a migration, under the rules at the
 * top of `../migrations.ts`. FTS5 tables, their triggers and the `WITHOUT ROWID` search-term tables are not
 * modelled by Drizzle and live in hand-written SQL.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name"),
    createdAt: integer("created_at").notNull(),
    settings: text("settings"),
    status: text("status"),
    updatedAt: integer("updated_at").notNull(),
    scope: text("scope").notNull().default("personal"),
    organizationId: integer("organization_id").references(() => organizations.id),
  },
  (table) => [
    unique().on(table.provider, table.externalId),
    index("accounts_by_organization_id").on(table.organizationId),
  ],
)

/** Per account, what a sync remembers between runs: a delta marker, when a list was last complete. */
export const syncCursors = sqliteTable(
  "sync_cursors",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.key] })],
)

export const syncRanges = sqliteTable(
  "sync_ranges",
  {
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    fromKey: integer("from_key").notNull(),
    toKey: integer("to_key").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.fromKey] })],
)

/** Who is fetching a stretch of a chat right now, so two processes do not fetch the same pages. */
export const fetchLeases = sqliteTable(
  "fetch_leases",
  {
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    anchor: text("anchor").notNull(),
    holder: text("holder").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.anchor] })],
)

export const botUpdates = sqliteTable(
  "bot_updates",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    receivedAt: integer("received_at").notNull(),
    handledAt: integer("handled_at"),
    error: text("error"),
    replayedAt: integer("replayed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("bot_updates_by_account_id_received_at_desc").on(table.accountId, desc(table.receivedAt)),
  ],
)

export const syncs = sqliteTable(
  "syncs",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: text("kind").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text("status").notNull(),
    counts: text("counts"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("syncs_by_account_id").on(table.accountId)],
)

export const persons = sqliteTable("persons", {
  id: integer("id").primaryKey(),
  name: text("name"),
  owner: integer("owner").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const identities = sqliteTable(
  "identities",
  {
    id: integer("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    username: text("username"),
    name: text("name"),
    bot: integer("bot"),
    phoneHmac: text("phone_hmac"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    description: text("description"),
    email: text("email"),
    phone: text("phone"),
    nameFolded: text("name_folded"),
  },
  (table) => [
    unique().on(table.provider, table.externalId),
    index("identities_by_email").on(table.email).where(sql`email IS NOT NULL`),
    index("identities_name_to_fold").on(table.id).where(sql`name IS NOT NULL AND name_folded IS NULL`),
  ],
)

export const identityLinks = sqliteTable(
  "identity_links",
  {
    identityId: integer("identity_id")
      .primaryKey()
      .references(() => identities.id),
    personId: integer("person_id")
      .notNull()
      .references(() => persons.id),
    method: text("method").notNull(),
    confidence: real("confidence").notNull(),
    createdAt: integer("created_at").notNull(),
    author: text("author").notNull(),
    source: text("source"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("identity_links_by_person_id").on(table.personId)],
)

export const identityLinkEvents = sqliteTable(
  "identity_link_events",
  {
    id: integer("id").primaryKey(),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    fromPersonId: integer("from_person_id").references(() => persons.id),
    toPersonId: integer("to_person_id")
      .notNull()
      .references(() => persons.id),
    method: text("method").notNull(),
    createdAt: integer("created_at").notNull(),
    author: text("author").notNull(),
  },
  (table) => [
    index("identity_link_events_by_identity_id").on(table.identityId),
    index("identity_link_events_by_from_person_id").on(table.fromPersonId),
    index("identity_link_events_by_to_person_id").on(table.toPersonId),
  ],
)

/** Each profile a person was seen with, a row when it differs from the one before; `identities` holds the latest. */
export const identityRevisions = sqliteTable(
  "identity_revisions",
  {
    id: integer("id").primaryKey(),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    name: text("name"),
    username: text("username"),
    description: text("description"),
    marks: text("marks"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("identity_revisions_by_identity").on(table.identityId, table.createdAt)],
)

export const accountIdentities = sqliteTable(
  "account_identities",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    createdAt: integer("created_at").notNull(),
    /** Their one-to-one chat's newest message, as `refreshRecency` last worked it out: the contact order. */
    lastMessagedAt: integer("last_messaged_at"),
    updatedAt: integer("updated_at").notNull(),
    /** How much this sender's mail to the account looks like spam, a scam or a robot (memo's sender score). */
    mailScore: integer("mail_score"),
    /** JSON array of the signals behind `mail_score`, such as `brand_spoof`. */
    mailSignals: text("mail_signals"),
    mailScoredAt: integer("mail_scored_at"),
    /** 1 when search ranks this sender's mail lower: signs of fraud, not one of the owner's own. */
    mailDemoted: integer("mail_demoted"),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.identityId] }),
    index("account_identities_by_identity_id").on(table.identityId),
  ],
)

export const aliases = sqliteTable(
  "aliases",
  {
    id: integer("id").primaryKey(),
    aliasableType: text("aliasable_type").notNull(),
    aliasableId: integer("aliasable_id").notNull(),
    accountId: integer("account_id").references(() => accounts.id),
    name: text("name").notNull(),
    nameFolded: text("name_folded").notNull(),
    display: integer("display").notNull().default(0),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("aliases_displayed")
      .on(table.aliasableType, table.aliasableId, sql`ifnull(${table.accountId}, 0)`)
      .where(sql`display = 1`),
    uniqueIndex("aliases_by_aliasable_type_aliasable_id_name_folded")
      .on(table.aliasableType, table.aliasableId, table.nameFolded)
      .where(sql`account_id IS NULL AND aliasable_type = 'project' OR account_id IS NULL AND aliasable_type = 'tag'`),
    index("aliases_by_aliasable_type_aliasable_id").on(table.aliasableType, table.aliasableId),
    index("aliases_by_account_id").on(table.accountId),
  ],
)

export const organizations = sqliteTable("organizations", {
  id: integer("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  scope: text("scope").notNull().default("personal"),
  metadata: text("metadata"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
})

/** An address as a record of its own: a `place` mention once confirmed, found again by its folded form. */
export const places = sqliteTable("places", {
  id: integer("id").primaryKey(),
  address: text("address").notNull(),
  folded: text("folded").notNull().unique(),
  author: text("author").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

/** An identity an organization owns; apart from `identity_links`, so one identity can be someone's and an organization's. */
export const organizationIdentities = sqliteTable(
  "organization_identities",
  {
    id: integer("id").primaryKey(),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizations.id),
    method: text("method").notNull(),
    author: text("author").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.identityId, table.organizationId),
    index("organization_identities_by_organization_id").on(table.organizationId),
  ],
)

export const bots = sqliteTable(
  "bots",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull().unique(),
    kind: text("kind").notNull(),
    description: text("description"),
    ownerPersonId: integer("owner_person_id").references(() => persons.id),
    model: text("model"),
    tokenDigest: text("token_digest"),
    lastSeenAt: integer("last_seen_at"),
    disabledAt: integer("disabled_at"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("bots_by_owner_person_id").on(table.ownerPersonId)],
)

export const chats = sqliteTable(
  "chats",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    unreadCount: integer("unread_count"),
    lastMessageAt: integer("last_message_at"),
    participantsCount: integer("participants_count"),
    metadata: text("metadata"),
    updatedAt: integer("updated_at").notNull(),
    username: text("username"),
    /** `NULL` is unknown. Searchable does not follow from it: a chat left keeps its messages. */
    membershipState: text("membership_state"),
    searchable: integer("searchable").notNull().default(1),
    /** Kept by triggers, so a query can choose how a filter reaches the index. */
    messageCount: integer("message_count").notNull().default(0),
    /** When the owner asked `serve` to fetch its member list daily; `NULL` when not tracked. */
    membersTrackedAt: integer("members_tracked_at"),
    description: text("description"),
    detailsFetchedAt: integer("details_fetched_at"),
    createdAt: integer("created_at").notNull(),
    parentChatId: integer("parent_chat_id").references((): AnySQLiteColumn => chats.id),
    scope: text("scope"),
    muted: integer("muted"),
    mutedUntil: integer("muted_until"),
    archived: integer("archived"),
    markedUnread: integer("marked_unread"),
    unreadCountedAt: integer("unread_counted_at"),
    titleFolded: text("title_folded"),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("chats_by_recency").on(table.accountId, desc(table.lastMessageAt)),
    index("chats_title_to_fold").on(table.id).where(sql`title IS NOT NULL AND title_folded IS NULL`),
    index("chats_by_parent_chat_id").on(table.parentChatId),
  ],
)

/** Who is in a chat, as the account last saw it: a list replaces the chat's membership whole. */
export const chatMembers = sqliteTable(
  "chat_members",
  {
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.identityId] }),
    index("chat_members_by_identity_id").on(table.identityId),
  ],
)

/**
 * One stay of a person in a group, from member lists read whole or in part. A return after leaving is a new
 * row. `left_at` is set only from a list read whole: a cut list says nothing about who is missing.
 */
export const memberStays = sqliteTable(
  "member_stays",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    joinedAt: integer("joined_at"),
    invitedByIdentityId: integer("invited_by_identity_id").references(() => identities.id),
    role: text("role"),
    leftAt: integer("left_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("member_stays_open").on(table.chatId, table.identityId).where(sql`left_at IS NULL`),
    index("member_stays_by_identity_id").on(table.identityId),
    index("member_stays_by_invited_by_identity_id").on(table.invitedByIdentityId),
  ],
)

export const memberCounts = sqliteTable(
  "member_counts",
  {
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    /** `YYYY-MM-DD`, UTC; a later read the same day replaces the row. */
    date: text("date").notNull(),
    reportedCount: integer("reported_count"),
    listedCount: integer("listed_count").notNull(),
    completeList: integer("complete_list").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.date] })],
)

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    threadExternalId: text("thread_external_id"),
    senderIdentityId: integer("sender_identity_id").references(() => identities.id),
    // Not a key: the channel a post came from is often not a chat this account is in, and a row for it
    // would appear in the chat list.
    senderChatExternalId: text("sender_chat_external_id"),
    senderName: text("sender_name"),
    sentAt: integer("sent_at").notNull(),
    editedAt: integer("edited_at"),
    deletedAt: integer("deleted_at"),
    text: text("text").notNull(),
    replyToExternalId: text("reply_to_external_id"),
    replyTo: text("reply_to"),
    forward: text("forward"),
    outgoing: integer("outgoing"),
    reactions: text("reactions"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    source: text("source").notNull(),
    normalizedText: text("normalized_text"),
    normalizerVersion: integer("normalizer_version"),
    mentions: text("mentions"),
    updatedAt: integer("updated_at").notNull(),
    threadRootId: integer("thread_root_id").references((): AnySQLiteColumn => messages.id),
    starred: integer("starred"),
    delivery: integer("delivery"),
  },
  (table) => [
    unique().on(table.chatId, table.externalId),
    index("messages_by_time").on(table.chatId, desc(table.sentAt)),
    index("messages_starred_by_time").on(table.chatId, desc(table.sentAt)).where(sql`starred = 1`),
    index("messages_by_reply")
      .on(table.chatId, table.replyToExternalId)
      .where(sql`reply_to_external_id IS NOT NULL AND deleted_at IS NULL`),
    index("messages_by_account").on(table.accountId, table.externalId),
    // Empty once the backfill is done, so every open can ask "anything left?" without reading the table.
    index("messages_to_normalize").on(table.id).where(sql`normalized_text IS NULL AND deleted_at IS NULL`),
    index("messages_by_sender_identity_id").on(table.senderIdentityId),
    index("messages_by_thread_root_id").on(table.threadRootId),
  ],
)

export const messageRevisions = sqliteTable(
  "message_revisions",
  {
    id: integer("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id),
    text: text("text").notNull(),
    editedAt: integer("edited_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("message_revisions_by_message_id").on(table.messageId)],
)

/*
 * Conversations and the links they are built from are derived — rebuilt from `messages`, never the only copy
 * of anything — so every foreign key into them cascades.
 */

/** Each candidate for "the earlier message this one answers", and where it came from. */
export const messageLinks = sqliteTable(
  "message_links",
  {
    id: integer("id").primaryKey(),
    /** The message's chat, kept here so a rebuild finds and drops an old build without reading `messages`. */
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** `NULL`: the source says this message starts a conversation. */
    parentId: integer("parent_id").references(() => messages.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    confidence: real("confidence").notNull(),
    method: text("method").notNull(),
    version: text("version"),
    batch: text("batch"),
    /** The rebuild that wrote a provider or rule link; `NULL` for an agent's, which outlive rebuilds. */
    build: integer("build"),
    createdAt: integer("created_at").notNull(),
    staleAt: integer("stale_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // NULLs are distinct to a UNIQUE constraint: "starts a conversation" and agent links would repeat.
    uniqueIndex("message_links_unique").on(
      table.messageId,
      sql`ifnull(${table.parentId}, 0)`,
      table.source,
      table.kind,
      sql`ifnull(${table.build}, 0)`,
    ),
    index("message_links_by_build").on(table.chatId, table.build),
    index("message_links_by_parent_id").on(table.parentId),
  ],
)

export const messageCounterObservations = sqliteTable(
  "message_counter_observations",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    counter: text("counter").notNull(),
    value: real("value").notNull(),
    createdAt: integer("created_at").notNull(),
    source: text("source").notNull(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.counter] })],
)

/**
 * What a voice message said. Still keyed by chat and external id: a message can be heard before the store
 * holds it, and `message_id` is set once it does. Derived — it can be heard again.
 */
export const messageTranscripts = sqliteTable(
  "message_transcripts",
  {
    id: integer("id").primaryKey(),
    messageId: integer("message_id").references(() => messages.id),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    messageExternalId: text("message_external_id").notNull(),
    text: text("text").notNull(),
    source: text("source").notNull(),
    heardAt: integer("heard_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.chatId, table.messageExternalId),
    index("message_transcripts_by_message_id").on(table.messageId),
  ],
)

/** Messages whose stems are stale. Triggers fill it, because SQL cannot stem; JS empties it. */
export const messageStemsPending = sqliteTable("message_stems_pending", {
  id: integer("id").primaryKey(),
})

/**
 * Each voter's newest vote in a poll, for a messenger that sends votes one by one instead of counting them. Keyed by
 * chat and external id: a vote can arrive before the poll's message is stored.
 */
export const pollVotes = sqliteTable(
  "poll_votes",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    messageExternalId: text("message_external_id").notNull(),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    answers: text("answers").notNull(),
    votedAt: integer("voted_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.chatId, table.messageExternalId, table.identityId),
    index("poll_votes_by_identity_id").on(table.identityId),
  ],
)

/**
 * One row per field a chat changed, written by a trigger on `chats` in the changing statement's transaction. No foreign
 * keys: an older build purges chats without knowing this table, and a trigger drops a purged chat's rows instead.
 */
export const chatRevisions = sqliteTable(
  "chat_revisions",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id").notNull(),
    accountId: integer("account_id").notNull(),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    source: text("source"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("chat_revisions_by_chat_id_created_at").on(table.chatId, table.createdAt),
    index("chat_revisions_by_account_id_old_value")
      .on(table.accountId, table.oldValue)
      .where(sql`field = 'external_id'`),
  ],
)

/** The source and time the `chat_revisions` trigger records, set by the store inside its write and gone by commit. */
export const chatRevisionSource = sqliteTable("chat_revision_source", {
  id: integer("id").primaryKey(),
  source: text("source").notNull(),
  at: integer("at").notNull(),
})

/** Changes to who is in a chat, and to its title, for a messenger whose history is pushed to the store. */
export const chatEvents = sqliteTable(
  "chat_events",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    sourceId: text("source_id").notNull(),
    action: text("action").notNull(),
    actorIdentityId: integer("actor_identity_id").references(() => identities.id),
    title: text("title"),
    happenedAt: integer("happened_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.chatId, table.sourceId),
    index("chat_events_by_chat_id_happened_at").on(table.chatId, table.happenedAt),
    index("chat_events_by_actor_identity_id").on(table.actorIdentityId),
  ],
)

export const chatEventPeople = sqliteTable(
  "chat_event_people",
  {
    chatEventId: integer("chat_event_id")
      .notNull()
      .references(() => chatEvents.id),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
  },
  (table) => [
    primaryKey({ columns: [table.chatEventId, table.identityId] }),
    index("chat_event_people_by_identity_id").on(table.identityId),
  ],
)

/**
 * Each person's newest reaction to a message, for a messenger that sends one person's change at a time; the store
 * derives `messages.reactions` from them. Keyed by chat and external id: a reaction can arrive before its message.
 */
export const messageReactions = sqliteTable(
  "message_reactions",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    messageExternalId: text("message_external_id").notNull(),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    own: integer("own").notNull(),
    reaction: text("reaction"),
    reactedAt: integer("reacted_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.chatId, table.messageExternalId, table.identityId),
    index("message_reactions_by_identity_id").on(table.identityId),
  ],
)

/** One read of a chat's member list. Retention reads presence at a checkpoint from these, not from stays. */
export const memberObservations = sqliteTable(
  "member_observations",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    observedAt: integer("observed_at").notNull(),
    startedAt: integer("started_at"),
    complete: integer("complete").notNull(),
    reportedCount: integer("reported_count"),
    listedCount: integer("listed_count").notNull(),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("member_observations_by_chat_id_observed_at_id").on(table.chatId, table.observedAt, table.id)],
)

/** Who one member-list read saw. */
export const memberObservationMembers = sqliteTable(
  "member_observation_members",
  {
    memberObservationId: integer("member_observation_id")
      .notNull()
      .references(() => memberObservations.id),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    memberStayId: integer("member_stay_id")
      .notNull()
      .references(() => memberStays.id),
  },
  (table) => [
    primaryKey({ columns: [table.memberObservationId, table.identityId] }),
    index("member_observation_members_by_member_stay_id").on(table.memberStayId),
    index("member_observation_members_by_identity_id").on(table.identityId),
  ],
)

export const emailThreads = sqliteTable(
  "email_threads",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    subject: text("subject"),
    lastEmailAt: integer("last_email_at"),
    emailsCount: integer("emails_count").notNull().default(0),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    subjectFolded: text("subject_folded"),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("email_threads_subject_to_fold").on(table.id).where(sql`subject IS NOT NULL AND subject_folded IS NULL`),
  ],
)

export const emails = sqliteTable(
  "emails",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    emailThreadId: integer("email_thread_id")
      .notNull()
      .references(() => emailThreads.id),
    externalId: text("external_id").notNull(),
    subject: text("subject"),
    fromIdentityId: integer("from_identity_id").references(() => identities.id),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    sentAt: integer("sent_at"),
    receivedAt: integer("received_at"),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    snippet: text("snippet"),
    outgoing: integer("outgoing"),
    read: integer("read"),
    flagged: integer("flagged"),
    draft: integer("draft"),
    size: integer("size"),
    headers: text("headers"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    // No constraint: older stores add the column without a rebuild; removing a rule clears it.
    mailRuleId: integer("mail_rule_id"),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("emails_by_time").on(table.accountId, desc(table.sentAt)),
    index("emails_by_mail_rule_id").on(table.mailRuleId).where(sql`mail_rule_id IS NOT NULL`),
    index("emails_by_email_thread_id").on(table.emailThreadId),
    index("emails_by_from_identity_id").on(table.fromIdentityId),
  ],
)

export const mailRules = sqliteTable(
  "mail_rules",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    conditions: text("conditions").notNull(),
    actions: text("actions").notNull(),
    protected: integer("protected").notNull().default(0),
    source: text("source").notNull(),
    reason: text("reason"),
    decidedAt: integer("decided_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.accountId, table.conditions)],
)

export const emailRecipients = sqliteTable(
  "email_recipients",
  {
    id: integer("id").primaryKey(),
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id),
    identityId: integer("identity_id").references(() => identities.id),
    address: text("address").notNull(),
    name: text("name"),
    role: text("role").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("email_recipients_by_email_id").on(table.emailId),
    index("email_recipients_by_identity_id").on(table.identityId),
  ],
)

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    nameFolded: text("name_folded"),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("mailboxes_by_name_folded").on(table.nameFolded),
    index("mailboxes_name_to_fold").on(table.id).where(sql`name_folded IS NULL`),
  ],
)

export const emailMailboxes = sqliteTable(
  "email_mailboxes",
  {
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id),
    mailboxId: integer("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.emailId, table.mailboxId] }),
    index("email_mailboxes_by_mailbox_id").on(table.mailboxId),
  ],
)

export const emailLocations = sqliteTable(
  "email_locations",
  {
    mailboxId: integer("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    uidvalidity: text("uidvalidity").notNull(),
    uid: integer("uid").notNull(),
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.uidvalidity, table.uid] }),
    index("email_locations_by_email_id").on(table.emailId),
  ],
)

export const emailIndexPending = sqliteTable(
  "email_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey(),
    attachableType: text("attachable_type").notNull(),
    attachableId: integer("attachable_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    mime: text("mime"),
    name: text("name"),
    title: text("title"),
    url: text("url"),
    size: integer("size"),
    width: integer("width"),
    height: integer("height"),
    duration: real("duration"),
    providerRef: text("provider_ref"),
    localPath: text("local_path"),
    text: text("text"),
    normalizedText: text("normalized_text"),
    extraction: text("extraction"),
    extractor: text("extractor"),
    extractionError: text("extraction_error"),
    contentSha256: text("content_sha256"),
    extractedAt: integer("extracted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** `fold(name)`, `fold(local_path)`: SQLite's lower() folds ASCII only, so filters compare these. */
    nameFolded: text("name_folded"),
    localPathFolded: text("local_path_folded"),
    contact: text("contact"),
  },
  (table) => [
    unique().on(table.attachableType, table.attachableId, table.position),
    index("attachments_by_name_folded").on(table.nameFolded),
    index("attachments_local_path_to_fold")
      .on(table.id)
      .where(sql`local_path IS NOT NULL AND local_path_folded IS NULL`),
  ],
)

export const transcriptIndexPending = sqliteTable(
  "transcript_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export { documentAnnotationTransfers } from "./schema/document-transfers.js"

export const documents = sqliteTable(
  "documents",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    location: text("location"),
    fileName: text("file_name"),
    extension: text("extension"),
    url: text("url"),
    storage: text("storage"),
    localPath: text("local_path"),
    mime: text("mime"),
    size: integer("size"),
    contentHash: text("content_hash"),
    frontMatter: text("front_matter"),
    body: text("body"),
    normalizedText: text("normalized_text"),
    extraction: text("extraction"),
    extractionError: text("extraction_error"),
    language: text("language"),
    revision: integer("revision").notNull().default(1),
    exportPath: text("export_path"),
    externalCreatedAt: integer("external_created_at"),
    externalUpdatedAt: integer("external_updated_at"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    pinnedFileId: integer("pinned_file_id"),
  },
  (table) => [unique().on(table.accountId, table.externalId)],
)

export const files = sqliteTable(
  "files",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    pathFolded: text("path_folded"),
    parentId: integer("parent_id").references((): AnySQLiteColumn => files.id),
    documentId: integer("document_id").references(() => documents.id),
    mime: text("mime"),
    size: integer("size"),
    contentHash: text("content_hash"),
    url: text("url"),
    externalCreatedAt: integer("external_created_at"),
    externalUpdatedAt: integer("external_updated_at"),
    metadata: text("metadata"),
    seenAt: integer("seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("files_by_account_id_path_folded").on(table.accountId, table.pathFolded),
    index("files_path_to_fold").on(table.id).where(sql`path_folded IS NULL`),
    index("files_by_parent_id").on(table.parentId),
    index("files_by_document_id").on(table.documentId),
  ],
)

export const documentRevisions = sqliteTable(
  "document_revisions",
  {
    id: integer("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id),
    body: text("body").notNull(),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("document_revisions_by_document_id").on(table.documentId)],
)

export { documentIndexPending } from "./schema/document-index-pending.js"

export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey(),
    notableType: text("notable_type").notNull(),
    notableId: integer("notable_id").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    authorType: text("author_type"),
    authorId: integer("author_id"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("notes_by_notable_type_notable_id").on(table.notableType, table.notableId),
    index("notes_by_author_type_author_id").on(table.authorType, table.authorId),
  ],
)

export const noteRevisions = sqliteTable(
  "note_revisions",
  {
    id: integer("id").primaryKey(),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id),
    body: text("body").notNull(),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("note_revisions_by_note_id").on(table.noteId)],
)

export const noteIndexPending = sqliteTable(
  "note_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export const memories = sqliteTable(
  "memories",
  {
    id: integer("id").primaryKey(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    subjectType: text("subject_type"),
    subjectId: integer("subject_id"),
    authorType: text("author_type").notNull(),
    authorId: integer("author_id").notNull(),
    model: text("model"),
    confidence: real("confidence"),
    status: text("status").notNull(),
    lastVerifiedAt: integer("last_verified_at"),
    supersedesId: integer("supersedes_id").references((): AnySQLiteColumn => memories.id),
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("memories_by_subject_type_subject_id").on(table.subjectType, table.subjectId),
    index("memories_by_author_type_author_id").on(table.authorType, table.authorId),
    index("memories_by_supersedes_id").on(table.supersedesId),
  ],
)

export const memoryIndexPending = sqliteTable(
  "memory_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export const calendars = sqliteTable(
  "calendars",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    title: text("title"),
    timezone: text("timezone"),
    accessRole: text("access_role"),
    primaryCalendar: integer("primary_calendar").notNull(),
    synced: integer("synced").notNull(),
    seenAt: integer("seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [unique().on(table.accountId, table.externalId)],
)

export const calendarEntries = sqliteTable(
  "calendar_entries",
  {
    id: integer("id").primaryKey(),
    calendarId: integer("calendar_id")
      .notNull()
      .references(() => calendars.id),
    kind: text("kind").notNull(),
    seriesEntryId: integer("series_entry_id").references((): AnySQLiteColumn => calendarEntries.id),
    eventId: integer("event_id").references(() => events.id),
    eventSeriesId: integer("event_series_id").references(() => eventSeries.id),
    externalId: text("external_id").notNull(),
    icalUid: text("ical_uid"),
    originalStartsAt: integer("original_starts_at"),
    exception: integer("exception").notNull(),
    status: text("status").notNull(),
    title: text("title"),
    description: text("description"),
    location: text("location"),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    allDay: integer("all_day").notNull(),
    startDate: text("start_date"),
    endDate: text("end_date"),
    timezone: text("timezone"),
    recurrence: text("recurrence"),
    recurrenceEndsAt: integer("recurrence_ends_at"),
    eventType: text("event_type"),
    transparency: text("transparency"),
    visibility: text("visibility"),
    ownResponse: text("own_response"),
    organizerIdentityId: integer("organizer_identity_id").references(() => identities.id),
    joinUrl: text("join_url"),
    joinKey: text("join_key"),
    conference: text("conference"),
    url: text("url"),
    sequence: integer("sequence"),
    etag: text("etag"),
    externalUpdatedAt: integer("external_updated_at"),
    metadata: text("metadata"),
    seenAt: integer("seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    seriesExternalId: text("series_external_id"),
  },
  (table) => [
    unique().on(table.calendarId, table.externalId),
    unique().on(table.seriesEntryId, table.originalStartsAt),
    index("calendar_entries_by_calendar_id_starts_at").on(table.calendarId, table.startsAt),
    index("calendar_entries_by_ical_uid").on(table.icalUid).where(sql`ical_uid IS NOT NULL`),
    index("calendar_entries_by_join_key").on(table.joinKey).where(sql`join_key IS NOT NULL`),
    index("calendar_entries_by_calendar_id_series_external_id")
      .on(table.calendarId, table.seriesExternalId)
      .where(sql`series_external_id IS NOT NULL`),
    index("calendar_entries_by_event_id").on(table.eventId),
    index("calendar_entries_by_event_series_id").on(table.eventSeriesId),
    index("calendar_entries_by_event_type_event_id").on(table.eventType, table.eventId),
    index("calendar_entries_by_organizer_identity_id").on(table.organizerIdentityId),
  ],
)

export const calendarEntryRevisions = sqliteTable(
  "calendar_entry_revisions",
  {
    id: integer("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => calendarEntries.id),
    title: text("title"),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    location: text("location"),
    status: text("status"),
    recurrence: text("recurrence"),
    recurrenceEndsAt: integer("recurrence_ends_at"),
    externalUpdatedAt: integer("external_updated_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("calendar_entry_revisions_by_entry_id_created_at").on(table.entryId, table.createdAt)],
)

export const calendarEntryParticipants = sqliteTable(
  "calendar_entry_participants",
  {
    id: integer("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => calendarEntries.id),
    identityId: integer("identity_id").references(() => identities.id),
    email: text("email").notNull(),
    name: text("name"),
    response: text("response"),
    optional: integer("optional").notNull(),
    organizer: integer("organizer").notNull(),
    self: integer("self").notNull(),
    resource: integer("resource").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.entryId, table.email),
    index("calendar_entry_participants_by_identity_id").on(table.identityId),
  ],
)

export const eventIndexPending = sqliteTable(
  "event_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export const eventSeries = sqliteTable("event_series", {
  id: integer("id").primaryKey(),
  title: text("title"),
  recurrence: text("recurrence"),
  origin: text("origin").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey(),
    eventSeriesId: integer("event_series_id").references(() => eventSeries.id),
    title: text("title"),
    description: text("description"),
    location: text("location"),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    timezone: text("timezone"),
    origin: text("origin").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    status: text("status"),
    allDay: integer("all_day"),
    sourceDeletedAt: integer("source_deleted_at"),
  },
  (table) => [index("events_by_time").on(table.startsAt), index("events_by_event_series_id").on(table.eventSeriesId)],
)

export const meetingSeries = sqliteTable(
  "meeting_series",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    externalId: text("external_id").notNull(),
    eventSeriesId: integer("event_series_id").references(() => eventSeries.id),
    title: text("title"),
    description: text("description"),
    kind: text("kind"),
    recurrence: text("recurrence"),
    hostIdentityId: integer("host_identity_id").references(() => identities.id),
    joinUrl: text("join_url"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("meeting_series_by_event_series_id").on(table.eventSeriesId),
    index("meeting_series_by_host_identity_id").on(table.hostIdentityId),
  ],
)

export const meetings = sqliteTable(
  "meetings",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    meetingSeriesId: integer("meeting_series_id").references(() => meetingSeries.id),
    eventId: integer("event_id").references(() => events.id),
    externalId: text("external_id").notNull(),
    title: text("title"),
    description: text("description"),
    location: text("location"),
    joinUrl: text("join_url"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    durationMs: integer("duration_ms"),
    timezone: text("timezone"),
    hostIdentityId: integer("host_identity_id").references(() => identities.id),
    participantsCount: integer("participants_count"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    titleFolded: text("title_folded"),
    joinKey: text("join_key"),
  },
  (table) => [
    unique().on(table.accountId, table.externalId),
    index("meetings_by_join_key").on(table.joinKey).where(sql`join_key IS NOT NULL`),
    index("meetings_join_key_to_fill").on(table.id).where(sql`join_url IS NOT NULL AND join_key IS NULL`),
    index("meetings_by_time").on(table.accountId, desc(table.startedAt)),
    index("meetings_by_account_id_title_folded").on(table.accountId, table.titleFolded),
    index("meetings_title_to_fold").on(table.id).where(sql`title IS NOT NULL AND title_folded IS NULL`),
    index("meetings_by_meeting_series_id").on(table.meetingSeriesId),
    index("meetings_by_event_id").on(table.eventId),
    index("meetings_by_host_identity_id").on(table.hostIdentityId),
  ],
)

export const meetingParticipants = sqliteTable(
  "meeting_participants",
  {
    id: integer("id").primaryKey(),
    meetingId: integer("meeting_id")
      .notNull()
      .references(() => meetings.id),
    identityId: integer("identity_id")
      .notNull()
      .references(() => identities.id),
    displayName: text("display_name"),
    email: text("email"),
    role: text("role"),
    joinedAt: integer("joined_at"),
    leftAt: integer("left_at"),
    durationMs: integer("duration_ms"),
    sessions: text("sessions"),
    externalId: text("external_id"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.meetingId, table.identityId),
    index("meeting_participants_by_identity_id").on(table.identityId),
  ],
)

export const meetingTranscripts = sqliteTable(
  "meeting_transcripts",
  {
    id: integer("id").primaryKey(),
    meetingId: integer("meeting_id")
      .notNull()
      .references(() => meetings.id),
    source: text("source").notNull(),
    format: text("format"),
    language: text("language"),
    contentHash: text("content_hash"),
    externalCreatedAt: integer("external_created_at"),
    supersededAt: integer("superseded_at"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [index("meeting_transcripts_by_meeting_id").on(table.meetingId)],
)

export const meetingTranscriptRows = sqliteTable(
  "meeting_transcript_rows",
  {
    id: integer("id").primaryKey(),
    meetingTranscriptId: integer("meeting_transcript_id")
      .notNull()
      .references(() => meetingTranscripts.id),
    position: integer("position").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    speakerParticipantId: integer("speaker_participant_id").references(() => meetingParticipants.id),
    speakerName: text("speaker_name"),
    text: text("text").notNull(),
    normalizedText: text("normalized_text"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique().on(table.meetingTranscriptId, table.position),
    index("meeting_transcript_rows_by_speaker_participant_id").on(table.speakerParticipantId),
  ],
)

export const meetingChatMessages = sqliteTable(
  "meeting_chat_messages",
  {
    id: integer("id").primaryKey(),
    meetingId: integer("meeting_id")
      .notNull()
      .references(() => meetings.id),
    externalId: text("external_id"),
    sentAt: integer("sent_at").notNull(),
    senderParticipantId: integer("sender_participant_id").references(() => meetingParticipants.id),
    senderName: text("sender_name"),
    recipient: text("recipient"),
    text: text("text").notNull(),
    normalizedText: text("normalized_text"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("meeting_chat_messages_by_meeting_id_external_id")
      .on(table.meetingId, table.externalId)
      .where(sql`external_id IS NOT NULL`),
    index("meeting_chat_messages_by_meeting_id").on(table.meetingId),
    index("meeting_chat_messages_by_sender_participant_id").on(table.senderParticipantId),
  ],
)

export const meetingSummaries = sqliteTable(
  "meeting_summaries",
  {
    id: integer("id").primaryKey(),
    meetingId: integer("meeting_id")
      .notNull()
      .references(() => meetings.id),
    source: text("source").notNull(),
    title: text("title"),
    overview: text("overview"),
    sections: text("sections"),
    nextSteps: text("next_steps"),
    content: text("content"),
    docUrl: text("doc_url"),
    externalCreatedAt: integer("external_created_at"),
    externalUpdatedAt: integer("external_updated_at"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.meetingId, table.source)],
)

/** Keyed by type and id: transcript rows, chat messages and summaries share the queue, and their ids overlap. */
export const meetingIndexPending = sqliteTable(
  "meeting_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export const reminders = sqliteTable(
  "reminders",
  {
    id: integer("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    dueAt: integer("due_at").notNull(),
    timezone: text("timezone").notNull(),
    state: text("state").notNull(),
    revision: integer("revision").notNull().default(1),
    leaseUntil: integer("lease_until"),
    receipt: text("receipt"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("reminders_due").on(table.accountId, table.state, table.dueAt),
    index("reminders_by_task_id").on(table.taskId),
  ],
)

export const projects = sqliteTable(
  "projects",
  {
    id: integer("id").primaryKey(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull(),
    organizationId: integer("organization_id").references(() => organizations.id),
    accountId: integer("account_id").references(() => accounts.id),
    scope: text("scope").notNull().default("personal"),
    ownerType: text("owner_type"),
    ownerId: integer("owner_id"),
    tasksCount: integer("tasks_count").notNull().default(0),
    status: text("status"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    nameFolded: text("name_folded"),
  },
  (table) => [
    index("projects_by_name_folded").on(table.nameFolded),
    index("projects_name_to_fold").on(table.id).where(sql`name_folded IS NULL`),
    index("projects_by_organization_id").on(table.organizationId),
    index("projects_by_account_id").on(table.accountId),
    index("projects_by_owner_type_owner_id").on(table.ownerType, table.ownerId),
  ],
)

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    number: integer("number").notNull(),
    key: text("key").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").notNull(),
    status: text("status").notNull(),
    /** 0 urgent … 4 low, derived from `priority_score` (0 to 1) for builds before store version 41. */
    priority: integer("priority"),
    priorityScore: real("priority_score"),
    agent: text("agent"),
    revision: integer("revision").notNull().default(1),
    parentId: integer("parent_id").references((): AnySQLiteColumn => tasks.id),
    dueAt: integer("due_at"),
    startedAt: integer("started_at"),
    closedAt: integer("closed_at"),
    closedByType: text("closed_by_type"),
    closedById: integer("closed_by_id"),
    closeReason: text("close_reason"),
    authorType: text("author_type").notNull(),
    authorId: integer("author_id").notNull(),
    source: text("source").notNull(),
    packageId: text("package_id").unique(),
    sourceLocator: text("source_locator"),
    sourceKind: text("source_kind"),
    sourceGroup: text("source_group"),
    resolution: text("resolution"),
    verdict: text("verdict"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    nextCheckAt: integer("next_check_at"),
    /** `fold(title)`, `fold(close_reason)`: SQLite's lower() folds ASCII only, so filters compare these. */
    titleFolded: text("title_folded"),
    closeReasonFolded: text("close_reason_folded"),
    category: text("category"),
    claimedBy: text("claimed_by"),
    claimedUntil: integer("claimed_until"),
    closeCertainty: real("close_certainty"),
    closeSuggestedAs: text("close_suggested_as"),
    closeSuggestedByType: text("close_suggested_by_type"),
    closeSuggestedById: integer("close_suggested_by_id"),
    closeSuggestedCertainty: real("close_suggested_certainty"),
    closeSuggestedReason: text("close_suggested_reason"),
    closeSuggestedAt: integer("close_suggested_at"),
  },
  (table) => [
    unique().on(table.projectId, table.number),
    index("tasks_by_title_folded").on(table.titleFolded),
    // Empty once every copy is filled, so each open asks "anything left?" without reading the table; a copy with
    // an index of its own (title_folded, name_folded) needs none.
    index("tasks_close_reason_to_fold")
      .on(table.id)
      .where(sql`close_reason IS NOT NULL AND close_reason_folded IS NULL`),
    index("tasks_by_status").on(table.projectId, table.status, table.dueAt),
    index("tasks_by_project_id_status_next_check_at").on(table.projectId, table.status, table.nextCheckAt),
    index("tasks_by_project_id_source_locator").on(table.projectId, table.sourceLocator),
    index("tasks_by_source_group").on(table.sourceGroup),
    index("tasks_by_parent_id").on(table.parentId),
    index("tasks_by_closed_by_type_closed_by_id").on(table.closedByType, table.closedById),
    index("tasks_by_author_type_author_id").on(table.authorType, table.authorId),
    index("tasks_by_close_suggested_by_type_close_suggested_by_id").on(
      table.closeSuggestedByType,
      table.closeSuggestedById,
    ),
  ],
)

export const taskKeyCounters = sqliteTable("task_key_counters", {
  prefix: text("prefix").primaryKey(),
  tasksCount: integer("tasks_count").notNull(),
})

export const taskAssignments = sqliteTable(
  "task_assignments",
  {
    id: integer("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    assigneeType: text("assignee_type").notNull(),
    assigneeId: integer("assignee_id").notNull(),
    role: text("role").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.taskId, table.assigneeType, table.assigneeId, table.role),
    index("task_assignments_by_assignee_type_assignee_id").on(table.assigneeType, table.assigneeId),
  ],
)

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    actorType: text("actor_type"),
    actorId: integer("actor_id"),
    kind: text("kind").notNull(),
    changes: text("changes"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("task_events_by_task_id").on(table.taskId),
    index("task_events_by_actor_type_actor_id").on(table.actorType, table.actorId),
  ],
)

export const taskPairs = sqliteTable(
  "task_pairs",
  {
    id: integer("id").primaryKey(),
    taskId: integer("task_id").references(() => tasks.id),
    sourceLocator: text("source_locator"),
    otherId: integer("other_id")
      .notNull()
      .references(() => tasks.id),
    score: integer("score").notNull(),
    band: text("band").notNull(),
    levels: text("levels").notNull(),
    reasons: text("reasons").notNull(),
    decision: text("decision").notNull(),
    decidedByType: text("decided_by_type"),
    decidedById: integer("decided_by_id"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.taskId, table.otherId),
    index("task_pairs_by_decision_created_at").on(table.decision, table.createdAt),
    index("task_pairs_by_other_id").on(table.otherId),
    index("task_pairs_by_decided_by_type_decided_by_id").on(table.decidedByType, table.decidedById),
  ],
)

export const taskIndexPending = sqliteTable(
  "task_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export const decisions = sqliteTable(
  "decisions",
  {
    id: integer("id").primaryKey(),
    projectId: integer("project_id").references(() => projects.id),
    statement: text("statement").notNull(),
    status: text("status").notNull(),
    decidedAt: integer("decided_at"),
    supersedesId: integer("supersedes_id").references((): AnySQLiteColumn => decisions.id),
    confirmedByType: text("confirmed_by_type"),
    confirmedById: integer("confirmed_by_id"),
    source: text("source").notNull(),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("decisions_by_project_id").on(table.projectId),
    index("decisions_by_supersedes_id").on(table.supersedesId),
    index("decisions_by_confirmed_by_type_confirmed_by_id").on(table.confirmedByType, table.confirmedById),
  ],
)

export const facts = sqliteTable(
  "facts",
  {
    id: integer("id").primaryKey(),
    type: text("type").notNull(),
    statement: text("statement").notNull(),
    status: text("status").notNull(),
    projectId: integer("project_id").references(() => projects.id),
    subjectType: text("subject_type"),
    subjectId: integer("subject_id"),
    occurredAt: integer("occurred_at"),
    supersedesId: integer("supersedes_id").references((): AnySQLiteColumn => facts.id),
    authorType: text("author_type").notNull(),
    authorId: integer("author_id").notNull(),
    model: text("model"),
    confirmedByType: text("confirmed_by_type"),
    confirmedById: integer("confirmed_by_id"),
    scope: text("scope"),
    source: text("source").notNull(),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("facts_by_project_id").on(table.projectId),
    index("facts_by_subject_type_subject_id").on(table.subjectType, table.subjectId),
    index("facts_by_supersedes_id").on(table.supersedesId),
    index("facts_by_author_type_author_id").on(table.authorType, table.authorId),
    index("facts_by_confirmed_by_type_confirmed_by_id").on(table.confirmedByType, table.confirmedById),
  ],
)

export const proposedActions = sqliteTable(
  "proposed_actions",
  {
    id: integer("id").primaryKey(),
    kind: text("kind").notNull(),
    accountId: integer("account_id").references(() => accounts.id),
    targetType: text("target_type"),
    targetId: integer("target_id"),
    payload: text("payload"),
    reason: text("reason"),
    status: text("status").notNull(),
    proposedByType: text("proposed_by_type").notNull(),
    proposedById: integer("proposed_by_id").notNull(),
    decidedByType: text("decided_by_type"),
    decidedById: integer("decided_by_id"),
    decidedAt: integer("decided_at"),
    executedAt: integer("executed_at"),
    result: text("result"),
    error: text("error"),
    verdict: text("verdict"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("proposed_actions_by_status_created_at").on(table.status, table.createdAt),
    index("proposed_actions_by_account_id").on(table.accountId),
    index("proposed_actions_by_target_type_target_id").on(table.targetType, table.targetId),
    index("proposed_actions_by_proposed_by_type_proposed_by_id").on(table.proposedByType, table.proposedById),
    index("proposed_actions_by_decided_by_type_decided_by_id").on(table.decidedByType, table.decidedById),
  ],
)

/** An audit trail that is itself readable by agents, so it names the target and never stores the arguments' text. */
export const agentActions = sqliteTable(
  "agent_actions",
  {
    id: integer("id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: integer("actor_id").notNull(),
    tool: text("tool").notNull(),
    tier: text("tier").notNull(),
    targetType: text("target_type"),
    targetId: integer("target_id"),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("agent_actions_by_started_at_desc").on(desc(table.startedAt)),
    index("agent_actions_by_actor_type_actor_id").on(table.actorType, table.actorId),
    index("agent_actions_by_target_type_target_id").on(table.targetType, table.targetId),
  ],
)

export { canonicalTags } from "./schema/canonical-tags.js"

export const canonicalAutoTagClaims = sqliteTable(
  "canonical_auto_tag_claims",
  {
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    tagId: integer("tag_id")
      .notNull()
      .references(() => canonicalTags.id),
    algorithm: text("algorithm").notNull(),
    score: real("score").notNull(),
    fields: text("fields").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.tagId] }),
    index("canonical_auto_tag_claims_by_tag_id").on(table.tagId),
  ],
)

export const links = sqliteTable(
  "links",
  {
    id: integer("id").primaryKey(),
    fromType: text("from_type").notNull(),
    fromId: integer("from_id").notNull(),
    toType: text("to_type"),
    toId: integer("to_id"),
    kind: text("kind").notNull(),
    anchor: text("anchor"),
    source: text("source").notNull(),
    targetText: text("target_text"),
    targetFolded: text("target_folded"),
    role: text("role"),
    evidence: text("evidence"),
    metadata: text("metadata"),
    confirmed: integer("confirmed").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    author: text("author"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("links_unresolved").on(table.targetFolded).where(sql`to_id IS NULL`),
    index("links_by_from_type_from_id").on(table.fromType, table.fromId),
    index("links_by_to_type_to_id").on(table.toType, table.toId),
  ],
)

/**
 * Every run of `search messages` and `stats messages show`, with the parameters as the caller gave them — never
 * a message or a result. A row with a name is a saved search; an identical unnamed run counts on its row.
 */
export const searches = sqliteTable(
  "searches",
  {
    id: integer("id").primaryKey(),
    name: text("name").unique(),
    command: text("command").notNull(),
    params: text("params").notNull(),
    language: text("language").notNull(),
    version: integer("version").notNull(),
    fieldsVersion: integer("fields_version").notNull(),
    createdAt: integer("created_at").notNull(),
    lastRunAt: integer("last_run_at"),
    runs: integer("runs").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("searches_history").on(table.command, table.params).where(sql`name IS NULL`),
    index("searches_by_last_run").on(desc(table.lastRunAt)),
  ],
)

/** Polymorphic, so no foreign key to the tagged row: triggers drop a tagging when its chat or message goes. */
export const taggings = sqliteTable(
  "taggings",
  {
    id: integer("id").primaryKey(),
    tagId: integer("tag_id")
      .notNull()
      .references(() => canonicalTags.id),
    taggableType: text("taggable_type").notNull(),
    taggableId: integer("taggable_id").notNull(),
    main: integer("main").notNull().default(0),
    source: text("source").notNull(),
    authorType: text("author_type"),
    authorId: integer("author_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.tagId, table.taggableType, table.taggableId),
    uniqueIndex("taggings_main_topic").on(table.taggableType, table.taggableId).where(sql`main = 1`),
    index("taggings_by_author_type_author_id").on(table.authorType, table.authorId),
  ],
)

export { tagConsolidations, tagRedirects } from "./schema/tag-consolidations.js"

export const entityLinkEvents = sqliteTable(
  "entity_link_events",
  {
    id: integer("id").primaryKey(),
    linkableType: text("linkable_type").notNull(),
    linkableId: integer("linkable_id").notNull(),
    entityType: text("entity_type").notNull(),
    fromEntityId: integer("from_entity_id"),
    toEntityId: integer("to_entity_id"),
    method: text("method").notNull(),
    confidence: real("confidence"),
    author: text("author").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("entity_link_events_by_linkable_type_linkable_id").on(table.linkableType, table.linkableId),
    index("entity_link_events_by_entity_type_to_entity_id").on(table.entityType, table.toEntityId),
  ],
)

export const linkReviews = sqliteTable(
  "link_reviews",
  {
    id: integer("id").primaryKey(),
    linkableType: text("linkable_type").notNull(),
    linkableId: integer("linkable_id").notNull(),
    entityType: text("entity_type").notNull(),
    candidates: text("candidates").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    chosenId: integer("chosen_id"),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.linkableType, table.linkableId, table.entityType),
    index("link_reviews_by_status_created_at").on(table.status, table.createdAt),
  ],
)

export const conversations = sqliteTable(
  "conversations",
  {
    id: integer("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    firstMessageId: integer("first_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Written in batches under a new number, then made current at once: readers never see half a build. */
    build: integer("build").notNull(),
    firstAt: integer("first_at").notNull(),
    lastAt: integer("last_at").notNull(),
    messageCount: integer("message_count").notNull(),
    builtAt: integer("built_at").notNull(),
    algorithmVersion: integer("algorithm_version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("conversations_by_chat").on(table.chatId, table.build, table.firstAt),
    index("conversations_by_first_message_id").on(table.firstMessageId),
  ],
)

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
  },
  // A message is in one conversation of each build; the current build and the one being written overlap.
  (table) => [
    primaryKey({ columns: [table.conversationId, table.messageId] }),
    index("conversation_messages_by_message_id").on(table.messageId),
  ],
)

export const conversationState = sqliteTable("conversation_state", {
  chatId: integer("chat_id")
    .primaryKey()
    .references(() => chats.id, { onDelete: "cascade" }),
  enabledAt: integer("enabled_at").notNull(),
  builtAt: integer("built_at"),
  algorithmVersion: integer("algorithm_version"),
  /** The build readers see; a higher one is being written, or failed. */
  currentBuild: integer("current_build"),
})

/** One model's vector for one chunk text; no owner: chunks of any kind share it, and it goes once none holds the text. */
export const embeddings = sqliteTable(
  "embeddings",
  {
    /** `<provider>:<model>:<dims>` — vectors of different models never mix. */
    model: text("model").notNull(),
    contentHash: text("content_hash").notNull(),
    dims: integer("dims").notNull(),
    /** Float32, little-endian. */
    vector: blob("vector", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.model, table.contentHash] })],
)

/**
 * How far a derived search index is built, one row per index. `watermark` is the highest row id when the
 * index was created: rows above it are indexed by triggers, rows up to it by batches that have reached
 * `filled_through`.
 */
export const searchIndexState = sqliteTable("search_index_state", {
  name: text("name").primaryKey(),
  watermark: integer("watermark").notNull(),
  filledThrough: integer("filled_through").notNull(),
  termsThrough: integer("terms_through").notNull(),
  normalizerVersion: integer("normalizer_version").notNull(),
  builtAt: integer("built_at"),
  /** The stemmer choices and Snowball version that built the stems row (`analyzerIdentity`); NULL until a fill claims it. */
  analyzer: text("analyzer"),
})

/** Derived: rebuilt from senders, recipients, participants, assignees and links, never the only copy of anything. */
export const involvements = sqliteTable(
  "involvements",
  {
    id: integer("id").primaryKey(),
    personId: integer("person_id").references(() => persons.id),
    identityId: integer("identity_id").references(() => identities.id),
    subjectType: text("subject_type").notNull(),
    subjectId: integer("subject_id").notNull(),
    role: text("role").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    scope: text("scope").notNull(),
    accountId: integer("account_id").references(() => accounts.id),
    projectId: integer("project_id").references(() => projects.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("involvements_by_person").on(table.personId, desc(table.occurredAt)),
    index("involvements_by_identity").on(table.identityId, desc(table.occurredAt)),
    index("involvements_by_subject_type_subject_id").on(table.subjectType, table.subjectId),
    index("involvements_by_account_id").on(table.accountId),
    index("involvements_by_project_id").on(table.projectId),
  ],
)

/** Things whose `involvements` rows are stale. Triggers fill it; the drain in JS recomputes and empties it. */
export const involvementPending = sqliteTable(
  "involvement_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)

export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey(),
    chunkableType: text("chunkable_type").notNull(),
    chunkableId: integer("chunkable_id").notNull(),
    position: integer("position").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    contentHash: text("content_hash").notNull(),
    scope: text("scope"),
    accountId: integer("account_id").references(() => accounts.id),
    projectId: integer("project_id").references(() => projects.id),
    occurredAt: integer("occurred_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.chunkableType, table.chunkableId, table.position),
    index("chunks_by_content_hash").on(table.contentHash),
    index("chunks_by_scope_occurred_at").on(table.scope, table.occurredAt),
    index("chunks_by_account_id").on(table.accountId),
    index("chunks_by_project_id").on(table.projectId),
  ],
)

/** Which messages a conversation chunk is cut from; deleting either message deletes the chunk. */
export const chunkMessages = sqliteTable(
  "chunk_messages",
  {
    chunkId: integer("chunk_id")
      .primaryKey()
      .references(() => chunks.id, { onDelete: "cascade" }),
    firstMessageId: integer("first_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    lastMessageId: integer("last_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /**
     * Set on a piece of one message longer than a chunk (`first_message_id` = `last_message_id`): the stretch
     * of its text the piece holds, as offsets. `NULL` is the whole of every message in range.
     */
    textStart: integer("text_start"),
    textEnd: integer("text_end"),
  },
  (table) => [
    index("chunk_messages_by_first_message_id").on(table.firstMessageId),
    index("chunk_messages_by_last_message_id").on(table.lastMessageId),
  ],
)

/**
 * A phone, e-mail address, link, document or known person's name found in one place of one stored text. Derived: `mentions rebuild`
 * finds them again, and a `linked` or `dismissed` decision moves to the new row with the same kind and value.
 */
export const mentions = sqliteTable(
  "mentions",
  {
    id: integer("id").primaryKey(),
    kind: text("kind").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: integer("source_id").notNull(),
    sourceField: text("source_field").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    value: text("value").notNull(),
    domain: text("domain"),
    method: text("method").notNull(),
    version: integer("version").notNull(),
    confidence: real("confidence").notNull(),
    status: text("status").notNull(),
    targetType: text("target_type"),
    targetId: integer("target_id"),
    author: text("author"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.sourceType, table.sourceId, table.sourceField, table.startOffset, table.kind),
    index("mentions_by_kind_value").on(table.kind, table.value),
    index("mentions_by_domain").on(table.domain).where(sql`domain IS NOT NULL`),
    index("mentions_by_status_kind").on(table.status, table.kind),
    index("mentions_by_target_type_target_id").on(table.targetType, table.targetId).where(sql`target_id IS NOT NULL`),
  ],
)

/** Texts written or edited since their mentions were found: queued by triggers, emptied by JS. */
export const mentionPending = sqliteTable(
  "mention_pending",
  {
    sourceType: text("source_type").notNull(),
    sourceId: integer("source_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceType, table.sourceId] })],
)

/**
 * One sqlite-vec `vec0` table per embedding model, `vector_index_<id>`, created at run time with its trigger since
 * its width is the model's: a row per chunk with a vector of that model, rowid `chunks.id` (`vector-index.ts`).
 */
export const vectorIndexes = sqliteTable("vector_indexes", {
  id: integer("id").primaryKey(),
  model: text("model").notNull().unique(),
  dims: integer("dims").notNull(),
  /** 1 once it holds every vector; until then searches scan. */
  ready: integer("ready").notNull(),
  /** The last `content_hash` the fill of older vectors reached. */
  filledThrough: text("filled_through").notNull(),
})

/** Always empty: each changed chunk's id passes through it so that every model's index re-derives its row. */
export const vectorIndexRedo = sqliteTable("vector_index_redo", {
  chunkId: integer("chunk_id").notNull(),
})

/** Settings of the store file itself, shared by every profile, tg and MAX — unlike a profile's config file. */
export const storeSettings = sqliteTable("store_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  at: integer("at").notNull(),
})
