import { CliError, isCliError } from "@wirecat/cli-base"
import type { CrmField, CrmItem } from "../domain/crm.js"
import type { DealKind } from "../domain/deals.js"
import type { AppIdentity } from "../ports/app.js"
import { foldName } from "../resolve.js"
import type { Warn } from "../runs/events.js"
import { type Asker, type GuardSettings, guardFor, type SendGuard } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import { keyedGuard } from "../sends/keyed-guard.js"
import { DEFAULT_PERMISSIONS, levelFor, type PermissionKey } from "../sends/permissions.js"
import { newOperationId } from "../sends/send-id.js"
import type { Deal, Pipeline } from "../store/sqlite/deals.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import type { CrmSource } from "./source.js"
import {
  CRM_ASSIGN_OTHERS_KEY,
  CRM_WRITE_DEFAULTS,
  type CrmDraft,
  type CrmFields,
  type CrmVerb,
  type CrmWriter,
} from "./writer.js"

/** What a CLI hands the CRM writes for one profile. */
export interface CrmWrites {
  writer: CrmWriter
  app: AppIdentity
  /** The profile's levels, read on every write so a config change applies at once. */
  settings: () => GuardSettings
  /** The CRM user the sign-in acts as. An owner other than it checks `crm.assign-others`; left out, every owner does. */
  self?: string
  env?: NodeJS.ProcessEnv
  warn?: Warn
  /**
   * The CLI's own keys a write also checks, such as Bitrix24's `api.crm.deal.update`; pass the same function to
   * `crmAlsoChecks` so `--dry-run` names them.
   */
  alsoChecks?: (kind: DealKind, verb: CrmVerb) => readonly PermissionKey[]
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

const PLURAL: Record<DealKind, string> = { deal: "deals", lead: "leads" }
const COMMAND: Record<CrmVerb, string> = {
  create: "create",
  update: "update",
  move: "move",
  close: "close",
  remove: "delete",
}
const keyOf = (kind: DealKind, verb: CrmVerb): PermissionKey => `${PLURAL[kind]}.${COMMAND[verb]}`

/** Bitrix24 REST 3.0's `Idempotency-Key` takes 1 to 255 printable ASCII characters; so does every id here. */
const OPERATION_ID = /^[\x21-\x7e]{1,255}$/u
const DECIMAL = /^\d{1,16}(\.\d{1,6})?$/u
const CURRENCY = /^[A-Z]{3}$/u
const DAY = /^\d{4}-\d{2}-\d{2}$/u
const FIELD_CODE = /^[A-Za-z][\w.-]{0,99}$/u

const invalid = (message: string, param?: string) =>
  new CliError("validation_error", message, { reason: "deal.field", ...(param ? { param } : {}) })

const supported = (writer: CrmWriter, kind: DealKind, verb: CrmVerb) => {
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

const pipelineOf = async (context: CrmWriteContext, kind: DealKind, reference: string | undefined) => {
  if (reference !== undefined) {
    const found = await context.store.deals.pipeline(reference, { kind, account: context.account })
    if (found.externalId === null) throw new CliError("not_found", `${reference} is not a pipeline of this CRM account`)
    return found
  }
  const all = await context.store.deals.pipelines({ kind, account: context.account })
  if (all.length === 1) return all[0] as Pipeline
  throw new CliError(
    "validation_error",
    all.length === 0
      ? `no ${kind} pipeline of this CRM is stored; run sync first`
      : `this CRM has ${all.length} ${kind} pipelines; name one with --pipeline: ${all.map(({ name }) => name).join(", ")}`,
    { reason: "crm.pipeline-required", param: "--pipeline" },
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
export const unknownField = (fields: readonly NamedField[], name: string): CliError => {
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
    { reason: "field.unknown", param: "--field", candidates: close.map(named) },
  )
}

/** A field by its code or its whole label; two with that label are refused with both, never guessed. */
export const fieldNamed = <F extends NamedField>(fields: readonly F[], name: string): F => {
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
        param: "--field",
        candidates: labelled.map(named),
      },
    )
  throw unknownField(fields, name)
}

/** A list field's option id, by its id or its whole label; a field with no options takes the value as typed. */
export const optionOf = (field: NamedField, value: string): string => {
  if (!field.options) return value
  const want = foldFieldName(value)
  const found =
    field.options.find((option) => option.id === value.trim()) ??
    field.options.find((option) => foldFieldName(option.label) === want)
  if (!found)
    throw new CliError("validation_error", `${field.label ?? field.code} has no option ${value}`, {
      reason: "field.unknown-option",
      param: "--field",
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
 * `--field` pairs by the synced field definitions: a label to its code, an option to its id, a multiple field's
 * repeats into a list. A CRM whose definitions are not stored takes codes as typed.
 */
const customOf = async (
  context: CrmWriteContext,
  kind: DealKind,
  pairs: CrmFieldsInput["custom"],
): Promise<CrmFields["custom"]> => {
  if (!pairs?.length) return undefined
  const fields = await context.store.crm.fields(context.account, kind)
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

/** Every key the write checks: its own, and each action its fields also take (WC-PERM-22). */
const keysOf = (
  context: CrmWriteContext,
  kind: DealKind,
  verb: CrmVerb,
  { stage, owner }: { stage?: { outcome: string } | undefined; owner?: string | null | undefined },
): { key: PermissionKey; extra: PermissionKey[] } => {
  const extra: PermissionKey[] = []
  if (stage && verb !== "move") extra.push(keyOf(kind, "move"))
  if (stage && stage.outcome !== "open") extra.push(keyOf(kind, "close"))
  if (owner != null && owner !== context.writes.self) extra.push(CRM_ASSIGN_OTHERS_KEY)
  return { key: keyOf(kind, verb), extra: [...extra, ...(context.writes.alsoChecks?.(kind, verb) ?? [])] }
}

/** The profile's guard over the write's own key and the keys its fields imply (`keyedGuard`). */
const guardOf = (context: CrmWriteContext, extra: readonly PermissionKey[]): SendGuard => {
  const settings = context.writes.settings()
  const defaults = { ...DEFAULT_PERMISSIONS, ...CRM_WRITE_DEFAULTS, ...settings.permissionDefaults }
  return keyedGuard(
    (ask) =>
      guardFor(
        context.writes.app,
        { ...settings, permissionDefaults: defaults },
        context.writes.warn ?? (() => {}),
        context.writes.env,
        ask,
      ),
    context.ask,
    (key) => levelFor(settings.permissions, key, defaults).level,
    extra,
  )
}

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
  const operationId = operationOf(context, options.operationId)
  const item = await written(
    context,
    keysOf(context, kind, "create", { stage, owner: fields.owner }),
    operationId,
    () => writer.create(kind, fields as CrmDraft, { operationId }),
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
    keysOf(context, kind, "update", { stage, owner: fields.owner }),
    operationId,
    () => writer.update(kind, copy.externalId as string, fields, { operationId }),
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
  const item = await written(context, keysOf(context, kind, "move", { stage }), operationId, () =>
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
  const item = await written(context, keysOf(context, kind, "close", {}), operationId, () =>
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
  await written(context, keysOf(context, kind, "remove", {}), operationId, () =>
    writer.remove(kind, copy.externalId as string, { operationId }),
  )
  const removed = await context.store.crm.remove(context.account, kind, [copy.externalId as string])
  return { operationId, ref: copy.ref, removed }
}
