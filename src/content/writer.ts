import { CliError } from "@wirecat/cli-base"
import type { ConditionalKey } from "../cli/permission-keys.js"
import type { ContentPost, PostType } from "../domain/content.js"
import type { Level, PermissionKey } from "../sends/permissions.js"

/** A post's fields as a write sends them; `null` clears one. The body is Markdown. */
export interface ContentFields {
  title?: string | null
  body?: string
  excerpt?: string | null
  slug?: string | null
  /** Terms' ids at the source; replaces the whole list. */
  terms?: string[]
}

export type ContentDraft = ContentFields & { type?: PostType; channel?: string }

export interface ContentWriteOptions {
  /** Journaled before the call. */
  operationId: string
  /**
   * The version the copy holds. A source whose post has another one now refuses with `content.conflict`: someone
   * changed it since the last sync, and the write would overwrite that.
   */
  version?: string | null
}

/**
 * Writes to one content account. Each answers the whole post as the source holds it after the write, which the store
 * saves over its copy. None of them retries: a write whose answer was lost throws `outcome_unknown`.
 */
export interface ContentWriter {
  readonly provider: string
  /** Always a draft: publishing is its own step, with its own key. */
  createDraft(draft: ContentDraft, options: ContentWriteOptions): Promise<ContentPost>
  update(externalId: string, patch: ContentFields, options: ContentWriteOptions): Promise<ContentPost>
  /** A post already published answers as it is: a second publish never sends it out again. */
  publish(externalId: string, options: ContentWriteOptions): Promise<ContentPost>
  /** At a time in the future; a past time would publish at once. */
  schedule(externalId: string, at: number, options: ContentWriteOptions): Promise<ContentPost>
  /** Back to a draft. */
  unpublish(externalId: string, options: ContentWriteOptions): Promise<ContentPost>
  /** Into the source's trash, from which it comes back; `force` deletes it for good. */
  trash(externalId: string, options: ContentWriteOptions & { force?: boolean }): Promise<ContentPost | null>
}

/** What a writer throws when the post changed at the source since the copy's version. */
export const contentConflict = (message = "the post changed at the source since the last sync") =>
  new CliError("validation_error", `${message}; sync and try again`, { reason: "content.conflict" })

/** The key publishing checks, the same the `api` group checks for a `status` that publishes (cli-core #3113). */
export const POSTS_PUBLISH_KEY: PermissionKey = "posts.publish"
/** Deleting for good, past the trash. */
export const POSTS_DELETE_FORCE_KEY: PermissionKey = "posts.delete.force"

/** The keys the content writes check beyond their command paths, for `commandPermissions({ extra })`. */
export const CONTENT_WRITE_KEYS: readonly PermissionKey[] = [POSTS_PUBLISH_KEY, POSTS_DELETE_FORCE_KEY]

/**
 * Built in, and only ever tightening (WC-PERM-7). Every write asks: a draft is not public, but publishing is, and the
 * owner chose `ask` for it too (NEED-2720 B). A deletion for good asks as well.
 */
export const CONTENT_WRITE_DEFAULTS: Readonly<Record<PermissionKey, Level>> = {
  "posts.create": "ask",
  "posts.update": "ask",
  [POSTS_PUBLISH_KEY]: "ask",
  "posts.schedule": "ask",
  "posts.unpublish": "ask",
  "posts.delete": "ask",
  [POSTS_DELETE_FORCE_KEY]: "ask",
}

/**
 * Every key a content write command may check beyond its own path, for `commandPermissions({ alsoChecks })`, so its
 * `--dry-run` names each.
 */
export const contentAlsoChecks = (path: readonly string[]): readonly (PermissionKey | ConditionalKey)[] => {
  const [noun, command] = path
  if (path.length !== 2 || noun !== "posts") return []
  if (command === "schedule") return [POSTS_PUBLISH_KEY]
  if (command === "update") return [{ key: POSTS_PUBLISH_KEY, when: "the post is published or scheduled" }]
  if (command === "delete") return [{ key: POSTS_DELETE_FORCE_KEY, when: "--force" }]
  return []
}
