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

export const MEETING_FIELDS: readonly MeetingField[] = Object.freeze([
  "title",
  "kind",
  "startTime",
  "durationMinutes",
  "timezone",
  "agenda",
])

/** A setting only this service has, given as `--setting <name>=<value>`; the name is snake_case. */
export type MeetingSetting =
  | { name: string; description: string; type: "choice"; values: readonly string[] }
  | { name: string; description: string; type: "boolean" }
  | { name: string; description: string; type: "text" }

/** What one write port reads. A port that declares nothing reads every `MEETING_FIELDS` entry and no setting. */
export interface MeetingFields {
  fields?: readonly MeetingField[]
  settings?: readonly MeetingSetting[]
}

export interface MeetingCreateFields extends MeetingFields {
  /**
   * The service can create a meeting that starts at once (Zoom's instant meeting, a Meet space): a create with no
   * start then starts now. True when absent.
   */
  instant?: boolean
}

/** A declaration with its defaults filled in, as `createMeetingManagement` exposes it. */
export interface DeclaredMeetingFields {
  readonly fields: readonly MeetingField[]
  readonly settings: readonly MeetingSetting[]
  readonly instant: boolean
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
  fields?: { create?: MeetingCreateFields; update?: MeetingFields }
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

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const SNAKE_NAMES: Readonly<Record<MeetingField, string>> = {
  title: "title",
  kind: "kind",
  startTime: "start_time",
  durationMinutes: "duration_minutes",
  timezone: "timezone",
  agenda: "agenda",
}

/** Checks a port's declaration once, when the management is made: a bad one is the host's mistake, not the owner's. */
export const declareMeetingFields = (declared: MeetingCreateFields = {}): DeclaredMeetingFields => {
  const wrong = (why: string) => new CliError("configuration_error", `meeting fields: ${why}`)
  const fields = declared.fields ?? MEETING_FIELDS
  for (const field of fields) if (!MEETING_FIELDS.includes(field)) throw wrong(`unknown field ${String(field)}`)
  const names = new Set<string>()
  const settings = (declared.settings ?? []).map((setting) => {
    const name: unknown = setting?.name
    if (typeof name !== "string" || !SNAKE.test(name)) throw wrong(`setting name ${String(name)} is not snake_case`)
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
  return Object.freeze({
    fields: Object.freeze([...new Set(fields)]),
    settings: Object.freeze(settings),
    instant: declared.instant ?? true,
  })
}

const supportedList = (declared: DeclaredMeetingFields): string => {
  const all = [
    ...declared.fields.map((field) => SNAKE_NAMES[field]),
    ...declared.settings.map((setting) => `setting ${setting.name}`),
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
  return value
}

export interface MeetingChangeRules {
  /** What the port reads; `declareMeetingFields()` (every portable field, no setting) when absent. */
  declared?: DeclaredMeetingFields
  /** The time an instant meeting starts at, epoch milliseconds; the clock's when absent. */
  now?: number
}

/**
 * Returns a detached, canonical change with only what the port declared. A create always carries `kind` and
 * `startTime`: a meeting with no start given starts now when the service has instant meetings.
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
  const undeclared = Object.keys(change).filter(
    (key) =>
      change[key as keyof ManagedMeetingChange] !== undefined &&
      key !== "settings" &&
      !declared.fields.includes(key as MeetingField),
  )
  const given = change.settings ?? {}
  if (typeof given !== "object" || Array.isArray(given) || given === null)
    throw new CliError("validation_error", "meeting settings must be an object of name and value")
  for (const name of Object.keys(given))
    if (!declared.settings.some((setting) => setting.name === name)) undeclared.push(`setting ${name}`)
  if (undeclared.length)
    throw new CliError(
      "validation_error",
      `this service does not take ${undeclared
        .map((key) => SNAKE_NAMES[key as MeetingField] ?? key)
        .join(", ")} on ${action}; it takes ${supportedList(declared)}`,
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
  const settings = Object.entries(given).map(([name, value]) => {
    const setting = declared.settings.find((one) => one.name === name) as MeetingSetting
    return [name, settingValue(setting, value)] as const
  })
  if (settings.length) result.settings = Object.freeze(Object.fromEntries(settings))
  if (create) {
    result.kind ??= result.startTime === undefined ? "instant" : "scheduled"
    if (result.kind === "instant" && !declared.instant)
      throw new CliError("validation_error", "this service has no instant meetings: give the meeting's start time")
    if (result.kind === "scheduled" && result.startTime === undefined)
      throw new CliError("validation_error", "scheduled meeting start is required")
    result.startTime ??= new Date(rules.now ?? Date.now()).toISOString()
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
    create: declareMeetingFields(ports.fields?.create),
    update: declareMeetingFields(ports.fields?.update),
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
      const validated = validateMeetingChange(change, true, { declared: fields.create, now: now() })
      const ctx = context(options)
      const outcome = await dispatchMeetingMutation(options, () => port(validated, ctx))
      return {
        action: "create",
        scope: fixed,
        change: validated,
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
