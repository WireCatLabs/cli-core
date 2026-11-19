/**
 * What a blog or a social account publishes, as the store copies it (WordPress first, then Ghost and social posts):
 * the authors, the tags and categories, and the posts and pages. Authors and terms come before the posts that name
 * them. The channel a post is published on (a site, a social account) is read on its own, not as a changes kind.
 */
export const CONTENT_KINDS = ["author", "term", "post"] as const
export type ContentKind = (typeof CONTENT_KINDS)[number]

/** Where a post stands. A trashed post still exists at the source: only a post gone from every list is deleted. */
export const POST_STATUSES = ["draft", "pending", "scheduled", "published", "private", "trashed"] as const
export type PostStatus = (typeof POST_STATUSES)[number]

export const POST_TYPES = ["post", "page"] as const
export type PostType = (typeof POST_TYPES)[number]

export const CHANNEL_KINDS = ["blog", "social", "newsletter"] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export const TERM_KINDS = ["tag", "category"] as const
export type TermKind = (typeof TERM_KINDS)[number]

/**
 * Every record has the source's id. A field left out means the source did not say, and the store keeps what it
 * held; `null` means the source said there is none. Times are epoch milliseconds.
 */
interface ContentRecord {
  externalId: string
  createdAt?: number | null
  updatedAt?: number | null
}

/** A site or a social account. Two profiles on one site read one channel. */
export interface ContentChannel {
  externalId: string
  kind: ChannelKind
  /** `wordpress`, `ghost`, `linkedin`, `linkedin-page`, `x`. */
  network: string
  name: string
  /** The site's address: a sync holds its deletions when it changes, as a moved root would empty the copy. */
  url?: string | null
  handle?: string | null
}

export interface ContentAuthor extends ContentRecord {
  name: string
  /** How the store joins the author to a person it already knows: by this exact address, when read. */
  email?: string | null
  slug?: string | null
}

/** A tag or a category of the source; the store tags a post with the shared tag of the same name. */
export interface ContentTerm extends ContentRecord {
  kind: TermKind
  name: string
  slug?: string | null
  parent?: string | null
}

export interface ContentMedia {
  externalId?: string | null
  url: string
  mime?: string | null
  alt?: string | null
}

export interface ContentPost extends ContentRecord {
  /** The channel's id; left out, the account's only channel. */
  channel?: string | null
  type?: PostType
  /** A social post has none. */
  title?: string | null
  /** Markdown. */
  body?: string | null
  /**
   * The source's text holds markup Markdown cannot keep (blocks, embeds, frames): writing the body back would flatten
   * it, so a write of the body needs the owner's `--replace-body`.
   */
  lossy?: boolean | null
  excerpt?: string | null
  status: PostStatus
  url?: string | null
  slug?: string | null
  publishedAt?: number | null
  /** When a scheduled post goes out. */
  scheduledFor?: number | null
  /** Authors' ids. */
  authors?: string[]
  /** Terms' ids. */
  terms?: string[]
  media?: ContentMedia[]
  /** The post this one is a part of: one text sent to several social channels. */
  parent?: string | null
  /** The source's own mark of this version, sent back with a write so a change made elsewhere is not overwritten. */
  version?: string | null
}

export interface ContentRecords {
  author: ContentAuthor
  term: ContentTerm
  post: ContentPost
}

/** One reading of a post's numbers; each reading is kept, never overwritten. A number the source lacks is absent. */
export interface ContentMetric {
  post: string
  at: number
  views?: number | null
  reactions?: number | null
  comments?: number | null
  shares?: number | null
  clicks?: number | null
  raw?: Record<string, unknown>
}
