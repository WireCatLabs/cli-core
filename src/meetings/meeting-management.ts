import { CliError } from "@wirecat/cli-base"
import { type MeetingProviderScope, snapshotMeetingScope } from "./provider.js"

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
}

export interface MeetingOperationOptions {
  signal?: AbortSignal
}

export interface MeetingMutationOptions extends MeetingOperationOptions {
  apply?: boolean
  dryRun?: boolean
  occurrenceId?: string
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
}

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

/** Returns a detached, canonical change; provider-specific extensions stay in adapters. */
export const validateMeetingChange = (
  change: ManagedMeetingChange,
  create: boolean,
): Readonly<ManagedMeetingChange> => {
  if (
    !change ||
    typeof change !== "object" ||
    Array.isArray(change) ||
    Object.keys(change).some(
      (key) => !["title", "kind", "startTime", "durationMinutes", "timezone", "agenda"].includes(key),
    )
  )
    throw new CliError("validation_error", "unsupported meeting change field")
  const result: ManagedMeetingChange = {}
  if (change.title !== undefined) result.title = nonempty(change.title, "meeting title")
  if (create && result.title === undefined) throw new CliError("validation_error", "meeting title is required")
  if (change.kind !== undefined) {
    if (change.kind !== "instant" && change.kind !== "scheduled")
      throw new CliError("validation_error", "only instant or scheduled meeting kinds are supported")
    result.kind = change.kind
  }
  if (change.startTime !== undefined) {
    const value = change.startTime
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw new CliError("validation_error", "meeting start must be an ISO timestamp with a timezone")
    const date = value.slice(0, 10)
    const instant = Date.parse(`${date}T00:00:00Z`)
    if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== date)
      throw new CliError("validation_error", "meeting start contains an invalid calendar date")
    result.startTime = new Date(value).toISOString()
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
  if (create) {
    result.kind ??= "scheduled"
    if (result.kind === "scheduled" && result.startTime === undefined)
      throw new CliError("validation_error", "scheduled meeting start is required")
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
  const { apply, dryRun, signal } = options
  checkCancelled(signal)
  if (apply !== true || dryRun) return { applied: false }
  return { applied: true, value: await dispatch(signal) }
}

export const createMeetingManagement = (scope: MeetingProviderScope, ports: MeetingManagementPorts) => {
  const fixed = snapshotMeetingScope(scope)
  const capabilities: MeetingManagementPorts = {}
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
  const capability = <K extends keyof MeetingManagementPorts>(name: K): NonNullable<MeetingManagementPorts[K]> => {
    const port = capabilities[name]
    if (!port) throw new CliError("provider_unavailable", `meeting provider does not support ${name}`)
    return port as NonNullable<MeetingManagementPorts[K]>
  }
  return {
    scope: fixed,
    capabilities: Object.freeze(
      Object.keys(capabilities).filter(
        (name) => typeof capabilities[name as keyof MeetingManagementPorts] === "function",
      ),
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
      const validated = validateMeetingChange(change, true)
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
      const validated = validateMeetingChange(change, false)
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
