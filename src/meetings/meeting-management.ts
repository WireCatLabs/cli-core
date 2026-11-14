import { CliError } from "@wirecat/cli-base"
import { type MeetingProviderScope, snapshotMeetingScope } from "./provider.js"
import { meetingTimestamp } from "./timestamp.js"

export interface ManagedMeeting {
  id: string
  title: string | null
  kind: "instant" | "scheduled" | null
  startTime: string | null
  durationMinutes: number | null
  timezone: string | null
  agenda: string | null
  joinUrl: string | null
}

export interface ManagedMeetingChange {
  title?: string
  kind?: "instant" | "scheduled"
  startTime?: string
  durationMinutes?: number
  timezone?: string
  agenda?: string
  /** The service's own settings by their declared names (`MeetingSetting`). */
  settings?: Readonly<Record<string, string | boolean>>
}

/** A field every meetings service may take; each port declares the ones its service reads. */
export type MeetingField = "title" | "kind" | "startTime" | "durationMinutes" | "timezone" | "agenda"

/** Each field's key in an answer; its option is the key with dashes, `--start-time`. */
export const MEETING_FIELD_KEYS: Readonly<Record<MeetingField, string>> = Object.freeze({
  title: "title",
  kind: "kind",
  startTime: "start_time",
  durationMinutes: "duration_minutes",
  timezone: "timezone",
  agenda: "agenda",
})

export const MEETING_FIELDS = Object.freeze(Object.keys(MEETING_FIELD_KEYS)) as readonly MeetingField[]

export const meetingFieldFlag = (field: MeetingField): string => `--${MEETING_FIELD_KEYS[field].replaceAll("_", "-")}`

/** A setting only this service has, given as `--setting <name>=<value>`; the name is snake_case. */
export type MeetingSetting =
  | { name: string; description: string; type: "choice"; values: readonly string[] }
  | { name: string; description: string; type: "boolean" }
  /** Blank text is refused unless `clearable`: then `""` clears the setting on the service. */
  | { name: string; description: string; type: "text"; clearable?: boolean }

/** What one write port reads. A port that declares nothing reads every `MEETING_FIELDS` entry and no setting. */
export interface MeetingFields {
  fields?: readonly MeetingField[]
  settings?: readonly MeetingSetting[]
}

/** A declaration with its defaults filled in, as `createMeetingManagement` exposes it. */
export interface DeclaredMeetingFields {
  readonly fields: readonly MeetingField[]
  readonly settings: readonly MeetingSetting[]
}

export interface MeetingOperationOptions {
  signal?: AbortSignal
}

export interface MeetingMutationOptions extends MeetingOperationOptions {
  apply?: boolean
  dryRun?: boolean
  occurrenceId?: string
  /** Runs after the change is validated and before it is dispatched, only when it will be: the owner's question. */
  confirm?: () => Promise<void>
}

export interface MeetingProviderContext extends MeetingOperationOptions {
  readonly scope: Readonly<MeetingProviderScope>
}

export interface MeetingManagementPorts {
  list?(context: MeetingProviderContext): Promise<ManagedMeeting[]>
  get?(id: string, context: MeetingProviderContext): Promise<ManagedMeeting>
  invitation?(id: string, context: MeetingProviderContext): Promise<{ id: string; invitation: string }>
  create?(change: Readonly<ManagedMeetingChange>, context: MeetingProviderContext): Promise<ManagedMeeting>
  update?(id: string, change: Readonly<ManagedMeetingChange>, context: MeetingProviderContext): Promise<void>
  cancel?(id: string, context: MeetingProviderContext & { occurrenceId?: string }): Promise<void>
  /** What `create` and `update` read; see `MeetingFields`. */
  fields?: { create?: MeetingFields; update?: MeetingFields }
}

type MeetingPortName = Exclude<keyof MeetingManagementPorts, "fields">

export interface MeetingMutationProposal {
  action: "create" | "update" | "cancel"
  scope: Readonly<MeetingProviderScope>
  id?: string
  change?: Readonly<ManagedMeetingChange>
  occurrenceId?: string
}

export interface MeetingMutationReceipt extends MeetingMutationProposal {
  applied: boolean
  meeting?: ManagedMeeting
}

const nonempty = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new CliError("validation_error", `${name} must be nonempty`)
  return value
}

export const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

const isField = (key: string): key is MeetingField => Object.hasOwn(MEETING_FIELD_KEYS, key)

/**
 * Checks a port's declaration once, when the management is made: a bad one is the host's mistake, not the owner's.
 * A create that declares `kind` without `startTime` could never schedule, so it is refused.
 */
export const declareMeetingFields = (
  declared: MeetingFields = {},
  action: "create" | "update" = "create",
): DeclaredMeetingFields => {
  const wrong = (why: string) => new CliError("configuration_error", `meeting fields: ${why}`)
  const fields = declared.fields ?? MEETING_FIELDS
  for (const field of fields) if (!isField(String(field))) throw wrong(`unknown field ${String(field)}`)
  if (action === "create" && fields.includes("kind") && !fields.includes("startTime"))
    throw wrong("create declares kind without startTime, so a scheduled meeting could never get its start")
  const names = new Set<string>()
  const settings = (declared.settings ?? []).map((setting) => {
    const name: unknown = setting?.name
    if (typeof name !== "string" || !SNAKE_CASE.test(name))
      throw wrong(`setting name ${String(name)} is not snake_case`)
    if (names.has(name)) throw wrong(`setting ${name} is declared twice`)
    names.add(name)
    if (typeof setting.description !== "string" || !setting.description.trim())
      throw wrong(`setting ${name} has no description`)
    if (setting.type === "choice") {
      const values = setting.values
      if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== "string" || !value))
        throw wrong(`setting ${name} lists no values`)
      return Object.freeze({ ...setting, values: Object.freeze([...new Set(values)]) })
    }
    if (setting.type !== "boolean" && setting.type !== "text") throw wrong(`setting ${name} has an unknown type`)
    return Object.freeze({ ...setting })
  })
  return Object.freeze({ fields: Object.freeze([...new Set(fields)]), settings: Object.freeze(settings) })
}

const settingNamed = (declared: DeclaredMeetingFields, name: string): MeetingSetting | undefined =>
  declared.settings.find((setting) => setting.name === name)

const supportedList = (declared: DeclaredMeetingFields): string => {
  const all = [
    ...declared.fields.map(meetingFieldFlag),
    ...declared.settings.map((setting) => `--setting ${setting.name}`),
  ]
  return all.length ? all.join(", ") : "nothing"
}

const settingValue = (setting: MeetingSetting, value: unknown): string | boolean => {
  const refuse = (expected: string) =>
    new CliError("validation_error", `meeting setting ${setting.name} must be ${expected}`)
  if (setting.type === "boolean") {
    if (typeof value === "boolean") return value
    if (value === "true" || value === "false") return value === "true"
    throw refuse("true or false")
  }
  if (typeof value !== "string") throw refuse(setting.type === "choice" ? setting.values.join(", ") : "text")
  if (setting.type === "choice" && !setting.values.includes(value)) throw refuse(`one of ${setting.values.join(", ")}`)
  if (setting.type === "text" && !value.trim()) {
    if (!setting.clearable) throw refuse("nonempty text: this service cannot clear it")
    return ""
  }
  return value
}

export interface MeetingChangeRules {
  /** What the port reads; `declareMeetingFields()` (every portable field, no setting) when absent. */
  declared?: DeclaredMeetingFields
}

/**
 * Returns a detached, canonical change with only what the port declared; a create always carries `kind`. A service
 * that cannot schedule (no `startTime` declared) only makes meetings that start now. One that can needs a start or
 * an explicit `kind: "instant"`: over MCP an agent is not asked first, so a forgotten start must be an error, not a
 * live meeting. An instant create gets its `startTime` when it is dispatched (`createMeetingManagement`).
 */
export const validateMeetingChange = (
  change: ManagedMeetingChange,
  create: boolean,
  rules: MeetingChangeRules = {},
): Readonly<ManagedMeetingChange> => {
  const declared = rules.declared ?? declareMeetingFields()
  const action = create ? "create" : "update"
  if (!change || typeof change !== "object" || Array.isArray(change))
    throw new CliError("validation_error", "a meeting change must be an object")
  const undeclared = Object.keys(change).flatMap((key) =>
    change[key as keyof ManagedMeetingChange] === undefined || key === "settings"
      ? []
      : isField(key)
        ? declared.fields.includes(key)
          ? []
          : [meetingFieldFlag(key)]
        : [key],
  )
  const given = change.settings ?? {}
  if (typeof given !== "object" || Array.isArray(given) || given === null)
    throw new CliError("validation_error", "meeting settings must be an object of name and value")
  for (const name of Object.keys(given)) if (!settingNamed(declared, name)) undeclared.push(`--setting ${name}`)
  if (undeclared.length)
    throw new CliError(
      "validation_error",
      `this service does not take ${undeclared.join(", ")} on ${action}; it takes ${supportedList(declared)}`,
    )
  const result: ManagedMeetingChange = {}
  if (change.title !== undefined) result.title = nonempty(change.title, "meeting title")
  if (change.kind !== undefined) {
    if (change.kind !== "instant" && change.kind !== "scheduled")
      throw new CliError("validation_error", "only instant or scheduled meeting kinds are supported")
    result.kind = change.kind
  }
  if (change.startTime !== undefined) {
    result.startTime = meetingTimestamp(change.startTime, "meeting start")
  }
  if (change.durationMinutes !== undefined) {
    if (!Number.isSafeInteger(change.durationMinutes) || change.durationMinutes <= 0 || change.durationMinutes > 1440)
      throw new CliError("validation_error", "meeting duration must be an integer from 1 to 1440 minutes")
    result.durationMinutes = change.durationMinutes
  }
  if (change.timezone !== undefined) {
    if (typeof change.timezone !== "string" || !change.timezone.trim())
      throw new CliError("validation_error", "meeting timezone must be a valid IANA timezone")
    try {
      new Intl.DateTimeFormat("en", { timeZone: change.timezone }).format()
    } catch {
      throw new CliError("validation_error", "meeting timezone must be a valid IANA timezone")
    }
    result.timezone = change.timezone
  }
  if (change.agenda !== undefined) {
    if (typeof change.agenda !== "string") throw new CliError("validation_error", "meeting agenda must be text")
    result.agenda = change.agenda
  }
  const settings = Object.entries(given).map(
    ([name, value]) => [name, settingValue(settingNamed(declared, name) as MeetingSetting, value)] as const,
  )
  if (settings.length) result.settings = Object.freeze(Object.fromEntries(settings))
  if (create) {
    const schedules = declared.fields.includes("startTime")
    result.kind ??= result.startTime !== undefined ? "scheduled" : schedules ? undefined : "instant"
    if (result.kind === undefined)
      throw new CliError(
        "validation_error",
        declared.fields.includes("kind")
          ? "give --start-time, or --kind instant for a meeting that starts now"
          : "give --start-time: this service has no meeting that starts now",
      )
    if (result.kind === "scheduled" && result.startTime === undefined)
      throw new CliError("validation_error", "a scheduled meeting needs --start-time")
  } else if (!Object.keys(result).length)
    throw new CliError("validation_error", "at least one meeting change is required")
  return Object.freeze(result)
}

const checkCancelled = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(
    timeout ? "timeout" : "cancelled",
    timeout ? "meeting operation timed out" : "meeting operation cancelled",
  )
}

/** Dispatches at most once. An adapter owns acknowledgement and uncertain-outcome errors. */
export const dispatchMeetingMutation = async <T>(
  options: MeetingMutationOptions,
  dispatch: (signal?: AbortSignal) => Promise<T>,
): Promise<{ applied: boolean; value?: T }> => {
  const { apply, dryRun, signal, confirm } = options
  checkCancelled(signal)
  if (apply !== true || dryRun) return { applied: false }
  if (confirm) {
    await confirm()
    checkCancelled(signal)
  }
  return { applied: true, value: await dispatch(signal) }
}

export const createMeetingManagement = (
  scope: MeetingProviderScope,
  ports: MeetingManagementPorts,
  options: { now?: () => number } = {},
) => {
  const fixed = snapshotMeetingScope(scope)
  const fields = Object.freeze({
    create: declareMeetingFields(ports.fields?.create, "create"),
    update: declareMeetingFields(ports.fields?.update, "update"),
  })
  const now = options.now ?? Date.now
  const capabilities: Omit<MeetingManagementPorts, "fields"> = {}
  for (const name of ["list", "get", "invitation", "create", "update", "cancel"] as const) {
    const port = ports[name]
    if (typeof port === "function")
      Object.defineProperty(capabilities, name, { value: port.bind(ports), enumerable: true })
  }
  Object.freeze(capabilities)
  const context = (options: MeetingOperationOptions): MeetingProviderContext => {
    const signal = options.signal
    checkCancelled(signal)
    return Object.freeze({ scope: fixed, ...(signal ? { signal } : {}) })
  }
  const capability = <K extends MeetingPortName>(name: K): NonNullable<MeetingManagementPorts[K]> => {
    const port = capabilities[name]
    if (!port) throw new CliError("provider_unavailable", `meeting provider does not support ${name}`)
    return port as NonNullable<MeetingManagementPorts[K]>
  }
  return {
    scope: fixed,
    /** What `create` and `update` take, with the defaults filled in. */
    fields,
    capabilities: Object.freeze(
      Object.keys(capabilities).filter((name) => typeof capabilities[name as MeetingPortName] === "function"),
    ),
    list(options: MeetingOperationOptions = {}) {
      return capability("list")(context(options))
    },
    get(id: string, options: MeetingOperationOptions = {}) {
      return capability("get")(nonempty(id, "meeting id"), context(options))
    },
    invitation(id: string, options: MeetingOperationOptions = {}) {
      return capability("invitation")(nonempty(id, "meeting id"), context(options))
    },
    async create(change: ManagedMeetingChange, options: MeetingMutationOptions = {}): Promise<MeetingMutationReceipt> {
      const port = capability("create")
      const validated = validateMeetingChange(change, true, { declared: fields.create })
      const ctx = context(options)
      let sent = validated
      // "Now" is when it goes, after the owner's question, not when the command started.
      const outcome = await dispatchMeetingMutation(options, () => {
        if (sent.startTime === undefined)
          sent = Object.freeze({ ...validated, startTime: new Date(now()).toISOString() })
        return port(sent, ctx)
      })
      return {
        action: "create",
        scope: fixed,
        change: sent,
        applied: outcome.applied,
        ...(outcome.value ? { meeting: outcome.value } : {}),
      }
    },
    async update(
      id: string,
      change: ManagedMeetingChange,
      options: MeetingMutationOptions = {},
    ): Promise<MeetingMutationReceipt> {
      const port = capability("update")
      const validatedId = nonempty(id, "meeting id")
      const validated = validateMeetingChange(change, false, { declared: fields.update })
      const ctx = context(options)
      const outcome = await dispatchMeetingMutation(options, () => port(validatedId, validated, ctx))
      return { action: "update", scope: fixed, id: validatedId, change: validated, applied: outcome.applied }
    },
    async cancel(id: string, options: MeetingMutationOptions = {}): Promise<MeetingMutationReceipt> {
      const port = capability("cancel")
      const validatedId = nonempty(id, "meeting id")
      const occurrenceId =
        options.occurrenceId === undefined ? undefined : nonempty(options.occurrenceId, "occurrence id")
      const ctx = { ...context(options), ...(occurrenceId === undefined ? {} : { occurrenceId }) }
      const outcome = await dispatchMeetingMutation(options, () => port(validatedId, ctx))
      return {
        action: "cancel",
        scope: fixed,
        id: validatedId,
        applied: outcome.applied,
        ...(occurrenceId === undefined ? {} : { occurrenceId }),
      }
    },
  }
}

export type MeetingManagement = ReturnType<typeof createMeetingManagement>
