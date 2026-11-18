import { CliError, type ErrorCode, wallClock } from "@wirecat/cli-base"
import { type GraphqlBinding, graphqlDocument, type ManifestOperation } from "@wirecat/cli-base/codegen"
import { type FetchLike, providerWaitMs, readJsonResponse, statusToCode } from "@wirecat/cli-base/http"
import type { Command } from "commander"
import { providerRequest } from "../command-runs.js"
import { outputFor } from "../context.js"
import { itemOf, renderAnswer } from "../envelope.js"
import type { ApiCommandInput } from "./api.js"
import { apiJson, graphqlVariables, parseApiJson, sendsBytes } from "./api-input.js"

export interface HttpApiRequest {
  method: string
  url: URL
  headers: Headers
  /** JSON text, or an upload's bytes. */
  body?: string | Uint8Array<ArrayBuffer>
  /** `manual` for a request whose sign-in header a redirect to another host would carry along. */
  redirect?: "follow" | "manual" | "error"
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
  /**
   * The service's own refusal, from its status and parsed answer; `undefined` keeps the shared one. Never asked for a
   * write that failed on the service's side: that is always `outcome_unknown`.
   */
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

/** Why the generated command cannot send the operation's body, or `undefined` when it can: JSON, or an upload's bytes. */
export const unsendableBody = (operation: ManifestOperation): string | undefined => {
  const type = operation.request?.contentType
  return type === undefined || sendsBytes(operation)
    ? undefined
    : `it sends ${type}, which the generated command cannot send`
}

/** One generated HTTP operation and its flags as the request they stand for; nothing is sent. */
export const httpApiRequest = (
  operation: ManifestOperation,
  input: ApiCommandInput,
  baseUrl: string,
): HttpApiRequest => {
  const { binding } = operation
  if (binding.kind !== "http" && binding.kind !== "graphql")
    throw new CliError("configuration_error", `${operation.command} is not an HTTP operation`)
  if (unsendableBody(operation))
    throw new CliError(
      "validation_error",
      `${operation.command} sends ${operation.request?.contentType}, which the generated command cannot send; nothing was sent`,
      { sent: false },
    )
  if (operation.response?.sensitive)
    throw new CliError(
      "validation_error",
      `${operation.command} answers with a credential, which the generated command never prints; nothing was sent`,
      { sent: false },
    )
  if (binding.kind === "graphql") return graphqlRequest(operation, binding, input, baseUrl)
  if (Object.keys(input.fields).length > 0)
    throw new CliError("configuration_error", `${operation.command} has body fields as flags, which HTTP cannot send`)
  if (!/^\/(?!\/)/.test(binding.path))
    throw new CliError("configuration_error", `${operation.command} has a path that does not start with one /`)
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
  headers.set("accept", "application/json")
  if (sendsBytes(operation)) {
    if (input.bytes === undefined) return { method: binding.method, url, headers }
    headers.set("content-type", operation.request?.contentType as string)
    return { method: binding.method, url, headers, body: input.bytes }
  }
  const body = input.body?.trim() ? input.body : undefined
  // The command's checkBody may not parse the body; text that is not JSON never reaches the service.
  if (body !== undefined) parseApiJson(body)
  if (body !== undefined) headers.set("content-type", "application/json")
  return { method: binding.method, url, headers, ...(body === undefined ? {} : { body }) }
}

/** One GraphQL operation as a POST of its one document to the endpoint, with its variables. */
const graphqlRequest = (
  operation: ManifestOperation,
  binding: GraphqlBinding,
  input: ApiCommandInput,
  baseUrl: string,
): HttpApiRequest => {
  const variables = graphqlVariables(operation, input.body, input.fields)
  const headers = new Headers(input.headers)
  headers.set("accept", "application/json")
  headers.set("content-type", "application/json")
  const query = graphqlDocument(binding, input.selection)
  // A 307 or 308 would send the variables again, to wherever it points.
  return { method: "POST", url: new URL(baseUrl), headers, body: apiJson({ query, variables }), redirect: "error" }
}

/** `/v1/pages/{page_id}` → `/v1/pages/:page_id`: the run record keeps the template, never an id. */
const templateOf = (path: string): string => path.replace(/\{([^}]+)\}/g, ":$1")

/** What the run record names a request by: the path template, or a GraphQL operation's root field. */
const endpointOf = (operation: ManifestOperation): string =>
  operation.binding.kind === "http"
    ? templateOf(operation.binding.path)
    : operation.binding.kind === "graphql"
      ? `${operation.binding.operation}/${operation.binding.field}`
      : ""

// Common GraphQL server codes (Apollo's names) as the CLI's; any other is the provider's.
const GRAPHQL_CODES = {
  UNAUTHENTICATED: "authentication_error",
  AUTHENTICATION_ERROR: "authentication_error",
  FORBIDDEN: "permission_error",
  RATELIMITED: "rate_limited",
  BAD_USER_INPUT: "validation_error",
  GRAPHQL_VALIDATION_FAILED: "validation_error",
  INVALID_INPUT: "validation_error",
} satisfies Record<string, ErrorCode>

// A refusal of these kinds means the service did nothing, so a write that got one is not in doubt.
const NOTHING_RAN = new Set<ErrorCode>(["authentication_error", "permission_error", "rate_limited", "validation_error"])

/**
 * A GraphQL answer comes with HTTP 200 even when it failed: `errors[]` is the failure, named by the CLI's own
 * `failure`, else by its first `extensions.code`, never by the service's message (WC-SECR-6). A write that failed in
 * any other way, or answered data too, may have landed (WC-LIFE-9). Otherwise the answer is `data.<field>`.
 */
const graphqlAnswer = (options: HttpApiSendOptions, operation: ManifestOperation, answer: unknown): unknown => {
  const { binding } = operation
  if (binding.kind !== "graphql") return answer
  const { data, errors } = (answer ?? {}) as { data?: Record<string, unknown> | null; errors?: unknown }
  if (Array.isArray(errors) && errors.length > 0) {
    const own = options.failure?.(200, answer, operation)
    if (own) throw own
    const raw = (errors[0] as { extensions?: { code?: unknown } } | null)?.extensions?.code
    // The code is the service's text too: only a plain constant is repeated.
    const code = typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(raw) ? raw : undefined
    const known: ErrorCode = (code && GRAPHQL_CODES[code as keyof typeof GRAPHQL_CODES]) || "provider_error"
    const writes = operation.effect !== "read"
    if (writes && (!NOTHING_RAN.has(known) || data?.[binding.field] != null)) return outcomeUnknown(options.service)
    throw new CliError(known, `${options.service} refused ${operation.command}${code ? ` (${code})` : ""}`, {
      retryable: known === "rate_limited",
    })
  }
  if (!data || !(binding.field in data))
    throw new CliError(
      "invalid_response",
      `${options.service} answered ${operation.command} without data.${binding.field}`,
    )
  return data[binding.field]
}

const outcomeUnknown = (service: string): never => {
  throw new CliError("outcome_unknown", `${service} did not confirm a write; check it before repeating the write`, {
    retryable: false,
  })
}

const answerOf = async (response: Response, maxBytes: number): Promise<unknown> => {
  if (response.status === 204 || !response.body || response.headers.get("content-length") === "0") return {}
  return readJsonResponse(response, { maxBytes })
}

/** What one exchange needs: the service's name, the fetch, its own refusals and the answer's size limit. */
export type HttpApiSendOptions = Pick<HttpApiExecutorOptions, "service" | "fetch" | "failure" | "maxBytes">

/**
 * Sends one request, records it in the run by its path template, never an id, and gives the parsed answer with the
 * response's headers, where a service may page (WordPress's `X-WP-TotalPages`). A write that got no answer is
 * `outcome_unknown` (WC-LIFE-9); the service's own error text is never repeated (WC-SECR-6).
 */
export const httpApiExchange =
  (options: HttpApiSendOptions) =>
  async (
    command: Command,
    operation: ManifestOperation,
    request: HttpApiRequest,
  ): Promise<{ answer: unknown; headers: Headers }> => {
    const writes = operation.effect !== "read"
    const template = endpointOf(operation)
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
        ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
      })
    } catch (error) {
      const failed = unanswered(options.service, writes, error)
      end({ error: failed })
      throw failed
    }
    const { status } = response
    let answer: unknown
    try {
      answer = await answerOf(response, options.maxBytes ?? LARGEST_ANSWER)
    } catch {
      if (response.ok) {
        end({ status })
        throw unreadable(options.service, writes, status)
      }
    }
    if (!response.ok) {
      const failed =
        status >= 500 && writes
          ? refusal(options.service, operation, response, writes)
          : (options.failure?.(status, answer, operation) ?? refusal(options.service, operation, response, writes))
      end({ status, error: failed })
      throw failed
    }
    try {
      const result = graphqlAnswer(options, operation, answer)
      end({ status })
      return { answer: result, headers: response.headers }
    } catch (error) {
      end({ status, error })
      throw error
    }
  }

/** `httpApiExchange`'s answer alone. */
export const httpApiSend = (options: HttpApiSendOptions) => {
  const exchange = httpApiExchange(options)
  return async (command: Command, operation: ManifestOperation, request: HttpApiRequest): Promise<unknown> =>
    (await exchange(command, operation, request)).answer
}

/**
 * The `execute` of `generatedApiCommand` for any OpenAPI CLI: fills the path, adds the query, sends the JSON body
 * with the caller's headers through the caller's fetch, and prints the answer. Nothing here retries: a write is
 * never sent twice, since the first may have landed (WC-OUT-20).
 */
export const httpApiExecutor =
  (options: HttpApiExecutorOptions) =>
  async (command: Command, operation: ManifestOperation, input: ApiCommandInput): Promise<void> => {
    const request = httpApiRequest(operation, input, options.baseUrl)
    for (const [name, value] of Object.entries(await options.headers(command, operation)))
      request.headers.set(name, value)
    const send = () => httpApiSend(options)(command, operation, request)
    const answer =
      operation.effect !== "read"
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

/** The service took the request; only its answer is lost, so a write must not look safe to send again. */
const unreadable = (service: string, writes: boolean, status: number): CliError =>
  writes
    ? new CliError(
        "outcome_unknown",
        `${service} took the write but its answer could not be read; check it before repeating the write`,
        {
          status,
          retryable: false,
        },
      )
    : new CliError("invalid_response", `${service} sent an answer that could not be read`, { status, retryable: true })

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
  if (status === 401)
    return new CliError("authentication_error", `${service} refused the sign-in; sign in again`, {
      reason: "auth.failed",
      status,
    })
  if (status === 403)
    return new CliError("permission_error", `${service} denied ${operation.command} to this account`, {
      reason: "access.denied",
      status,
    })
  return new CliError(statusToCode(status), `${service} refused ${operation.command} (HTTP ${status})`, {
    status,
    retryable: status >= 500,
  })
}
