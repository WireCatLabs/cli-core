import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import type { ApiCommandInput } from "../../cli/bot/api.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { crmValues } from "../../crm/index.js"
import type { CrmOperationCall } from "../../crm/manifest/manifest.js"
import { markdownToHtml } from "../../documents/html-markdown.js"
import type { ContentPost, PostType, TermKind } from "../../domain/content.js"
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

// A manifest without `writes.page` reads pages, and they are written in the source's own editor.
const pagesUnwritten = () =>
  new CliError("validation_error", "this CLI writes posts, not pages", { reason: "content.write-unsupported" })

const mapType = (entity: { map: Readonly<Record<string, unknown>> }) => {
  const rule = entity.map.type
  return rule && typeof rule === "object" && "value" in rule ? rule.value : "post"
}

/** `posts.delete.force` → `delete.force`: the action, whatever route it is on. */
const actionOf = (key: string) => key.slice(key.indexOf(".") + 1)

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`

/**
 * A `ContentWriter` from the manifest's `writes`. Each write reads the post first: an old version is a conflict, and a
 * publish of a published post sends nothing. A body goes as the source keeps text (HTML from Markdown).
 */
export const contentWriterFromManifest = (input: unknown, options: ContentManifestWriterOptions): ContentWriter => {
  const manifest = parseContentManifest(input, options.api)
  const writes = manifest.writes
  if (!writes) throw new CliError("configuration_error", "the source manifest has no writes")
  const entities = manifest.entities.post ?? []
  const [first] = entities
  if (!first) throw new CliError("configuration_error", "the source manifest has no post entity")
  const callsOf = (type: PostType | undefined) => {
    if (type === undefined || type === "post") return writes
    if (!writes.page) throw pagesUnwritten()
    return { ...writes.page, fields: writes.page.fields ?? writes.fields }
  }

  const postOf = async (answer: unknown, type: PostType): Promise<ContentPost | null> => {
    const raw = crmValues.isRaw(answer) && crmValues.isRaw(answer.previous) && answer.deleted === true ? null : answer
    if (!crmValues.isRaw(raw)) return null
    // Posts and pages map alike but for their type: the answer is read by the entity of the type written.
    for (const entity of entities) {
      const post = mapContentRecord("post", entity.map, raw)
      if (post && (post.type ?? "post") === type)
        return Object.assign(post, { channel: SITE_CHANNEL }, await postBodyOf(entity, raw))
    }
    const post = mapContentRecord("post", first.map, raw)
    if (!post) throw new CliError("invalid_response", `${manifest.provider} answered a write with no post`)
    return Object.assign(post, { channel: SITE_CHANNEL }, await postBodyOf(first, raw))
  }

  const bodyOf = async (fields: ContentFields, type: PostType): Promise<Record<string, unknown>> => {
    const to = callsOf(type).fields
    const entity = entities.find((one) => mapType(one) === type) ?? first
    const html = entity.body !== undefined && entity.body.format !== "markdown"
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
    if (fields.title !== undefined && to.title) put(to.title, fields.title ?? "")
    if (fields.excerpt !== undefined && to.excerpt) put(to.excerpt, fields.excerpt ?? "")
    if (fields.slug !== undefined && to.slug) put(to.slug, fields.slug ?? "")
    if (fields.body !== undefined && to.body) put(to.body, html ? await markdownToHtml(fields.body) : fields.body)
    if (fields.terms?.length && !to.terms)
      throw new CliError("validation_error", `${manifest.provider} takes no tags or categories on a ${type}`, {
        reason: "content.write-unsupported",
      })
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
    const type = found.type ?? "post"
    return { found, type, calls: callsOf(type) }
  }

  const send = async (
    call: CrmOperationCall,
    slots: { id?: string; at?: string },
    confirmed: readonly PermissionKey[] | undefined,
    body?: Record<string, unknown>,
  ) => {
    const base = call.body === undefined ? {} : (fill(call.body, slots) as Record<string, unknown>)
    // The owner said yes to this write in the content command, so its one call is not asked about again; a key that
    // command did not ask about, as the publish key for a post that is published at the source now, still is. A page's
    // call checks its own route's keys (`pages.publish`): the one for the action the owner said yes to goes with it.
    const operation = options.api.operations.find((one) => one.id === call.operation)
    const route = (operation?.permissions ?? [])
      .map((one) => one.key)
      .filter((key) => confirmed?.some((yes) => actionOf(yes) === actionOf(key)) && !confirmed.includes(key))
    const { result } = await options.write(
      options.command,
      call.operation,
      inputOf(call, slots, body === undefined && call.body === undefined ? undefined : { ...base, ...body }),
      !confirmed?.length
        ? []
        : [...confirmed, ...route, ...(operation?.command === undefined ? [] : [`api.${operation.command}`])],
    )
    return result
  }

  const updated = async (
    { type, calls }: Awaited<ReturnType<typeof current>>,
    externalId: string,
    body: Record<string, unknown>,
    confirmed: readonly PermissionKey[] | undefined,
  ) => {
    const post = await postOf(await send(calls.update, { id: externalId }, confirmed, body), type)
    if (!post) throw new CliError("invalid_response", `${manifest.provider} answered an update with no post`)
    return post
  }

  return {
    provider: manifest.provider,
    async createDraft(draft, options_) {
      const type = draft.type ?? "post"
      const calls = callsOf(type)
      const post = await postOf(await send(calls.create, {}, options_.confirmed, await bodyOf(draft, type)), type)
      if (!post) throw new CliError("invalid_response", `${manifest.provider} answered a create with no post`)
      return post
    },
    async update(externalId, patch, options_) {
      const now = await current(externalId, options_)
      return updated(now, externalId, await bodyOf(patch, now.type), options_.confirmed)
    },
    async publish(externalId, options_) {
      const now = await current(externalId, options_)
      if (now.found.status === "published") return now.found
      return updated(now, externalId, { ...writes.publish }, options_.confirmed)
    },
    async schedule(externalId, when, options_) {
      const now = await current(externalId, options_)
      return updated(
        now,
        externalId,
        fill(writes.schedule, { at: iso(when) }) as Record<string, unknown>,
        options_.confirmed,
      )
    },
    async unpublish(externalId, options_) {
      const now = await current(externalId, options_)
      return updated(now, externalId, { ...writes.unpublish }, options_.confirmed)
    },
    async trash(externalId, options_) {
      const { type, calls } = await current(externalId, options_)
      if (options_.force) {
        if (!calls.delete)
          throw new CliError("validation_error", `${manifest.provider} takes no deletion past the trash`, {
            reason: "content.write-unsupported",
          })
        await send(calls.delete, { id: externalId }, options_.confirmed)
        return null
      }
      return postOf(await send(calls.trash, { id: externalId }, options_.confirmed), type)
    },
  }
}
