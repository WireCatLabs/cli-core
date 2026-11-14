import { CliError, wallClock } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import { type FetchLike, providerWaitMs, readJsonResponse, statusToCode } from "@wirecat/cli-base/http"
import type { Command } from "commander"
import { providerRequest } from "../command-runs.js"
import { outputFor } from "../context.js"
import { itemOf, renderAnswer } from "../envelope.js"
import type { ApiCommandInput } from "./api.js"
import { apiJson, parseApiJson } from "./api-input.js"

export interface HttpApiRequest {
  method: string
  url: URL
  headers: Headers
  body?: string
}

export interface HttpApiExecutorOptions {
  /** The service's name in messages: "Notion". */
  service: string
  /** The server the spec names, `https://api.notion.com`; a path template is appended to its path. */
  baseUrl: string
  /** The caller's host-checked fetch (cli-base `hostFetch`), with whatever retry and pace it wraps. */
  fetch: (command: Command) => FetchLike
  /** Read before any guard asks, so a missing sign-in fails first; these win over a header flag of the same name. */
  headers: (command: Command, operation: ManifestOperation) => Record<string, string> | Promise<Record<string, string>>
  /**
   * Every operation that is not a read goes through here: the CLI's guarded write, where a level of `ask` asks and
   * the journal records it. What it returns is the answer printed.
   */
  write: (command: Command, operation: ManifestOperation, send: () => Promise<unknown>) => Promise<unknown>
  /** A read's scope, such as the CLI's run; by default the request is just sent. */
  read?: (command: Command, operation: ManifestOperation, send: () => Promise<unknown>) => Promise<unknown>
  /** The service's own refusal, from its status and parsed answer; `undefined` keeps the shared one. */
  failure?: (status: number, answer: unknown, operation: ManifestOperation) => CliError | undefined
  maxBytes?: number
}

const LARGEST_ANSWER = 16 * 1024 * 1024

/** `new URL` folds a `.` or `..` segment into its parent, so such an id would reach another endpoint. */
const segment = (name: string, value: string | undefined): string => {
  if (value === undefined || value === "" || value === "." || value === "..")
    throw new CliError("validation_error", `${name} must name one item; an empty, "." or ".." id is refused`)
  return encodeURIComponent(value)
}

const jsonBody = (operation: ManifestOperation, input: ApiCommandInput): string | undefined => {
  const fields = Object.entries(input.fields)
  if (fields.length === 0) return input.body
  const parsed = input.body?.trim() ? parseApiJson(input.body) : {}
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("validation_error", `${operation.command} takes a JSON object as its body`)
  const value = parsed as Record<string, unknown>
  for (const [name, raw] of fields) {
    if (Object.hasOwn(value, name))
      throw new CliError("validation_error", `${name} was given in both the body and a flag`)
    value[name] = raw
  }
  return apiJson(value)
}

/** One generated HTTP operation and its flags as the request they stand for; nothing is sent. */
export const httpApiRequest = (
  operation: ManifestOperation,
  input: ApiCommandInput,
  baseUrl: string,
): HttpApiRequest => {
  const { binding } = operation
  if (binding.kind !== "http")
    throw new CliError("configuration_error", `${operation.command} is not an HTTP operation`)
  if (operation.request?.contentType)
    throw new CliError(
      "validation_error",
      `${operation.command} sends ${operation.request.contentType}, which the generated command cannot send; nothing was sent`,
      { sent: false },
    )
  const base = new URL(baseUrl)
  const path = binding.path.replace(/\{([^}]+)\}/g, (_, name: string) => segment(name, input.path[name]))
  const url = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin)
  for (const [name, raw] of Object.entries(input.query)) {
    const parameter = operation.parameters.find((one) => one.in === "query" && one.name === name)
    if (parameter?.schema.type === "array")
      for (const item of raw.split(",")) url.searchParams.append(name, item.trim())
    else url.searchParams.set(name, raw)
  }
  const headers = new Headers(input.headers)
  const body = jsonBody(operation, input)
  if (body !== undefined) headers.set("content-type", "application/json")
  headers.set("accept", "application/json")
  return { method: binding.method, url, headers, ...(body === undefined ? {} : { body }) }
}

/** `/v1/pages/{page_id}` → `/v1/pages/:page_id`: the run record keeps the template, never an id. */
const templateOf = (path: string): string => path.replace(/\{([^}]+)\}/g, ":$1")

const answerOf = async (response: Response, maxBytes: number): Promise<unknown> => {
  if (response.status === 204 || response.headers.get("content-length") === "0") return {}
  return readJsonResponse(response, { maxBytes })
}

/**
 * The `execute` of `generatedApiCommand` for any OpenAPI CLI: fills the path, adds the query, sends the JSON body
 * with the caller's headers through the caller's fetch, and prints the answer. Nothing here retries: a write is
 * never sent twice, since the first may have landed (WC-OUT-20). The service's own error text is never repeated,
 * since it can quote what was sent (WC-SECR-6).
 */
export const httpApiExecutor =
  (options: HttpApiExecutorOptions) =>
  async (command: Command, operation: ManifestOperation, input: ApiCommandInput): Promise<void> => {
    const request = httpApiRequest(operation, input, options.baseUrl)
    const writes = operation.effect !== "read"
    const template = templateOf(operation.binding.kind === "http" ? operation.binding.path : "")
    for (const [name, value] of Object.entries(await options.headers(command, operation)))
      request.headers.set(name, value)
    const send = async (): Promise<unknown> => {
      const end = providerRequest(`${request.method} ${template}`, undefined, {
        method: request.method,
        endpointTemplate: template,
        transport: "http",
      })
      let response: Response
      try {
        response = await options.fetch(command)(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
        })
      } catch (error) {
        const failed = unanswered(options.service, writes, error)
        end({ error: failed })
        throw failed
      }
      const answer = await answerOf(response, options.maxBytes ?? LARGEST_ANSWER).catch((error: unknown) => {
        if (response.ok) throw error
        return undefined
      })
      if (!response.ok) {
        const failed =
          options.failure?.(response.status, answer, operation) ?? refusal(options.service, operation, response, writes)
        end({ status: response.status, error: failed })
        throw failed
      }
      end({ status: response.status })
      return answer
    }
    const answer = writes
      ? await options.write(command, operation, send)
      : await (options.read ?? ((_command, _operation, call) => call()))(command, operation, send)
    renderAnswer(command, outputFor(command), itemOf(answer))
  }

const unanswered = (service: string, writes: boolean, error: unknown): CliError => {
  // A refusal before sending (an undeclared host) changed nothing; a write stopped in flight may have landed (WC-LIFE-9).
  if (error instanceof CliError && (!writes || error.details?.sent === false)) return error
  if (writes)
    return new CliError("outcome_unknown", `${service} did not answer a write; check it before repeating the write`, {
      retryable: false,
    })
  return (error as { name?: string } | undefined)?.name === "TimeoutError"
    ? new CliError("timeout", `${service} did not answer in time`, { retryable: true })
    : new CliError("network_error", `${service} could not be reached`, { retryable: true })
}

const refusal = (service: string, operation: ManifestOperation, response: Response, writes: boolean): CliError => {
  const { status } = response
  if (status === 429) {
    const wait = providerWaitMs(response.headers, wallClock)
    return new CliError("rate_limited", `${service} asked to slow down; retry the command later`, {
      status,
      retryable: true,
      ...(wait === undefined ? {} : { retry_after_ms: wait }),
    })
  }
  if (status >= 500 && writes)
    return new CliError("outcome_unknown", `${service} failed during a write; check it before repeating the write`, {
      status,
      retryable: false,
    })
  return new CliError(statusToCode(status), `${service} refused ${operation.command} (HTTP ${status})`, {
    status,
    retryable: status >= 500,
  })
}
