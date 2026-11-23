import { CliError, isCliError } from "@wirecat/cli-base"
import type { CrmField, CrmItem, CrmKind, CrmOrganization, CrmPerson } from "../domain/crm.js"
import type { DealKind } from "../domain/deals.js"
import { currencyOf, minorUnits } from "../domain/money.js"
import { e164Of } from "../domain/phones.js"
import { foldName } from "../resolve.js"
import type { Asker, SendGuard } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import type { PermissionKey } from "../sends/permissions.js"
import { type ProfileWrites, profileWriteGuard } from "../sends/profile-writes.js"
import { newOperationId } from "../sends/send-id.js"
import type { Deal, Pipeline, PipelineOptions, PipelineReport } from "../store/sqlite/deals.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { foreignContacts } from "./foreign-contacts.js"
import type { CrmSource } from "./source.js"
import {
  CRM_ASSIGN_OTHERS_KEY,
  CRM_WRITE_DEFAULTS,
  type CrmDraft,
  type CrmDrafts,
  type CrmFields,
  type CrmPersonFields,
  type CrmVerb,
  type CrmWriteFields,
  type CrmWriter,
} from "./writer.js"

/** What a CLI hands the CRM writes for one profile. */
export interface CrmWrites extends ProfileWrites {
  writer: CrmWriter
  /**
   * The CRM user the sign-in acts as, or how to ask the CRM for it when a write needs it. An owner other than it
   * checks `crm.assign-others`; left out, or answered empty, every owner does.
   */
  self?: string | (() => Promise<string | undefined>)
  /** The kinds a new item of which is the sign-in's user's when no --owner is given: Attio refuses a deal with none. */
  ownedByDefault?: readonly CrmKind[]
  /**
   * The CLI's own keys a write also checks, such as Bitrix24's `api.crm.deal.update`; pass the same function to
   * `crmAlsoChecks` so `--dry-run` names them.
   */
  alsoChecks?: (kind: CrmKind, verb: CrmVerb) => readonly PermissionKey[]
}

export interface CrmWriteContext {
  store: MessageStore
  account: AccountKey
  writes: CrmWrites
  /** A terminal's question, or an agent's go-ahead. */
  ask: Asker
  /** Reads the kind's pipelines again when the CRM answers an item in a stage the store does not hold yet. */
  source?: () => CrmSource
  /** How the caller spells the operation id in a hint: `--operation-id`, or `operation_id` over MCP. */
  names?: { id: string }
}

const moneyChecked = (check: () => unknown, param: string) => {
  try {
    check()
  } catch (error) {
    if (isCliError(error)) throw new CliError(error.code, error.message, { ...error.details, param })
    throw error
  }
}

/** The fields as typed: a pipeline and a stage by reference or name, money as a decimal. */
export interface CrmFieldsInput {
  title?: string
  pipeline?: string
  stage?: string
  amount?: string
  currency?: string
  closeDate?: string
  owner?: string
  /**
   * `--field` pairs as typed, in order: a field by its code or whole label, a list field's option by its id or label,
   * repeated for each value of a multiple field; an empty value clears it.
   */
  custom?: readonly (readonly [name: string, value: string])[]
}

const PLURAL: Record<CrmKind, string> = {
  deal: "deals",
  lead: "leads",
  person: "people",
  organization: "organizations",
}
const COMMAND: Record<CrmVerb, string> = {
  create: "create",
  update: "update",
  move: "move",
  close: "close",
  remove: "delete",
}
const keyOf = (kind: CrmKind, verb: CrmVerb): PermissionKey => `${PLURAL[kind]}.${COMMAND[verb]}`

/** Bitrix24 REST 3.0's `Idempotency-Key` takes 1 to 255 printable ASCII characters; so does every id here. */
const OPERATION_ID = /^[\x21-\x7e]{1,255}$/u
const DECIMAL = /^\d{1,16}(\.\d{1,6})?$/u
const CURRENCY = /^[A-Z]{3}$/u
const DAY = /^\d{4}-\d{2}-\d{2}$/u
const FIELD_CODE = /^[A-Za-z][\w.-]{0,99}$/u

const invalid = (message: string, param?: string) =>
  new CliError("validation_error", message, { reason: "deal.field", ...(param ? { param } : {}) })

const supported = (writer: CrmWriter, kind: CrmKind, verb: CrmVerb) => {
  const { kinds, verbs } = writer.capabilities
  if (!kinds.includes(kind) || !verbs.includes(verb))
    throw new CliError("validation_error", `this CRM does not take a ${COMMAND[verb]} of ${PLURAL[kind]}`, {
      reason: "crm.write-unsupported",
      sent: false,
    })
}

const operationOf = (context: CrmWriteContext, given: string | undefined): string => {
  if (given === undefined) return newOperationId()
  const name = context.names?.id ?? "--operation-id"
  if (!context.writes.writer.capabilities.idempotent)
    throw new CliError(
      "validation_error",
      `this CRM does not recognise a repeated write, so ${name} would do it a second time; sync and look before ` +
        "writing again",
      { reason: "crm.write-unsupported", param: name, sent: false },
    )
  if (!OPERATION_ID.test(given))
    throw new CliError("validation_error", `${name} takes 1 to 255 printable characters with no spaces`, {
      param: name,
    })
  return given
}

/** A copy of this profile's account: another account's, or the owner's own, is not written here. */
const copyOf = async (context: CrmWriteContext, kind: DealKind, reference: string): Promise<Deal> => {
  if (!reference.startsWith(`${kind}:`))
    throw new CliError("validation_error", `name the ${kind} as ${kind}:<id>, as a list shows it`, {
      reason: "ref.malformed",
    })
  const found = await context.store.deals.get(reference)
  const { provider, account } = context.account
  if (found.account?.provider !== provider || found.account.account !== account || found.externalId === null)
    throw new CliError("not_found", `${reference} is not a copy from this profile's CRM account`)
  return found
}

/** The named pipeline of this profile's CRM account, or its only one; several and none named is refused. */
export const pipelineOf = async (
  context: Pick<CrmWriteContext, "store" | "account">,
  kind: DealKind | undefined,
  reference: string | undefined,
  param = "--pipeline",
  window: Pick<PipelineOptions, "since" | "until" | "zone" | "viewer"> = {},
): Promise<PipelineReport> => {
  const scope = { ...window, ...(kind ? { kind } : {}), account: context.account }
  if (reference !== undefined) {
    const found = await context.store.deals.pipeline(reference, scope)
    if (found.externalId === null) throw new CliError("not_found", `${reference} is not a pipeline of this CRM account`)
    return found
  }
  const all = await context.store.deals.pipelines(scope)
  if (all.length === 1) return context.store.deals.pipeline((all[0] as Pipeline).ref, scope)
  const what = kind ? `${kind} pipeline` : "pipeline"
  throw new CliError(
    "validation_error",
    all.length === 0
      ? `no ${what} of this CRM is stored; run sync first`
      : `this CRM has ${all.length} ${what}s; name one${param.startsWith("--") ? ` with ${param}` : ""}: ` +
          all.map(({ name, ref }) => `${name} (${ref})`).join(", "),
    { reason: "crm.pipeline-required", param, allowed: all.map(({ ref }) => ref) },
  )
}

/** A stage of `pipeline`, by the CRM's id or by a name only one of its stages has, in any letter case. */
const stageOf = (pipeline: Pipeline, given: string) => {
  const byId = pipeline.stages.find((stage) => stage.externalId === given)
  if (byId) return byId
  const folded = given.trim().toLocaleLowerCase()
  const named = pipeline.stages.filter((stage) => stage.name.toLocaleLowerCase() === folded)
  if (named.length === 1) return named[0] as Pipeline["stages"][number]
  throw new CliError(
    "validation_error",
    `${pipeline.name} has ${named.length ? "more than one" : "no"} stage ${given}: ` +
      pipeline.stages.map(({ name }) => name).join(", "),
    { reason: "deal.stage", param: "--stage" },
  )
}

const validDay = (text: string) => {
  const date = new Date(`${text}T00:00:00Z`)
  return DAY.test(text) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text)
}

/** Typed fields into the port's, resolving the stage in `pipeline`; `currency` is the copy's when a patch keeps it. */
const fieldsOf = (input: CrmFieldsInput, pipeline: Pipeline | undefined, currency: string | null) => {
  const fields: CrmFields = {}
  if (input.title !== undefined) {
    if (!input.title.trim()) throw invalid("a title is never empty", "--title")
    fields.title = input.title.trim()
  }
  if (pipeline && input.pipeline !== undefined) fields.pipeline = pipeline.externalId as string
  const stage = pipeline && input.stage !== undefined ? stageOf(pipeline, input.stage) : undefined
  if (stage) fields.stage = stage.externalId as string
  if (input.amount !== undefined || input.currency !== undefined) {
    const code = (input.currency ?? currency ?? "").toUpperCase()
    if (input.amount === undefined) throw invalid("--currency goes with --amount", "--amount")
    if (!DECIMAL.test(input.amount)) throw invalid("--amount is a decimal such as 1500.50", "--amount")
    if (!CURRENCY.test(code)) throw invalid("--amount needs --currency, an ISO 4217 code such as EUR", "--currency")
    // The CRM's answer is stored in minor units: money the store refuses would be written and then not kept.
    moneyChecked(() => currencyOf(code), "--currency")
    moneyChecked(() => minorUnits(input.amount, code, "--amount"), "--amount")
    fields.amount = input.amount
    fields.currency = code
  }
  if (input.closeDate !== undefined) {
    if (!validDay(input.closeDate)) throw invalid("--close-date is a day, YYYY-MM-DD", "--close-date")
    fields.closeDate = input.closeDate
  }
  if (input.owner !== undefined) {
    if (!input.owner.trim()) throw invalid("--owner is the CRM user's id", "--owner")
    fields.owner = input.owner.trim()
  }
  return { fields, stage }
}

/** What the field lookup reads of a field definition: a CRM CLI's own type fits. */
export type NamedField = Pick<CrmField, "code" | "label" | "options">

/**
 * A field's code, label or option as the lookup compares them: `foldName` (letter case, composed letters, ё as е),
 * with spaces and underscores aside, so `lead_source` and `Lead source` are one name.
 */
export const foldFieldName = (name: string): string => foldName(name.trim()).replace(/[\s_]+/gu, " ")

const named = ({ code, label }: NamedField) => ({ code, label })

/** No field by that name: the fields whose code or label holds it, or is held in it, are its candidates. */
export const unknownField = (fields: readonly NamedField[], name: string, param = "--field"): CliError => {
  const want = foldFieldName(name)
  const close = fields.filter((field) =>
    [field.code, field.label ?? ""].some((one) => {
      const other = foldFieldName(one)
      return other !== "" && (other.includes(want) || want.includes(other))
    }),
  )
  return new CliError(
    "validation_error",
    `no custom field is named ${name}${close.length ? "; close ones are in candidates" : ""} — \`fields list\` lists them`,
    { reason: "field.unknown", param, candidates: close.map(named) },
  )
}

/** A field by its code or its whole label; two with that label are refused with both, never guessed. */
export const fieldNamed = <F extends NamedField>(fields: readonly F[], name: string, param = "--field"): F => {
  const want = foldFieldName(name)
  const byCode = fields.find((field) => foldFieldName(field.code) === want)
  if (byCode) return byCode
  const labelled = fields.filter((field) => field.label !== null && foldFieldName(field.label) === want)
  if (labelled.length === 1) return labelled[0] as F
  if (labelled.length > 1)
    throw new CliError(
      "validation_error",
      `${labelled.length} custom fields are labelled ${name}; name one by its code`,
      {
        reason: "field.ambiguous",
        param,
        candidates: labelled.map(named),
      },
    )
  throw unknownField(fields, name, param)
}

/** A list field's option id, by its id or its whole label; a field with no options takes the value as typed. */
export const optionOf = (field: NamedField, value: string, param = "--field"): string => {
  if (!field.options) return value
  const want = foldFieldName(value)
  const byId = field.options.find((option) => option.id === value.trim())
  const named = byId ? [] : field.options.filter((option) => foldFieldName(option.label) === want)
  if (named.length > 1)
    throw new CliError(
      "validation_error",
      `${field.label ?? field.code} has ${named.length} options named ${value}; name one by its id`,
      {
        reason: "field.ambiguous-option",
        param,
        field: field.code,
        candidates: named,
      },
    )
  const found = byId ?? named[0]
  if (!found)
    throw new CliError("validation_error", `${field.label ?? field.code} has no option ${value}`, {
      reason: "field.unknown-option",
      param,
      field: field.code,
      allowed: field.options,
    })
  return found.id
}

/** `--field` pairs as typed, split at the first `=`; a pair with no key before it is refused. */
export const fieldPairsOf = (typed: readonly string[]): [string, string][] =>
  typed.map((one) => {
    const at = one.indexOf("=")
    if (at <= 0 || one.slice(0, at).trim() === "")
      throw new CliError("validation_error", `--field takes <key>=<value>; got ${one}`, { param: "--field" })
    return [one.slice(0, at), one.slice(at + 1)]
  })

/**
 * `--field` pairs by the CRM's field definitions: a label to its code, an option to its id, a multiple field's repeats
 * into a list, an empty value to `null`. With no definitions, codes are taken as typed.
 */
export const crmCustomValues = (
  fields: readonly CrmField[],
  pairs: readonly (readonly [name: string, value: string])[],
): Record<string, string | string[] | null> => {
  const values = new Map<string, { field: CrmField | null; all: (string | null)[] }>()
  for (const [name, value] of pairs) {
    const field = fields.length ? fieldNamed(fields, name) : null
    const code = field?.code ?? name.trim()
    if (!field && !FIELD_CODE.test(code)) throw invalid(`${name} is not a field code`, "--field")
    const held = values.get(code) ?? { field, all: [] }
    held.all.push(value === "" ? null : field ? optionOf(field, value) : value)
    values.set(code, held)
  }
  return Object.fromEntries(
    [...values].map(([code, { field, all }]) => {
      const given = all.filter((one): one is string => one !== null)
      if (field?.multiple) return [code, given.length ? given : null]
      if (all.length > 1)
        throw new CliError("validation_error", `${field?.label ?? code} holds one value; give --field once`, {
          reason: "deal.field",
          param: "--field",
          field: code,
        })
      return [code, all[0] ?? null]
    }),
  )
}

/** `--field` pairs by the field definitions the last sync stored. */
const customOf = async (
  context: CrmWriteContext,
  kind: CrmKind,
  pairs: CrmFieldsInput["custom"],
): Promise<CrmFields["custom"]> =>
  pairs?.length ? crmCustomValues(await context.store.crm.fields(context.account, kind), pairs) : undefined

/** Every key the write checks: its own, and each action its fields also take (WC-PERM-22). */
const selfOf = async ({ writes: { self } }: CrmWriteContext): Promise<string | undefined> =>
  (typeof self === "function" ? await self() : self) || undefined

const keysOf = async (
  context: CrmWriteContext,
  kind: CrmKind,
  verb: CrmVerb,
  { stage, owner }: { stage?: { outcome: string } | undefined; owner?: string | null | undefined },
): Promise<{ key: PermissionKey; extra: PermissionKey[] }> => {
  const extra: PermissionKey[] = []
  if (stage && verb !== "move") extra.push(keyOf(kind, "move"))
  if (stage && stage.outcome !== "open") extra.push(keyOf(kind, "close"))
  if (owner != null && owner !== (await selfOf(context))) extra.push(CRM_ASSIGN_OTHERS_KEY)
  return { key: keyOf(kind, verb), extra: [...extra, ...(context.writes.alsoChecks?.(kind, verb) ?? [])] }
}

const guardOf = (context: CrmWriteContext, extra: readonly PermissionKey[]): SendGuard =>
  profileWriteGuard(context.writes, context.ask, CRM_WRITE_DEFAULTS, extra)

/** Sends the write once, never again: a lost answer is `outcome_unknown`, with what the owner may do about it. */
const written = async <T>(
  context: CrmWriteContext,
  { key, extra }: { key: PermissionKey; extra: PermissionKey[] },
  operationId: string,
  act: () => Promise<T>,
): Promise<T> => {
  try {
    // A write the CRM made and could not read back is sent: its journal line says so, and the read's failure follows.
    const done = await guardedWrite(
      guardOf(context, extra),
      { chatId: null, kind: "edit", key, operationId },
      async () => {
        try {
          return { item: await act(), unread: null }
        } catch (error) {
          if (isCliError(error) && error.details.sent === true) return { item: null, unread: error }
          throw error
        }
      },
    )
    if (done.unread)
      throw new CliError(
        done.unread.code,
        `${done.unread.message} — the CRM made the change; sync to store it, do not write it again`,
        { ...done.unread.details, operation_id: operationId },
      )
    return done.item as T
  } catch (error) {
    if (!isCliError(error) || error.code !== "outcome_unknown") throw error
    const name = context.names?.id ?? "--operation-id"
    throw new CliError(
      "outcome_unknown",
      context.writes.writer.capabilities.idempotent
        ? `${error.message} — repeat it with ${name} ${operationId}: the CRM answers a repeat from its record ` +
            "instead of doing it again"
        : `${error.message} — sync and look at the CRM before writing again: this CRM would do it a second time`,
      { ...error.details, operation_id: operationId },
    )
  }
}

/**
 * The CRM's answer into the store, as a sync would save it. A failure here names the item: the CRM has made the
 * change, and a repeat would make it again.
 */
const kept = async (context: CrmWriteContext, kind: DealKind, item: CrmItem, operationId: string): Promise<Deal> => {
  const fail = (why: string, details: Record<string, unknown> = {}) =>
    new CliError(
      "invalid_response",
      `the CRM wrote ${kind} ${item.externalId}, but the local store did not keep it (${why}); sync to store it — ` +
        "do not write it again",
      { ...details, operation_id: operationId, external_id: item.externalId, sent: true },
    )
  try {
    let saved = await context.store.crm.saveItems(context.account, kind, [item])
    if (saved.skipped[0]?.reason === "crm.stage-unknown" && context.source) {
      await context.store.crm.savePipelines(context.account, kind, await context.source().pipelines(kind))
      saved = await context.store.crm.saveItems(context.account, kind, [item])
    }
    const [skipped] = saved.skipped
    if (skipped) throw fail(skipped.message, { reason: skipped.reason })
    const reference = await context.store.crm.refOf(context.account, kind, item.externalId)
    if (reference === null) throw fail("it is not found after the save")
    return await context.store.deals.get(reference)
  } catch (error) {
    if (isCliError(error) && error.code === "invalid_response" && error.details.sent === true) throw error
    throw fail(error instanceof Error ? error.message : String(error), isCliError(error) ? error.details : {})
  }
}

export interface CrmWritten {
  operationId: string
  item: Deal
}

export const createCrmItem = async (
  context: CrmWriteContext,
  kind: DealKind,
  input: CrmFieldsInput,
  options: { operationId?: string } = {},
): Promise<CrmWritten> => {
  const { writer } = context.writes
  supported(writer, kind, "create")
  if (input.title === undefined) throw invalid(`a new ${kind} needs --title`, "--title")
  const pipeline = await pipelineOf(context, kind, input.pipeline)
  const { fields, stage } = fieldsOf({ ...input, pipeline: pipeline.ref }, pipeline, null)
  const custom = await customOf(context, kind, input.custom)
  if (custom) fields.custom = custom
  if (fields.owner === undefined && context.writes.ownedByDefault?.includes(kind)) {
    const self = await selfOf(context)
    if (self === undefined) throw invalid(`a new ${kind} needs --owner: the sign-in names no CRM user`, "--owner")
    fields.owner = self
  }
  const operationId = operationOf(context, options.operationId)
  const item = await written(
    context,
    await keysOf(context, kind, "create", { stage, owner: fields.owner }),
    operationId,
    () => writer.create(kind, fields as CrmDraft, { operationId }) as Promise<CrmItem>,
  )
  return { operationId, item: await kept(context, kind, item, operationId) }
}

export const updateCrmItem = async (
  context: CrmWriteContext,
  kind: DealKind,
  reference: string,
  input: CrmFieldsInput,
  options: { operationId?: string } = {},
): Promise<CrmWritten> => {
  const { writer } = context.writes
  supported(writer, kind, "update")
  const copy = await copyOf(context, kind, reference)
  if (input.pipeline !== undefined && input.stage === undefined)
    throw invalid("a new --pipeline needs the --stage it goes to there", "--stage")
  const pipeline =
    input.stage === undefined
      ? undefined
      : await pipelineOf(context, kind, input.pipeline === undefined ? copy.pipeline : input.pipeline)
  const { fields, stage } = fieldsOf(input, pipeline, copy.currency)
  const custom = await customOf(context, kind, input.custom)
  if (custom) fields.custom = custom
  if (Object.keys(fields).length === 0) throw invalid("nothing to change: name a field")
  const operationId = operationOf(context, options.operationId)
  const item = await written(
    context,
    await keysOf(context, kind, "update", { stage, owner: fields.owner }),
    operationId,
    () => writer.update(kind, copy.externalId as string, fields, { operationId }) as Promise<CrmItem>,
  )
  return { operationId, item: await kept(context, kind, item, operationId) }
}

export const moveCrmItem = async (
  context: CrmWriteContext,
  kind: DealKind,
  reference: string,
  stageName: string,
  options: { operationId?: string } = {},
): Promise<CrmWritten> => {
  const { writer } = context.writes
  supported(writer, kind, "move")
  const copy = await copyOf(context, kind, reference)
  const stage = stageOf(await pipelineOf(context, kind, copy.pipeline), stageName)
  const operationId = operationOf(context, options.operationId)
  const item = await written(context, await keysOf(context, kind, "move", { stage }), operationId, () =>
    writer.move(kind, copy.externalId as string, stage.externalId as string, { operationId }),
  )
  return { operationId, item: await kept(context, kind, item, operationId) }
}

export const closeCrmItem = async (
  context: CrmWriteContext,
  kind: DealKind,
  reference: string,
  outcome: "won" | "lost",
  options: { reason?: string; operationId?: string } = {},
): Promise<CrmWritten> => {
  const { writer } = context.writes
  supported(writer, kind, "close")
  if (outcome !== "won" && outcome !== "lost") throw invalid("a close is won or lost")
  const copy = await copyOf(context, kind, reference)
  const reason = options.reason?.trim()
  if (reason !== undefined && (reason === "" || reason.length > 2000))
    throw invalid("--reason is 1 to 2000 characters", "--reason")
  const operationId = operationOf(context, options.operationId)
  const item = await written(context, await keysOf(context, kind, "close", {}), operationId, () =>
    writer.close(kind, copy.externalId as string, outcome, { operationId, ...(reason ? { reason } : {}) }),
  )
  return { operationId, item: await kept(context, kind, item, operationId) }
}

export const removeCrmItem = async (
  context: CrmWriteContext,
  kind: DealKind,
  reference: string,
  options: { operationId?: string } = {},
): Promise<{ operationId: string; ref: string; removed: number }> => {
  const { writer } = context.writes
  supported(writer, kind, "remove")
  const copy = await copyOf(context, kind, reference)
  const operationId = operationOf(context, options.operationId)
  await written(context, await keysOf(context, kind, "remove", {}), operationId, () =>
    writer.remove(kind, copy.externalId as string, { operationId }),
  )
  const removed = await context.store.crm.remove(context.account, kind, [copy.externalId as string])
  return { operationId, ref: copy.ref, removed }
}

/** The kinds a contact-or-company write takes. */
export type CrmRecordKind = "person" | "organization"

/** A contact's or company's fields as typed; an empty text clears a part of a name or the position. */
export interface CrmRecordInput {
  name?: string
  firstName?: string
  lastName?: string
  position?: string
  /** Each list replaces the CRM's whole list; one empty value clears it. */
  emails?: readonly string[]
  phones?: readonly string[]
  owner?: string
  custom?: CrmFieldsInput["custom"]
}

export interface CrmRecordWritten<K extends CrmRecordKind> {
  operationId: string
  /** The CRM's answer; one that is not the sign-in's client comes without its phones and e-mails (NEED-2487). */
  record: K extends "person" ? CrmPerson : CrmOrganization
  /** Whether the copy keeps it: only the sign-in's own clients are stored (NEED-2661). */
  stored: boolean
  /**
   * After an update that gave it to someone else, whether the copy let it go: `false` when it stays, because the
   * owner decided about the contact, something else points at it, or one of the owner's deals names it.
   */
  removed?: boolean
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/u
/** A CRM id as a list prints it; shared with the commands, not exported from the package. */
export const RECORD_ID = /^[\w.:-]{1,100}$/u
const PERSON_ONLY = ["firstName", "lastName", "position"] as const

const recordInvalid = (message: string, param?: string) =>
  new CliError("validation_error", message, { reason: "crm.record-field", ...(param ? { param } : {}) })

const cleared = (value: string | undefined) => (value === undefined ? undefined : value.trim() || null)

const listed = (values: readonly string[] | undefined, param: string, valid?: RegExp) => {
  if (values === undefined) return undefined
  const all = values.map((one) => one.trim())
  if (all.length === 1 && all[0] === "") return []
  for (const one of all)
    if (one === "" || one.length > 320 || (valid && !valid.test(one))) throw recordInvalid(`${param} got ${one}`, param)
  return all
}

/** Typed fields into the port's; a company takes no name parts and no position. */
const recordFieldsOf = (kind: CrmRecordKind, input: CrmRecordInput): CrmPersonFields => {
  if (kind === "organization") {
    const given = PERSON_ONLY.find((one) => input[one] !== undefined)
    if (given) throw recordInvalid(`a company has no ${given}`)
  }
  const fields: CrmPersonFields = {}
  if (input.name !== undefined) {
    if (!input.name.trim()) throw recordInvalid("--name is never empty", "--name")
    fields.name = input.name.trim()
  }
  const parts = { firstName: cleared(input.firstName), lastName: cleared(input.lastName) }
  const position = cleared(input.position)
  if (parts.firstName !== undefined) fields.firstName = parts.firstName
  if (parts.lastName !== undefined) fields.lastName = parts.lastName
  if (position !== undefined) fields.position = position
  const emails = listed(input.emails, "--email", EMAIL)
  const phones = listed(input.phones, "--phone")?.map((phone) => {
    const international = e164Of(phone, undefined)
    if (typeof international !== "string")
      throw recordInvalid(`--phone takes a number in international form, starting with +: not ${phone}`, "--phone")
    return international
  })
  if (emails) fields.emails = emails
  if (phones) fields.phones = phones
  if (input.owner !== undefined) {
    if (!input.owner.trim()) throw recordInvalid("--owner is the CRM user's id", "--owner")
    fields.owner = input.owner.trim()
  }
  return fields
}

/** The CRM's answer into the store, as a sync saves it; a failure names the record, which the CRM has written. */
const keptRecord = async (context: CrmWriteContext, kind: CrmRecordKind, record: CrmPerson | CrmOrganization) => {
  try {
    const saved =
      kind === "person"
        ? await context.store.crm.savePeople(context.account, [record as CrmPerson])
        : await context.store.crm.saveOrganizations(context.account, [record as CrmOrganization])
    const [skipped] = saved.skipped
    if (skipped) throw new Error(skipped.message)
  } catch (error) {
    throw new CliError(
      "invalid_response",
      `the CRM wrote ${kind} ${record.externalId}, but the local store did not keep it ` +
        `(${error instanceof Error ? error.message : String(error)}); sync to store it — do not write it again`,
      { external_id: record.externalId, sent: true },
    )
  }
}

/**
 * A contact or company the update gave to someone else leaves the copy (NEED-2661), as `removeCrmItem` removes a deal:
 * a contact with its identity, which held the phones and e-mails it was saved with.
 */
const forgotten = async (context: CrmWriteContext, kind: CrmRecordKind, record: CrmPerson | CrmOrganization) =>
  (kind === "organization"
    ? await context.store.crm.remove(context.account, kind, [record.externalId])
    : (await context.store.crm.removeContact(context.account, record.externalId)).contacts) > 0

const writeRecord = async <K extends CrmRecordKind>(
  context: CrmWriteContext,
  kind: K,
  verb: "create" | "update",
  fields: CrmPersonFields,
  operationId: string,
  act: () => Promise<CrmPerson | CrmOrganization>,
): Promise<CrmRecordWritten<K>> => {
  if (!context.source)
    throw new CliError("configuration_error", "a contact or company write needs the CRM source to tell your clients")
  const rule = foreignContacts(context.source(), undefined)
  const record = await written(context, await keysOf(context, kind, verb, { owner: fields.owner }), operationId, act)
  const stored = await rule.own(kind, record)
  let removed: boolean | undefined
  try {
    if (stored) await keptRecord(context, kind, record)
    else if (verb === "update") removed = await forgotten(context, kind, record)
  } catch (error) {
    if (isCliError(error))
      throw new CliError(error.code, error.message, { ...error.details, operation_id: operationId })
    throw error
  }
  const [shown] = stored ? [record] : await rule.strip(kind, [record])
  return {
    operationId,
    record: shown as CrmRecordWritten<K>["record"],
    stored,
    ...(removed === undefined ? {} : { removed }),
  }
}

/** A new contact or company in the CRM, through the guarded path; the CRM's answer is stored as a sync stores it. */
export const createCrmRecord = async <K extends CrmRecordKind>(
  context: CrmWriteContext,
  kind: K,
  input: CrmRecordInput,
  options: { operationId?: string } = {},
): Promise<CrmRecordWritten<K>> => {
  const { writer } = context.writes
  supported(writer, kind, "create")
  const fields = recordFieldsOf(kind, input)
  if (kind === "organization" && fields.name === undefined) throw recordInvalid("a new company needs --name", "--name")
  if (kind === "person" && !fields.name && !fields.firstName && !fields.lastName)
    throw recordInvalid("a new contact needs --name, --first-name or --last-name", "--name")
  const custom = await customOf(context, kind, input.custom)
  if (custom) fields.custom = custom
  const operationId = operationOf(context, options.operationId)
  return writeRecord(context, kind, "create", fields, operationId, () =>
    writer.create(kind, fields as CrmDrafts[K], { operationId }),
  )
}

/** A change to a contact or company by the CRM's id, as `people list` prints it; what is left out keeps its value. */
export const updateCrmRecord = async <K extends CrmRecordKind>(
  context: CrmWriteContext,
  kind: K,
  externalId: string,
  input: CrmRecordInput,
  options: { operationId?: string } = {},
): Promise<CrmRecordWritten<K>> => {
  const { writer } = context.writes
  supported(writer, kind, "update")
  if (!RECORD_ID.test(externalId))
    throw new CliError("validation_error", `name the ${kind} by the CRM's id, as a list prints it`, {
      reason: "ref.malformed",
    })
  const fields = recordFieldsOf(kind, input)
  const custom = await customOf(context, kind, input.custom)
  if (custom) fields.custom = custom
  if (Object.keys(fields).length === 0) throw recordInvalid("nothing to change: name a field")
  const operationId = operationOf(context, options.operationId)
  return writeRecord(context, kind, "update", fields, operationId, () =>
    writer.update(kind, externalId, fields as CrmWriteFields[K], { operationId }),
  )
}
