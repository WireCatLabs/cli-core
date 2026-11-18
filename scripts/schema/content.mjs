import { c, fk, fts, id } from "./columns.mjs"

const deleted = () =>
  c("deleted_at", "integer", {
    note: "gone from a complete list of the source's ids; trash is a status, never this. Sync never hard-deletes",
  })
const synced = () => c("synced_at", "integer", { notnull: true })
const data = () =>
  c("data", "text", {
    notnull: true,
    note: "JSON: the record in the content domain's field names; a field the source did not send keeps its stored value",
  })

export const contentTables = [
  {
    name: "content_channels",
    doc: "A site or a social account a content account publishes on.",
    cols: [
      id(),
      fk("account_id", "accounts", { notnull: true }),
      c("external_id", "text", { notnull: true, note: "its id at the source" }),
      c("kind", "text", { notnull: true, note: "blog, social or newsletter" }),
      c("network", "text", { notnull: true, note: "wordpress, ghost, linkedin, x…" }),
      c("name", "text", { notnull: true }),
      c("url", "text", {
        note: "the site's address; a sync holds its deletions when it changes, as a moved root would empty the copy",
      }),
      c("handle", "text"),
      deleted(),
      synced(),
    ],
    keys: ["UNIQUE (account_id, external_id)"],
  },
  {
    name: "content_authors",
    doc: "A user of a content source who writes posts. Joined to a person by exact e-mail when read; nothing here writes to the people graph.",
    cols: [
      id(),
      fk("account_id", "accounts", { notnull: true }),
      c("external_id", "text", { notnull: true }),
      c("name", "text", { notnull: true }),
      c("email", "text", { note: "only when the sign-in may read it" }),
      data(),
      c("source_updated_at", "integer"),
      deleted(),
      synced(),
    ],
    keys: ["UNIQUE (account_id, external_id)"],
  },
  {
    name: "content_terms",
    doc: "A tag or category of a content source, kept with its own id for writes; a post is tagged with the shared tag of its slug or name.",
    cols: [
      id(),
      fk("account_id", "accounts", { notnull: true }),
      c("external_id", "text", { notnull: true }),
      c("kind", "text", { notnull: true, note: "tag or category" }),
      c("name", "text", { notnull: true }),
      c("slug", "text"),
      c("parent_id", "text", { note: "the source's id of the parent category" }),
      fk("tag_id", "canonical_tags", {
        note: "the shared tag a post with this term gets; none when neither slug nor name is a valid tag",
      }),
      data(),
      c("source_updated_at", "integer"),
      deleted(),
      synced(),
    ],
    keys: ["UNIQUE (account_id, external_id)"],
  },
  {
    name: "content_posts",
    doc: "A post or page of a blog, or a social post, as last synced or written, with its text as Markdown.",
    cols: [
      id(),
      fk("account_id", "accounts", { notnull: true }),
      c("external_id", "text", { notnull: true }),
      c("channel_id", "text", { note: "the channel's id at the source" }),
      c("type", "text", { notnull: true, note: "post or page" }),
      c("title", "text", { note: "a social post has none" }),
      c("title_folded", "text", { notnull: true, note: "the title in one letter case; empty without one" }),
      c("body", "text", { note: "Markdown" }),
      c("content_hash", "text", { notnull: true, note: "sha256 of title and body: a change keeps the old text" }),
      c("status", "text", { notnull: true, note: "draft, pending, scheduled, published, private or trashed" }),
      c("published_at", "integer"),
      c("scheduled_for", "integer", { note: "when a scheduled post goes out" }),
      c("source_created_at", "integer"),
      c("source_updated_at", "integer"),
      c("version", "text", { note: "the source's mark of this version, checked before a write" }),
      c("normalized_text", "text", { notnull: true, note: "title and body normalized for the word index" }),
      data(),
      deleted(),
      synced(),
    ],
    keys: [
      "UNIQUE (account_id, external_id)",
      "INDEX (account_id, status)",
      "INDEX (account_id, published_at)",
    ],
  },
  {
    name: "content_post_revisions",
    doc: "What a sync or a write replaced in a post, and a post the source deleted, kept before the change: the local versions of a post.",
    cols: [
      id(),
      fk("post_id", "content_posts", { notnull: true }),
      c("title", "text"),
      c("body", "text"),
      c("status", "text", { notnull: true }),
      c("content_hash", "text", { notnull: true }),
      c("version", "text"),
      c("reason", "text", { notnull: true, note: "sync, write or deleted: what replaced it" }),
      c("created_at", "integer", { notnull: true }),
    ],
    keys: ["INDEX (post_id, created_at)"],
  },
  {
    name: "content_metrics",
    doc: "One reading of a post's numbers; each reading is a new row, never an overwrite.",
    cols: [
      id(),
      fk("post_id", "content_posts", { notnull: true }),
      c("at", "integer", { notnull: true }),
      c("views", "integer"),
      c("reactions", "integer"),
      c("comments", "integer"),
      c("shares", "integer"),
      c("clicks", "integer"),
      c("raw", "text", { note: "JSON: the source's own numbers" }),
    ],
    keys: ["INDEX (post_id, at)"],
  },
  fts("content_post_words", "Word index over a post's title and text, rowid = `content_posts.id`.", "normalized_text"),
]
