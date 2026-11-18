import type { CrmRule } from "../../crm/manifest/manifest.js"
import { at, type Conversion, mapFields } from "../../crm/manifest/map.js"
import type { CrmRaw } from "../../crm/values.js"
import {
  type ContentKind,
  type ContentPost,
  type ContentRecords,
  POST_STATUSES,
  POST_TYPES,
  TERM_KINDS,
} from "../../domain/content.js"
import { htmlToMarkdown } from "../../documents/html-markdown.js"
import type { BodyFormat, ContentManifestEntity } from "./manifest.js"

/** A time: read by `utcEpoch`, so a time the source wrote with no offset is UTC, as WordPress's `*_gmt` fields are. */
const TIME = "time"
type Field = Conversion | typeof TIME

const TIMES = { createdAt: TIME, updatedAt: TIME } as const

/** Each of our fields and how a value the source sent becomes it. */
export const CONTENT_FIELDS: { readonly [K in ContentKind]: Readonly<Record<string, Field>> } = {
  author: { externalId: "id", name: "text", email: "text", slug: "text", ...TIMES },
  term: { externalId: "id", kind: "text", name: "text", slug: "text", parent: "id", ...TIMES },
  post: {
    externalId: "id",
    channel: "id",
    type: "text",
    title: "text",
    excerpt: "text",
    status: "text",
    url: "text",
    slug: "text",
    publishedAt: TIME,
    scheduledFor: TIME,
    authors: "ids",
    terms: "ids",
    parent: "id",
    version: "text",
    ...TIMES,
  },
}

const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i

/** Epoch ms from ISO, or from epoch seconds or ms; an ISO time without an offset is UTC. */
export const utcEpoch = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? (value > 1e11 ? value : value * 1000) : null
  if (typeof value !== "string" || !value.trim()) return null
  const text = value.trim()
  if (/^\d{10,16}$/.test(text)) return utcEpoch(Number(text))
  const parsed = Date.parse(/T\d/.test(text) && !ZONED.test(text) ? `${text}Z` : text)
  return Number.isNaN(parsed) ? null : parsed
}

const REQUIRED: { readonly [K in ContentKind]: Readonly<Record<string, unknown>> } = {
  author: { name: "" },
  term: { name: "" },
  post: {},
}

/**
 * One row as our record of the kind, or null for a row without an id, a term of no known kind, or a post of no known
 * status: a post whose status we cannot say could be taken for published.
 */
export const mapContentRecord = <K extends ContentKind>(
  kind: K,
  map: Readonly<Record<string, CrmRule | undefined>>,
  raw: CrmRaw,
): ContentRecords[K] | null => {
  const types = CONTENT_FIELDS[kind]
  const out = mapFields(
    map,
    Object.fromEntries(Object.entries(types).map(([field, type]) => [field, type === TIME ? "text" : type])) as Record<
      string,
      Conversion
    >,
    raw,
  )
  for (const [field, type] of Object.entries(types))
    if (type === TIME && out[field] !== undefined) out[field] = utcEpoch(out[field])
  if (typeof out.externalId !== "string") return null
  for (const [field, empty] of Object.entries(REQUIRED[kind])) if (out[field] == null) out[field] = empty
  if (kind === "term" && !(TERM_KINDS as readonly unknown[]).includes(out.kind)) return null
  if (kind === "post") {
    if (!(POST_STATUSES as readonly unknown[]).includes(out.status)) return null
    if (out.type !== undefined && !(POST_TYPES as readonly unknown[]).includes(out.type)) out.type = "post"
    const post = out as unknown as ContentPost
    // The source keeps one date per post: it is when a scheduled post goes out, or when a published one went out.
    if (post.status !== "scheduled" && post.scheduledFor !== undefined) post.scheduledFor = null
    if (post.status !== "published" && post.status !== "private" && post.publishedAt !== undefined)
      post.publishedAt = null
  }
  return out as unknown as ContentRecords[K]
}

/** Block comments, frames and embeds that Markdown does not keep: writing the body back would flatten them. */
const LOSSY = /<!--\s*wp:|<(iframe|embed|object|video|audio|script|form)\b/i

/** A post's text as Markdown, and whether its source markup is more than Markdown keeps. */
export const postBodyOf = async (
  entity: ContentManifestEntity,
  raw: CrmRaw,
): Promise<{ body?: string; lossy?: boolean }> => {
  if (!entity.body) return {}
  const read = (where: { path: string; format: BodyFormat }) => {
    const value = at(raw, where.path)
    return typeof value === "string" ? { text: value, format: where.format } : undefined
  }
  const found = read(entity.body) ?? (entity.body.fallback ? read(entity.body.fallback) : undefined)
  if (!found) return {}
  if (found.format === "markdown") return { body: found.text, lossy: false }
  return { body: (await htmlToMarkdown(found.text)).trim(), lossy: LOSSY.test(found.text) }
}
