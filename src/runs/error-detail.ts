import { homedir } from "node:os"
import { isCliFailure } from "../errors/failures.js"
import { providerErrorKey, type RequestEvent } from "./events.js"
import { withoutSecrets } from "./secrets.js"

/**
 * What went wrong, for the owner reading a failed run: the class, the code, the sentence with anything that can be
 * somebody's words masked, where the call went, and where in our code it broke. Keys as written in run.json.
 */
export interface RunError {
  class: string
  code?: string
  reason?: string
  /** The transport's own code (`NoConnection`, `ETIMEDOUT`, `UNAVAILABLE`), kept so a failed run says what broke. */
  cause_code?: string
  message?: string
  /** Ours, not the messenger's: `messages.send`. */
  operation?: string
  http?: { method?: string; endpoint_template?: string; status?: number }
  /** A messenger protocol's refusal: `FLOOD_WAIT`, and its numeric code when it has one (MTProto's 420). */
  provider?: { key?: string; code?: number }
  causes?: { class: string; message?: string }[]
  stack?: string[]
}

const MESSAGE_AT_MOST = 500
const CAUSES_AT_MOST = 5
const FRAMES_AT_MOST = 15

export const errorDetailOf = (error: unknown, response?: RequestEvent): RunError => {
  const details: Record<string, unknown> = isCliFailure(error) ? { ...error.details } : {}
  const thrown = error instanceof Error ? error : undefined
  const code = isCliFailure(error) ? error.code : codeOf(error)
  const reason = typeof details.reason === "string" ? details.reason : undefined
  const causeCode =
    typeof details.cause_code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(details.cause_code)
      ? details.cause_code
      : undefined
  const message = thrown ? redactText(thrown.message) : undefined
  const operation = stringOf(details.operation) ?? response?.operation
  const status = numberOf(details.status) ?? response?.status
  const method = stringOf(details.method) ?? response?.method
  const endpoint = stringOf(details.endpoint) ?? response?.endpointTemplate
  const key = providerErrorKey(details.provider_error) ?? providerErrorKey(response?.providerError)
  const protocol = key !== undefined && method === undefined && endpoint === undefined
  const http =
    method !== undefined || endpoint !== undefined || (status !== undefined && !protocol)
      ? {
          ...(method === undefined ? {} : { method: method.toUpperCase().slice(0, 16) }),
          ...(endpoint === undefined ? {} : { endpoint_template: endpointTemplate(endpoint) }),
          ...(status === undefined ? {} : { status }),
        }
      : undefined
  const causes = causesOf(thrown?.cause ?? details.cause)
  const stack = framesOf(thrown)
  return {
    class: classOf(error),
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason }),
    ...(causeCode === undefined ? {} : { cause_code: causeCode }),
    ...(message ? { message } : {}),
    ...(operation === undefined ? {} : { operation }),
    ...(http ? { http } : {}),
    ...(key === undefined ? {} : { provider: { key, ...(protocol && status !== undefined ? { code: status } : {}) } }),
    ...(causes.length > 0 ? { causes } : {}),
    ...(stack.length > 0 ? { stack } : {}),
  }
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined

const classOf = (error: unknown): string => {
  if (!(error instanceof Error)) return error === null ? "null" : typeof error
  const constructed = error.constructor?.name
  return constructed && constructed !== "Error" && constructed !== error.name ? constructed : error.name
}

/** `ECONNRESET`, `commander.unknownCommand`, `ERR_INVALID_ARG_TYPE` — a code a program set, never a sentence. */
const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(code) ? code : undefined
}

const causesOf = (first: unknown): NonNullable<RunError["causes"]> => {
  const causes: NonNullable<RunError["causes"]> = []
  const seen = new Set<unknown>()
  for (let cause = first; cause !== undefined && cause !== null && causes.length < CAUSES_AT_MOST; ) {
    if (seen.has(cause)) break
    seen.add(cause)
    const message = cause instanceof Error ? redactText(cause.message) : undefined
    causes.push({ class: classOf(cause), ...(message ? { message } : {}) })
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return causes
}

/** `function file:line`, as `command.crashed` writes them: the package's own path, never the home directory. */
export const framesOf = (error: unknown, limit = FRAMES_AT_MOST): string[] => {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : ""
  return stack
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .flatMap((line) => {
      const match = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line)
      if (!match) return []
      const [, fn, path = "", lineNumber] = match
      if (path.startsWith("node:")) return []
      return [`${fn ?? "<anonymous>"} ${fileOf(path)}:${lineNumber}`]
    })
    .slice(0, limit)
}

const fileOf = (path: string): string => {
  const plain = path.replace(/^file:\/\//, "")
  const packaged = /\/node_modules\/((?:@[^/]+\/)?[^/]+\/.+)$/.exec(plain)?.[1]
  if (packaged) return packaged.replace(/\/(?:dist|src)\//, "/")
  return /(?:^|\/)(?:dist|src)\/(.+)$/.exec(plain)?.[1] ?? plain.split("/").at(-1) ?? "?"
}

/**
 * Where a request went, with nothing in it that names a person or opens an account: no query string, no user, an id
 * or a token in the path as `:id` / `:token`. The host stays — which service refused is the point.
 */
export const endpointTemplate = (raw: string): string => {
  const trimmed = raw.trim().split(/[?#]/)[0] ?? ""
  const origin = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]*)/i.exec(trimmed)
  const path = origin ? trimmed.slice(origin[0].length) : trimmed
  const scheme = origin ? `${trimmed.slice(0, trimmed.indexOf("://"))}://${origin[1]}` : ""
  const segments = path.split("/").map((segment) => {
    if (segment === "" || /^[:{].+/.test(segment)) return segment
    if (/^bot\d+:/.test(segment) || /^\d{6,}:[\w-]{20,}$/.test(segment)) return ":token"
    if (/^-?\d+$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment)) return ":id"
    if (!/^[A-Za-z0-9._~-]{1,40}$/.test(segment)) return ":value"
    return segment
  })
  return `${scheme}${segments.join("/")}`.slice(0, 300)
}

/** A phone number as people type it with its country code, and one written as digits only without the "+". */
export const INTERNATIONAL_PHONE = /\+\d[\d\s()-]{6,}\d/.source
export const BARE_PHONE = /(^|[^\w-])\d{11,15}\b/.source

/**
 * An error's sentence with what could be somebody's words or a secret taken out: anything in quotes, an email, a
 * phone number, a secret `withoutSecrets` finds, a bot token, a bearer or a long opaque string, a URL's query, the
 * home directory. A second line of defence — errors here are written to name things, not quote them — so it errs
 * toward masking.
 */
export const redactText = (text: string): string => {
  const home = homedir()
  let out = home && home !== "/" ? text.split(home).join("~") : text
  out = withoutSecrets(out.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, '"[redacted]"'))
    .replace(/\b(bearer|basic|token|key|password|secret)(\s*[:=]\s*|\s+)[^\s'"]+/gi, "$1$2[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(new RegExp(INTERNATIONAL_PHONE, "g"), "[number]")
    .replace(new RegExp(BARE_PHONE, "g"), "$1[number]")
    .replace(/\bbot\d+:[\w-]+/g, "bot[token]")
    .replace(/\b\d{6,}:[\w-]{20,}\b/g, "[token]")
    .replace(/(\?|&)[^\s#]*/g, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
  return out.length > MESSAGE_AT_MOST ? `${out.slice(0, MESSAGE_AT_MOST)}…` : out
}
