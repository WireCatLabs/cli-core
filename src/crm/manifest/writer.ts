import { CliError, isCliError } from "@wirecat/cli-base"
import { type ServiceApiPermissionsInput, serviceApiOwnKeys } from "../../cli/service-api.js"
import { type ServiceApiCall, type ServiceApiCallOptions, serviceApiSend } from "../../cli/service-api-call.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { CrmKind, CrmRecords } from "../../domain/crm.js"
import { DEAL_KINDS, type DealKind } from "../../domain/deals.js"
import type { PermissionKey } from "../../sends/permissions.js"
import { fullName, id, isRaw, text } from "../values.js"
import { CRM_VERBS, type CrmVerb, type CrmWriteCapabilities, type CrmWriteOptions, type CrmWriter } from "../writer.js"
import { type CrmWrites, foldFieldName } from "../writes.js"
import {
  type CrmFixedValue,
  type CrmManifest,
  type CrmManifestWrite,
  type CrmOperationCall,
  type CrmWriteRule,
  parseCrmManifest,
} from "./manifest.js"
import { at } from "./map.js"
import { type CrmManifestSource, fill, inputOf, type Slots } from "./source.js"

export interface CrmManifestWriterOptions {
  api: ServiceApiManifest
  /** The service's name in messages: "Attio". */
  service: string
  /** Sends one operation with no guard of its own (`serviceApiSend`): `crm/writes.ts` guards every writer call. */
  send: ServiceApiCall
  /** The source over the same manifest: the read-back after each write, and the pipelines a close looks in. */
  source: () => CrmManifestSource
}

type Rule = CrmWriteRule | "implied" | CrmFixedValue

const CALL_OF: Record<CrmVerb, "create" | "update" | "remove"> = {
  create: "create",
  update: "update",
  move: "update",
  close: "update",
  remove: "remove",
}

const CLEAR = Symbol("clear")

const isDealKind = (kind: CrmKind): kind is DealKind => (DEAL_KINDS as readonly string[]).includes(kind)

const ruleOf = (one: CrmManifestWrite, field: string): Rule | undefined =>
  (one.fields as Readonly<Record<string, Rule | undefined>>)[field]

const takes = (kind: CrmKind, one: CrmManifestWrite, verb: CrmVerb) =>
  verb === "move" || verb === "close"
    ? isDealKind(kind) && one.update !== undefined && typeof ruleOf(one, "stage") === "object"
    : one[CALL_OF[verb]] !== undefined

const capabilitiesOf = (manifest: CrmManifest): CrmWriteCapabilities | undefined => {
  const written = manifest.kinds.flatMap((kind) => {
    const one = manifest.writes?.[kind] as CrmManifestWrite | undefined
    return one ? [{ kind, one }] : []
  })
  if (written.length === 0) return undefined
  return {
    kinds: written.map(({ kind }) => kind),
    verbs: CRM_VERBS.filter((verb) => written.some(({ kind, one }) => takes(kind, one, verb))),
    // No slot sends the operation id, so a repeated write would be made again.
    idempotent: false,
  }
}

/** What the manifest's writes take, for `addCrmCommands({ writes })`; none when it describes no writes. */
export const crmManifestWriteCapabilities = (input: unknown, api: ServiceApiManifest) =>
  capabilitiesOf(parseCrmManifest(input, api))

/**
 * The `api` keys each CRM write also checks, those of the operation it sends, so `api.<operation>: deny` stops the
 * write too: for `CrmWrites.alsoChecks` and `crmAlsoChecks`, so `--dry-run` names them.
 */
export const crmManifestWriteKeys = (
  input: unknown,
  api: ServiceApiManifest,
  bodyPermissions?: ServiceApiPermissionsInput["bodyPermissions"],
): ((kind: CrmKind, verb: CrmVerb) => PermissionKey[]) => {
  const manifest = parseCrmManifest(input, api)
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  return (kind, verb) => {
    const call = (manifest.writes?.[kind] as CrmManifestWrite | undefined)?.[CALL_OF[verb]]
    const operation = call && operations.get(call.operation)
    return operation ? serviceApiOwnKeys(operation, bodyPermissions) : []
  }
}

const refused = (message: string, param?: string) =>
  new CliError("validation_error", message, { reason: "crm.record-field", sent: false, ...(param ? { param } : {}) })

/** Our fields that write one key of the service together, by that key: Attio's name and its parts. */
const sharedOf = (one: CrmManifestWrite): string[][] => {
  const by = new Map<string, string[]>()
  for (const [field, rule] of Object.entries(one.fields as Readonly<Record<string, Rule>>))
    if (typeof rule === "object" && "to" in rule) by.set(rule.to, [...(by.get(rule.to) ?? []), field])
  return [...by.values()].filter((fields) => fields.length > 1)
}

/**
 * A merge of the entries rules that share a key give: each object's keys beside the others'. A part cleared beside a
 * part given is sent empty, not left out: Attio refuses a name without all three of its parts.
 */
const merged = (entries: readonly { value: unknown; blank: unknown }[], list: boolean): unknown => {
  if (entries.every(({ value }) => value === CLEAR)) return CLEAR
  const given = entries.map(({ value, blank }) => (value === CLEAR ? blank : value))
  if (given.length === 1) return given[0]
  const first = (one: unknown) => (list && Array.isArray(one) ? one[0] : one)
  const whole = Object.assign({}, ...given.map((one) => (isRaw(first(one)) ? first(one) : {})))
  return list ? [whole] : whole
}

/**
 * A `CrmWriter` from a manifest's `writes`: each of our fields goes to the service by its rule, a field with no rule is
 * refused before anything is sent, and every write is sent once and read back by the entity's `get`, as a sync maps
 * it. A close moves the item to the first stage of its pipeline with that outcome.
 */
export const crmWriterFromManifest = (input: unknown, options: CrmManifestWriterOptions): CrmWriter => {
  const manifest = parseCrmManifest(input, options.api)
  const capabilities = capabilitiesOf(manifest)
  if (!capabilities)
    throw new CliError("configuration_error", "source manifest: writes: it describes no writes", {
      reason: "manifest.invalid",
    })
  const { service, send } = options

  const specOf = (kind: CrmKind, verb: CrmVerb) => {
    const one = manifest.writes?.[kind] as CrmManifestWrite | undefined
    if (!one || !takes(kind, one, verb))
      throw new CliError("validation_error", `${service} takes no ${verb} of a ${kind} here`, {
        reason: "crm.write-unsupported",
        sent: false,
      })
    return one
  }

  const sent = (call: CrmOperationCall, slots: Slots) => send(call.operation, inputOf(call, slots))

  const held = new Map<CrmFixedValue, Promise<string | null>>()
  const fixedOf = (rule: CrmFixedValue) => {
    let found = held.get(rule)
    if (!found) {
      found = sent(rule.fixed, {}).then((answer) => text(at(answer, rule.at)))
      found.catch(() => held.delete(rule))
      held.set(rule, found)
    }
    return found
  }

  const encode = (kind: CrmKind, field: string, rule: Omit<CrmWriteRule, "to">, value: unknown): unknown => {
    if (value === null) return CLEAR
    const items = (Array.isArray(value) ? value : [value]).map((one) => {
      if (!isRaw(one)) return one
      if (one.role !== "contact")
        throw refused(`${service} keeps no role of a ${kind}'s people; give each as a contact`)
      return one.externalId
    })
    const entries = items.map((one) => {
      const decimals = /\.(\d+)$/.exec(String(one))?.[1]?.length ?? 0
      if (rule.decimals !== undefined && decimals > rule.decimals)
        throw refused(`${service} keeps a ${kind}'s ${field} to ${rule.decimals} decimal places`, field)
      const given = rule.number ? Number(one) : one
      return rule.each === undefined ? given : fill(rule.each, { value: given })
    })
    if (rule.list) return entries
    if (entries.length > 1) throw refused(`${service} keeps one ${field} of a ${kind}; give one`)
    return entries.length ? entries[0] : CLEAR
  }

  /** The whole name a service keeps beside its parts, from the parts; or the parts it keeps alone, from the name. */
  const namesOf = (one: CrmManifestWrite, given: Readonly<Record<string, unknown>>) => {
    const { name, firstName, lastName } = given
    if (name === undefined && (typeof firstName === "string" || typeof lastName === "string")) {
      const whole = fullName(firstName, lastName)
      return ruleOf(one, "name") && whole ? { ...given, name: whole } : given
    }
    if (typeof name !== "string" || firstName !== undefined || lastName !== undefined) return given
    if (!ruleOf(one, "firstName")) return given
    const [first, ...rest] = name.trim().split(/\s+/)
    const { name: _, ...parts } = given
    return {
      ...parts,
      ...(ruleOf(one, "name") ? { name } : {}),
      firstName: first ?? "",
      lastName: rest.join(" ") || null,
    }
  }

  /**
   * The fields an update leaves out of a key it writes with others, from the record as the service holds it: an update
   * replaces the whole value (Attio's name), so a part not sent would be lost. A contact's whole name is not read back
   * when a part is given, nor its parts when the name is: `namesOf` makes them from what was given.
   */
  const completed = async (
    kind: CrmKind,
    one: CrmManifestWrite,
    externalId: string,
    given: Readonly<Record<string, unknown>>,
  ) => {
    const person = kind === "person"
    const parts = person && (given.firstName !== undefined || given.lastName !== undefined)
    const whole = person && given.name !== undefined && !parts
    const missing = sharedOf(one).flatMap((fields) =>
      fields.some((field) => given[field] !== undefined)
        ? fields.filter(
            (field) =>
              given[field] === undefined &&
              !(parts && field === "name") &&
              !(whole && (field === "firstName" || field === "lastName")),
          )
        : [],
    )
    if (missing.length === 0) return given
    const record = (await options.source().record(kind, externalId)) as Readonly<Record<string, unknown>> | null
    if (!record) throw new CliError("not_found", `${service} has no ${kind} ${externalId}`, { sent: false })
    return {
      ...given,
      ...Object.fromEntries(missing.map((field) => [field, record[field === "owner" ? "assignee" : field] ?? null])),
    }
  }

  /** The object `"{values}"` stands for; a field the manifest has no rule for is refused, with nothing sent. */
  const valuesOf = async (kind: CrmKind, one: CrmManifestWrite, written: object) => {
    const fields = written as Readonly<Record<string, unknown>>
    const given = kind === "person" ? namesOf(one, fields) : fields
    const parts = new Map<string, { list: boolean; entries: { value: unknown; blank: unknown }[] }>()
    const add = (to: string, list: boolean, value: unknown, blank: unknown = value) =>
      parts.set(to, { list, entries: [...(parts.get(to)?.entries ?? []), { value, blank }] })
    for (const [field, value] of Object.entries(given)) {
      if (value === undefined || field === "custom") continue
      const rule = ruleOf(one, field)
      if (rule === undefined) throw refused(`${service} takes no ${field} of a ${kind} here`, field)
      if (rule === "implied") continue
      if ("fixed" in rule) {
        if (value === null) continue
        const currency = await fixedOf(rule)
        if (currency === null) throw refused(`${service} names no ${field} for a ${kind}`, field)
        if (String(value).toUpperCase() !== currency.toUpperCase())
          throw refused(`${service} keeps a ${kind}'s amount in ${currency}; give that ${field} or none`, field)
        continue
      }
      add(
        rule.to,
        rule.list === true,
        encode(kind, field, rule, value),
        value === null ? encode(kind, field, rule, "") : undefined,
      )
    }
    const custom = Object.entries((given.custom as Readonly<Record<string, unknown>> | undefined) ?? {})
    if (custom.length && !one.custom) throw refused(`${service} takes no --field of a ${kind} here`, "--field")
    const own = new Set(
      Object.values(one.fields as Readonly<Record<string, Rule>>).flatMap((rule) =>
        typeof rule === "object" && "to" in rule ? [foldFieldName(rule.to)] : [],
      ),
    )
    // Only a code the service defines as the account's own: Attio also takes an attribute's id, which could be a stage.
    const source = options.source()
    const defined =
      custom.length && manifest.fields?.[kind] && source.fields
        ? (await source.fields(kind)).map(({ code }) => code)
        : []
    for (const [code, value] of custom) {
      if (own.has(foldFieldName(code)))
        throw refused(`${code} is one of ${service}'s own fields; set it with its own option, not --field`, "--field")
      if (!defined.includes(code))
        throw refused(`${service} defines no field ${code} of a ${kind}; fields list names them`, "--field")
      const rule = one.custom as Omit<CrmWriteRule, "to">
      add(code, rule.list === true, encode(kind, code, rule, value))
    }
    const clear = one.clear === undefined ? null : one.clear
    return Object.fromEntries(
      [...parts].map(([to, { list, entries }]) => {
        const value = merged(entries, list)
        return [to, value === CLEAR ? clear : value]
      }),
    )
  }

  /** The write went through: a failed read-back must never read as a failed write, or the owner repeats it. */
  const readBack = async <K extends CrmKind>(kind: K, externalId: string, written: CrmWriteOptions) => {
    try {
      const found = await options.source().record(kind, externalId)
      if (!found) throw new CliError("not_found", `${service} has no ${kind} ${externalId}`)
      return found
    } catch (error) {
      throw new CliError(
        "invalid_response",
        `${service} made the change to ${kind} ${externalId}, but reading it back failed` +
          `${isCliError(error) ? ` (${error.code})` : ""}; run sync to store it — do not write it again`,
        { operation_id: written.operationId, external_id: externalId, sent: true },
      )
    }
  }

  const update = async <K extends CrmKind>(
    kind: K,
    externalId: string,
    given: object,
    written: CrmWriteOptions,
    verb: CrmVerb = "update",
  ): Promise<CrmRecords[K]> => {
    const one = specOf(kind, verb)
    const values = await valuesOf(
      kind,
      one,
      await completed(kind, one, externalId, given as Readonly<Record<string, unknown>>),
    )
    if (Object.keys(values).length === 0) throw refused("nothing to change: name a field")
    await sent(one.update as CrmOperationCall, { id: externalId, values })
    return readBack(kind, externalId, written)
  }

  /** The item's own pipeline's first stage with that outcome, as HubSpot closes a deal. */
  const closingStage = async (kind: DealKind, externalId: string, outcome: "won" | "lost") => {
    const item = await options.source().record(kind, externalId)
    if (!item) throw new CliError("not_found", `${service} has no ${kind} ${externalId}`, { sent: false })
    const pipeline = (await options.source().pipelines(kind)).find((one) => one.externalId === item.pipeline)
    const stage = pipeline?.stages.find((one) => one.outcome === outcome)
    if (!stage) throw refused(`the ${kind}'s pipeline ${item.pipeline} has no ${outcome} stage in ${service}`)
    return stage.externalId
  }

  return {
    provider: manifest.provider,
    capabilities,
    async create(kind, draft, written) {
      const one = specOf(kind, "create")
      const answer = await sent(one.create as CrmOperationCall, { values: await valuesOf(kind, one, draft) })
      const externalId = id(at(answer, one.id as string))
      if (externalId === null)
        throw new CliError("invalid_response", `${service} answered the new ${kind} without its id; run sync first`, {
          operation_id: written.operationId,
          sent: true,
        })
      return readBack(kind, externalId, written)
    },
    update: (kind, externalId, patch, written) => update(kind, externalId, patch, written),
    move: (kind, externalId, stage, written) => update(kind, externalId, { stage }, written, "move"),
    async close(kind, externalId, outcome, written) {
      const one = specOf(kind, "close")
      if (written.reason !== undefined && ruleOf(one, "reason") === undefined)
        throw refused(`${service} keeps no reason for a close of a ${kind} here`, "--reason")
      const stage = await closingStage(kind, externalId, outcome)
      const reason = written.reason === undefined ? {} : { reason: written.reason }
      return update(kind, externalId, { stage, ...reason }, written, "close")
    },
    async remove(kind, externalId) {
      await sent(specOf(kind, "remove").remove as CrmOperationCall, { id: externalId })
    },
  }
}

export interface CrmManifestWritesOptions
  extends ServiceApiCallOptions,
    Pick<ServiceApiPermissionsInput, "bodyPermissions">,
    Omit<CrmWrites, "writer" | "alsoChecks"> {
  /** The CLI's source over the same manifest (`crmSourceFromManifest`). */
  source: () => CrmManifestSource
}

/**
 * `CrmRun.writes` for a CLI whose writes its manifest describes: the writer over the CLI's fetch and token, and the
 * `api` keys of each operation it sends as `alsoChecks`. The writes' guard asks before each one and journals it.
 */
export const crmManifestWrites = (input: unknown, options: CrmManifestWritesOptions): CrmWrites => {
  const { manifest: api, service, source, app, settings, self, ownedByDefault, env, warn } = options
  return {
    writer: crmWriterFromManifest(input, { api, service, send: serviceApiSend(options), source }),
    alsoChecks: crmManifestWriteKeys(input, api, options.bodyPermissions),
    app,
    settings,
    ...(self === undefined ? {} : { self }),
    ...(ownedByDefault === undefined ? {} : { ownedByDefault }),
    ...(env === undefined ? {} : { env }),
    ...(warn === undefined ? {} : { warn }),
  }
}
