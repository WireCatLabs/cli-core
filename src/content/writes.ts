import { CliError, isCliError } from "@wirecat/cli-base"
import type { ContentPost } from "../domain/content.js"
import type { AppIdentity } from "../ports/app.js"
import type { Warn } from "../runs/events.js"
import { type Asker, type GuardSettings, guardFor, type SendGuard } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import { keyedGuard } from "../sends/keyed-guard.js"
import { DEFAULT_PERMISSIONS, levelFor, type PermissionKey } from "../sends/permissions.js"
import { newOperationId } from "../sends/send-id.js"
import type { ContentItem } from "../store/sqlite/content.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import type { ContentSource } from "./source.js"
import {
  CONTENT_WRITE_DEFAULTS,
  type ContentDraft,
  type ContentFields,
  type ContentWriter,
  contentConflict,
  POSTS_DELETE_FORCE_KEY,
  POSTS_PUBLISH_KEY,
} from "./writer.js"

/** What a CLI hands the content writes for one profile. */
export interface ContentWrites {
  writer: ContentWriter
  app: AppIdentity
  /** The profile's levels, read on every write so a config change applies at once. */
  settings: () => Omit<GuardSettings, "sendsPerHour"> & Partial<Pick<GuardSettings, "sendsPerHour">>
  env?: NodeJS.ProcessEnv
  warn?: Warn
}

export interface ContentWriteContext {
  store: MessageStore
  account: AccountKey
  writes: ContentWrites
  /** A terminal's question, or an agent's go-ahead. */
  ask: Asker
  /**
   * Reads the post again before a write, so the keys follow the source's status and not a stale copy: a scheduled post
   * whose time passed is published by any edit, and a copy may still call it scheduled.
   */
  source?: () => ContentSource
  now?: () => number
}

export interface ContentWritten {
  operationId: string
  post: ContentPost
  /** The write was not sent: the post already stood that way. */
  unchanged?: true
}

const PUBLIC = new Set(["published", "scheduled"])

const guardOf = (context: ContentWriteContext, extra: readonly PermissionKey[]): SendGuard => {
  const settings = context.writes.settings()
  const defaults = { ...DEFAULT_PERMISSIONS, ...CONTENT_WRITE_DEFAULTS, ...settings.permissionDefaults }
  return keyedGuard(
    (ask) =>
      guardFor(
        context.writes.app,
        { ...settings, sendsPerHour: Number.MAX_SAFE_INTEGER, permissionDefaults: defaults },
        context.writes.warn ?? (() => {}),
        context.writes.env,
        ask,
      ),
    context.ask,
    (key) => levelFor(settings.permissions, key, defaults).level,
    extra,
  )
}

/** Checked and journaled once; a lost answer is `outcome_unknown`, and the owner syncs before writing again. */
const written = async <T>(
  context: ContentWriteContext,
  key: PermissionKey,
  extra: PermissionKey[],
  operationId: string,
  act: (confirmed: readonly PermissionKey[]) => Promise<T>,
): Promise<T> => {
  try {
    // The keys the owner was asked about here (an `ask` level) need not be asked again by a writer's own call; a key
    // allowed here was asked about by nobody, so it confirms nothing.
    const settings = context.writes.settings()
    const defaults = { ...DEFAULT_PERMISSIONS, ...CONTENT_WRITE_DEFAULTS, ...settings.permissionDefaults }
    const asked = [key, ...extra].filter((one) => levelFor(settings.permissions, one, defaults).level === "ask")
    return await guardedWrite(guardOf(context, extra), { chatId: null, kind: "edit", key, operationId }, () =>
      act(asked),
    )
  } catch (error) {
    if (!isCliError(error) || error.code !== "outcome_unknown") throw error
    throw new CliError(
      "outcome_unknown",
      `${error.message} — sync and look at the post before writing again: a repeat may write it twice`,
      { ...error.details, operation_id: operationId },
    )
  }
}

/**
 * The post as the copy holds it, read again from the source first when it can be: the keys then follow its status
 * there. A post changed at the source since the copy's version is refused, its new state kept for the owner to look at.
 */
const copyOf = async (context: ContentWriteContext, externalId: string): Promise<ContentItem<"post">> => {
  const stored = await context.store.content.get(context.account, "post", externalId)
  if (context.source && stored?.deletedAt === null) {
    const now = context.now?.() ?? Date.now()
    const live = await context.source().get("post", externalId)
    if (live) await context.store.content.save(context.account, "post", [live], now)
    else await context.store.content.markDeleted(context.account, "post", externalId, now)
    const was = stored.record.version
    if (live && was != null && live.version != null && live.version !== was) throw contentConflict()
  }
  const found = await context.store.content.get(context.account, "post", externalId)
  if (!found || found.deletedAt !== null)
    throw new CliError("not_found", `no post ${externalId} in this profile's copy; run sync, then try again`)
  return found
}

/** The source's answer into the copy; what it replaced stays as a revision. */
const kept = async (context: ContentWriteContext, post: ContentPost, operationId: string): Promise<ContentWritten> => {
  try {
    await context.store.content.save(context.account, "post", [post], context.now?.() ?? Date.now(), {
      reason: "write",
    })
  } catch (error) {
    throw new CliError(
      "invalid_response",
      `the source wrote post ${post.externalId}, but the local store did not keep it ` +
        `(${error instanceof Error ? error.message : String(error)}); sync to store it — do not write it again`,
      { operation_id: operationId, external_id: post.externalId, sent: true },
    )
  }
  return { operationId, post }
}

const blank = (fields: ContentFields) => Object.values(fields).every((one) => one === undefined)

/** A new draft. Publishing is its own step. */
export const createPost = async (context: ContentWriteContext, draft: ContentDraft): Promise<ContentWritten> => {
  if (!draft.title?.trim() && !draft.body?.trim())
    throw new CliError("validation_error", "a new post needs a title or a body", { reason: "content.empty" })
  const operationId = newOperationId()
  const post = await written(context, "posts.create", [], operationId, (confirmed) =>
    context.writes.writer.createDraft(draft, { operationId, confirmed }),
  )
  return kept(context, post, operationId)
}

/**
 * Changes a post's fields. A change to a published or scheduled post is public, so it also checks `posts.publish`. A
 * body written over a post whose markup Markdown cannot keep needs `replaceBody`: it would flatten the blocks.
 */
export const updatePost = async (
  context: ContentWriteContext,
  externalId: string,
  fields: ContentFields,
  options: { replaceBody?: boolean } = {},
): Promise<ContentWritten> => {
  if (blank(fields))
    throw new CliError("validation_error", "nothing to change: name a field", { reason: "content.empty" })
  const copy = await copyOf(context, externalId)
  if (fields.body !== undefined && copy.record.lossy && !options.replaceBody)
    throw new CliError(
      "validation_error",
      `post ${externalId} holds blocks or embeds that Markdown cannot keep; writing its body would flatten them. ` +
        "Change only its title, excerpt or tags, or add --replace-body to replace the body anyway",
      { reason: "content.lossy-body", param: "--replace-body" },
    )
  const operationId = newOperationId()
  const extra = PUBLIC.has(copy.record.status) ? [POSTS_PUBLISH_KEY] : []
  const post = await written(context, "posts.update", extra, operationId, (confirmed) =>
    context.writes.writer.update(externalId, fields, { operationId, version: copy.record.version ?? null, confirmed }),
  )
  return kept(context, post, operationId)
}

/** Publishes now. A post the copy holds as published is answered as it is, and nothing is sent. */
export const publishPost = async (context: ContentWriteContext, externalId: string): Promise<ContentWritten> => {
  const copy = await copyOf(context, externalId)
  if (copy.record.status === "published") return { operationId: "", post: copy.record, unchanged: true }
  const operationId = newOperationId()
  const post = await written(context, POSTS_PUBLISH_KEY, [], operationId, (confirmed) =>
    context.writes.writer.publish(externalId, { operationId, version: copy.record.version ?? null, confirmed }),
  )
  return kept(context, post, operationId)
}

/** Publishes at `at`, which must be ahead: a source publishes a post dated in the past at once. */
export const schedulePost = async (
  context: ContentWriteContext,
  externalId: string,
  at: number,
): Promise<ContentWritten> => {
  const now = context.now?.() ?? Date.now()
  if (!Number.isFinite(at) || at <= now)
    throw new CliError(
      "validation_error",
      "--at is in the past, and the source would publish the post at once; give a later time, or use posts publish",
      { reason: "content.schedule-past", param: "--at" },
    )
  const copy = await copyOf(context, externalId)
  if (copy.record.status === "published")
    throw new CliError("validation_error", `post ${externalId} is already published`, {
      reason: "content.already-published",
    })
  const operationId = newOperationId()
  const post = await written(context, POSTS_PUBLISH_KEY, [], operationId, (confirmed) =>
    context.writes.writer.schedule(externalId, at, { operationId, version: copy.record.version ?? null, confirmed }),
  )
  return kept(context, post, operationId)
}

export const unpublishPost = async (context: ContentWriteContext, externalId: string): Promise<ContentWritten> => {
  const copy = await copyOf(context, externalId)
  if (copy.record.status === "draft") return { operationId: "", post: copy.record, unchanged: true }
  const operationId = newOperationId()
  const post = await written(context, "posts.unpublish", [], operationId, (confirmed) =>
    context.writes.writer.unpublish(externalId, { operationId, version: copy.record.version ?? null, confirmed }),
  )
  return kept(context, post, operationId)
}

/** Into the trash; `force` deletes for good and checks its own key. The copy keeps the last text as a revision. */
export const deletePost = async (
  context: ContentWriteContext,
  externalId: string,
  options: { force?: boolean } = {},
): Promise<{ operationId: string; post: ContentPost | null; deleted: boolean }> => {
  const copy = await copyOf(context, externalId)
  const operationId = newOperationId()
  const post = await written(
    context,
    "posts.delete",
    options.force ? [POSTS_DELETE_FORCE_KEY] : [],
    operationId,
    (confirmed) =>
      context.writes.writer.trash(externalId, {
        operationId,
        confirmed,
        version: copy.record.version ?? null,
        ...(options.force ? { force: true } : {}),
      }),
  )
  if (post && !options.force) return { ...(await kept(context, post, operationId)), deleted: false }
  await context.store.content.markDeleted(context.account, "post", externalId, context.now?.() ?? Date.now())
  return { operationId, post: null, deleted: true }
}
