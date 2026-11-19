import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import type { ApiCommandInput } from "../../cli/bot/api.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { crmValues } from "../../crm/index.js"
import { markdownToHtml } from "../../documents/html-markdown.js"
import type { ContentPost, TermKind } from "../../domain/content.js"
import type { PermissionKey } from "../../sends/permissions.js"
import type { ContentSource } from "../source.js"
import { type ContentFields, type ContentWriteOptions, type ContentWriter, contentConflict } from "../writer.js"
import { parseContentManifest } from "./manifest.js"
import { mapContentRecord, postBodyOf } from "./map.js"
import { fill, inputOf, SITE_CHANNEL } from "./source.js"

/**
 * Sends one write the way the `api` group does: `serviceApiWriter` bound to the invoking command, which checks the
 * profile's keys (the publish value keys, the force-delete key) and asks. Nothing else may write for a CLI.
 */
export type ContentWriteCall = (
  command: Command,
  operation: string,
  input: ApiCommandInput,
  /** The keys the owner was already asked about (level `ask`); with any, the call's own `api.<operation>` too. */
  confirmed: readonly PermissionKey[],
) => Promise<{ operation_id: string; result: unknown }>

export interface ContentManifestWriterOptions {
  api: ServiceApiManifest
  write: ContentWriteCall
  /** The command the owner ran, for the write's checks and question. */
  command: Command
  /** The source built from the same manifest: a write reads the post first, for its version and its status. */
  source: ContentSource
}

// The manifest's writes name the post calls; a page is read, and written in the source's own editor for now.
const pagesUnwritten = () =>
  new CliError("validation_error", "this CLI writes posts, not pages", { reason: "content.write-unsupported" })

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`

/**
 * A `ContentWriter` from the manifest's `writes`. Each write reads the post first: an old version is a conflict, and a
 * publish of a published post sends nothing. A body goes as the source keeps text (HTML from Markdown).
 */
export const contentWriterFromManifest = (input: unknown, options: ContentManifestWriterOptions): ContentWriter => {
  const manifest = parseContentManifest(input, options.api)
  const writes = manifest.writes
  if (!writes) throw new CliError("configuration_error", "the source manifest has no writes")
  const [entity] = manifest.entities.post ?? []
  if (!entity) throw new CliError("configuration_error", "the source manifest has no post entity")
  const html = entity.body !== undefined && entity.body.format !== "markdown"

  const postOf = async (answer: unknown): Promise<ContentPost | null> => {
    const raw = crmValues.isRaw(answer) && crmValues.isRaw(answer.previous) && answer.deleted === true ? null : answer
    if (!crmValues.isRaw(raw)) return null
    const post = mapContentRecord("post", entity.map, raw)
    if (!post) throw new CliError("invalid_response", `${manifest.provider} answered a write with no post`)
    return Object.assign(post, { channel: SITE_CHANNEL }, await postBodyOf(entity, raw))
  }

  const bodyOf = async (fields: ContentFields): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {}
    const put = (path: string, value: unknown) => {
      const keys = path.split(".")
      const last = keys.pop() as string
      let inner = out
      for (const key of keys) {
        if (!crmValues.isRaw(inner[key])) inner[key] = {}
        inner = inner[key] as Record<string, unknown>
      }
      inner[last] = value
    }
    const to = writes.fields
    if (fields.title !== undefined && to.title) put(to.title, fields.title ?? "")
    if (fields.excerpt !== undefined && to.excerpt) put(to.excerpt, fields.excerpt ?? "")
    if (fields.slug !== undefined && to.slug) put(to.slug, fields.slug ?? "")
    if (fields.body !== undefined && to.body) put(to.body, html ? await markdownToHtml(fields.body) : fields.body)
    if (fields.terms !== undefined && to.terms) {
      const kinds = new Map<TermKind, string[]>()
      for (const term of fields.terms) {
        const found = await options.source.get("term", term)
        if (!found) throw new CliError("not_found", `no tag or category ${term} at ${manifest.provider}`)
        kinds.set(found.kind, [...(kinds.get(found.kind) ?? []), term])
      }
      // A numeric id goes as a number: the API's body schema types WordPress's term lists as integers.
      for (const [kind, name] of Object.entries(to.terms))
        if (name)
          put(
            name,
            (kinds.get(kind as TermKind) ?? []).map((one) => (/^\d+$/.test(one) ? Number(one) : one)),
          )
    }
    return out
  }

  /** The post as the source holds it now, checked against the copy's version. */
  const current = async (externalId: string, { version }: ContentWriteOptions) => {
    const found = await options.source.get("post", externalId)
    if (!found) throw new CliError("not_found", `${manifest.provider} has no post ${externalId}; sync, then try again`)
    if (version != null && found.version != null && found.version !== version) throw contentConflict()
    if (found.type === "page") throw pagesUnwritten()
    return found
  }

  const send = async (
    call: typeof writes.update,
    slots: { id?: string; at?: string },
    confirmed: readonly PermissionKey[] | undefined,
    body?: Record<string, unknown>,
  ) => {
    const base = call.body === undefined ? {} : (fill(call.body, slots) as Record<string, unknown>)
    // The owner said yes to this write in the content command, so its one call is not asked about again; a key that
    // command did not ask about, as the publish key for a post that is published at the source now, still is.
    const own = options.api.operations.find((one) => one.id === call.operation)?.command
    const { result } = await options.write(
      options.command,
      call.operation,
      inputOf(call, slots, body === undefined && call.body === undefined ? undefined : { ...base, ...body }),
      !confirmed?.length ? [] : [...confirmed, ...(own === undefined ? [] : [`api.${own}`])],
    )
    return result
  }

  const updated = async (
    externalId: string,
    body: Record<string, unknown>,
    confirmed: readonly PermissionKey[] | undefined,
  ) => {
    const post = await postOf(await send(writes.update, { id: externalId }, confirmed, body))
    if (!post) throw new CliError("invalid_response", `${manifest.provider} answered an update with no post`)
    return post
  }

  return {
    provider: manifest.provider,
    async createDraft(draft, options_) {
      if (draft.type === "page") throw pagesUnwritten()
      const post = await postOf(await send(writes.create, {}, options_.confirmed, await bodyOf(draft)))
      if (!post) throw new CliError("invalid_response", `${manifest.provider} answered a create with no post`)
      return post
    },
    async update(externalId, patch, options_) {
      await current(externalId, options_)
      return updated(externalId, await bodyOf(patch), options_.confirmed)
    },
    async publish(externalId, options_) {
      const found = await current(externalId, options_)
      if (found.status === "published") return found
      return updated(externalId, { ...writes.publish }, options_.confirmed)
    },
    async schedule(externalId, when, options_) {
      await current(externalId, options_)
      return updated(
        externalId,
        fill(writes.schedule, { at: iso(when) }) as Record<string, unknown>,
        options_.confirmed,
      )
    },
    async unpublish(externalId, options_) {
      await current(externalId, options_)
      return updated(externalId, { ...writes.unpublish }, options_.confirmed)
    },
    async trash(externalId, options_) {
      await current(externalId, options_)
      if (options_.force) {
        if (!writes.delete)
          throw new CliError("validation_error", `${manifest.provider} takes no deletion past the trash`, {
            reason: "content.write-unsupported",
          })
        await send(writes.delete, { id: externalId }, options_.confirmed)
        return null
      }
      return postOf(await send(writes.trash, { id: externalId }, options_.confirmed))
    },
  }
}
