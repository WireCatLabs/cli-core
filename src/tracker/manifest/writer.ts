import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { apiPathOf } from "../../cli/bot/api.js"
import type { ServiceApiWrite } from "../../cli/service-api.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { crmValues } from "../../crm/index.js"
import { at } from "../../crm/manifest/map.js"
import type { TrackerRecords } from "../../domain/tracker.js"
import type { PermissionKey } from "../../sends/permissions.js"
import type { TrackerWrite, TrackerWriter } from "../writer.js"
import { parseTrackerManifest, type TrackerManifest, type TrackerWriteKind } from "./manifest.js"
import { mapTrackerRecord } from "./map.js"
import { type TrackerSlots, trackerInputOf } from "./source.js"

export interface TrackerManifestWriterOptions {
  /** The generated API manifest the operations are named in. */
  api: ServiceApiManifest
  /**
   * Sends one write the way the `api` group does: `serviceApiWriter`, which checks the operation's own keys
   * (`api.issue-create`) and the body against its schema. Nothing else may write for a CLI.
   */
  write: ServiceApiWrite
  /** The command the owner ran, for the write's checks and question. */
  command: Command
}

const unsupported = (message: string) =>
  new CliError("validation_error", message, { reason: "tracker.write-unsupported", sent: false })

const put = (into: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split(".")
  const last = keys.pop() as string
  let inner = into
  for (const key of keys) {
    if (!crmValues.isRaw(inner[key])) inner[key] = {}
    inner = inner[key] as Record<string, unknown>
  }
  inner[last] = value
}

/**
 * A `TrackerWriter` from the manifest's `writes`: each of our fields goes where its rule says inside `"{values}"`, and
 * the row the tracker answers is read by the kind's `map`, as a sync reads it.
 */
export const trackerWriterFromManifest = (input: unknown, options: TrackerManifestWriterOptions): TrackerWriter => {
  const manifest: TrackerManifest = parseTrackerManifest(input, options.api)
  const writes = manifest.writes ?? {}
  const operations = new Map(options.api.operations.map((one) => [one.id, one]))

  const valuesOf = (kind: TrackerWriteKind, fields: object) => {
    const rules = writes[kind]?.fields ?? {}
    const values: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue
      const rule = rules[field]
      if (!rule) throw unsupported(`${manifest.provider} takes no ${field} on a written ${kind}`)
      put(values, rule.to, value)
    }
    return values
  }

  const send = async <K extends TrackerWriteKind>(
    kind: K,
    verb: "create" | "update",
    slots: TrackerSlots,
    confirmed: readonly PermissionKey[] | undefined,
  ): Promise<TrackerRecords[K]> => {
    const call = writes[kind]?.[verb]
    if (!call) throw unsupported(`${manifest.provider} takes no ${kind} ${verb}`)
    // The owner said yes to this write in the tracker's command, so the operation's own key is not asked again.
    const operation = operations.get(call.operation)
    const own = operation ? [["api", ...apiPathOf(operation)].join(".")] : []
    const { result } = await options.write(options.command, call.operation, trackerInputOf(call, slots), {
      confirmed: confirmed?.length ? [...confirmed, ...own] : [],
    })
    const raw = call.items === undefined ? result : at(result, call.items)
    const entity = manifest.entities[kind]
    const record = entity && crmValues.isRaw(raw) ? mapTrackerRecord(kind, entity.map, raw) : null
    if (!record)
      throw new CliError("invalid_response", `${manifest.provider} answered the ${kind} ${verb} with no ${kind}`, {
        sent: true,
      })
    return record
  }

  const offered: TrackerWrite[] = [
    ...(writes.issue?.create ? (["create"] as const) : []),
    ...(writes.issue?.update ? (["update"] as const) : []),
    ...(writes.comment?.create ? (["comment"] as const) : []),
  ]
  return {
    provider: manifest.provider,
    writes: offered,
    createIssue: async (draft, { confirmed }) =>
      send("issue", "create", { values: valuesOf("issue", draft) }, confirmed),
    updateIssue: async (externalId, patch, { confirmed }) =>
      send("issue", "update", { id: externalId, values: valuesOf("issue", patch) }, confirmed),
    comment: async (issue, body, { confirmed }) =>
      send("comment", "create", { values: valuesOf("comment", { issue, body }) }, confirmed),
  }
}
