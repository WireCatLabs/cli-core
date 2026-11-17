import { CliError } from "@wirecat/cli-base"
import type {
  ApiServer,
  ManifestOperation,
  Pagination,
  SecurityRequirement,
  SecurityScheme,
} from "@wirecat/cli-base/codegen"
import type { ApiCommandInput } from "./bot/api.js"
import { apiJson, parseApiJson } from "./bot/api-input.js"

/** What `generate` writes into a CLI's `generated/manifest.ts`: `import * as manifest from "./generated/manifest.js"`. */
export interface ServiceApiManifest {
  operations: readonly ManifestOperation[]
  servers?: readonly ApiServer[]
  securitySchemes?: Readonly<Record<string, SecurityScheme>>
  security?: readonly SecurityRequirement[]
}

/**
 * The first server the spec names. A variable is filled with its default only when its `enum` lists the choices: a
 * free one (`{subdomain}`) names the owner's own host, which the default would send the token past.
 */
export const manifestBaseUrl = (manifest: ServiceApiManifest, given?: string): string => {
  const server = manifest.servers?.[0]
  if (given === undefined && !server)
    throw new CliError("configuration_error", "the manifest names no server; give the api a baseUrl")
  const url =
    given ??
    (server as ApiServer).url.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const variable = server?.variables?.[name]
      if (variable?.default === undefined || !variable.enum?.includes(variable.default))
        throw new CliError("configuration_error", `the server's {${name}} is the owner's own; give the api a baseUrl`)
      return variable.default
    })
  if (!/^https:\/\//.test(url)) throw new CliError("configuration_error", `the api's server ${url} is not https`)
  return url
}

type Auth = { name: string; value: (token: string) => string; in?: "query" }

const BEARER: Auth = { name: "authorization", value: (token) => `Bearer ${token}` }

/** Where one scheme puts the sign-in; `undefined` for one the api cannot send (basic, a key in a cookie). */
const headerOf = (scheme: SecurityScheme): Auth | undefined => {
  if (scheme.type === "apiKey") {
    if (!scheme.name) return undefined
    if (scheme.in === "header") return { name: scheme.name.toLowerCase(), value: (token) => token }
    return scheme.in === "query" ? { name: scheme.name, value: (token) => token, in: "query" } : undefined
  }
  if (scheme.type === "http") {
    if (!scheme.scheme || /^bearer$/i.test(scheme.scheme)) return BEARER
    return /^(basic|digest)$/i.test(scheme.scheme)
      ? undefined
      : { name: "authorization", value: (token) => `${scheme.scheme} ${token}` }
  }
  return scheme.type === "oauth2" || scheme.type === "openIdConnect" ? BEARER : undefined
}

/**
 * The header, or query parameter, that carries the sign-in for one operation, from the first scheme of its requirements the api can send;
 * `undefined` for one that needs none (`security: []`, or only `{}`). A manifest without schemes signs in with a bearer
 * token, as most services do. An optional sign-in (`[{}, { oauth: [] }]`) still sends the token. A header wins over a
 * key in the query, which a proxy or a server log could keep.
 */
const authOf = (manifest: ServiceApiManifest, operation: ManifestOperation): Auth | undefined => {
  const requirements = operation.security ?? manifest.security
  if (requirements?.every((one) => Object.keys(one).length === 0)) return undefined
  if (!manifest.securitySchemes) return BEARER
  const names = (requirements ?? []).flatMap((one) => Object.keys(one))
  const sendable = names.flatMap((name) => {
    const scheme = manifest.securitySchemes?.[name]
    const auth = scheme && headerOf(scheme)
    return auth ? [auth] : []
  })
  const auth = sendable.find((one) => one.in === undefined) ?? sendable[0]
  if (auth) return auth
  if (names.length === 0) return BEARER
  throw new CliError(
    "configuration_error",
    `${operation.command} signs in by ${names.join(" or ")}, which the api cannot send`,
  )
}

/**
 * Signs one request for its operation. Set the final URL first: a key in the query goes into it. Anything but the
 * standard sign-in header, or a key in the query, never follows a redirect, even to the same host: another host would
 * get the key. The URL then holds the key, so a fetch wrapper must not log it.
 */
export const signRequest = async (
  manifest: ServiceApiManifest,
  operation: ManifestOperation,
  request: { url: URL; headers: Headers; redirect?: "follow" | "manual" | "error" },
  token: () => Promise<string> | string,
): Promise<void> => {
  const auth = authOf(manifest, operation)
  if (!auth) return
  const value = auth.value(await token())
  if (auth.in === "query") request.url.searchParams.set(auth.name, value)
  else request.headers.set(auth.name, value)
  if (auth.in === "query" || auth.name !== "authorization") request.redirect = "manual"
}

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (inner, key) => (inner && typeof inner === "object" ? (inner as Record<string, unknown>)[key] : undefined),
      value,
    )

const numberOf = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number(String(value))
  return Number.isFinite(number) ? number : undefined
}

export const parameterValue = (input: ApiCommandInput, parameter: { in: "query" | "body"; name: string }): unknown =>
  parameter.in === "query"
    ? input.query[parameter.name]
    : input.body === undefined
      ? undefined
      : (parseApiJson(input.body) as Record<string, unknown> | null)?.[parameter.name]

export const withValue = (
  input: ApiCommandInput,
  parameter: { in: "query" | "body"; name: string },
  value: string | number,
): ApiCommandInput => {
  if (parameter.in === "query") return { ...input, query: { ...input.query, [parameter.name]: String(value) } }
  const body = input.body === undefined ? {} : parseApiJson(input.body)
  return { ...input, body: apiJson({ ...(body as Record<string, unknown>), [parameter.name]: value }) }
}

/** One page's items, and how to ask for the next: new flags, the next page's whole URL, or `undefined` at the end. */
export interface PageStep {
  items: readonly unknown[]
  next?: { input: ApiCommandInput } | { url: string }
}

/** Reads one answer by the manifest's pagination: where its items are and what the next request is. */
export const nextPage = (pagination: Pagination, input: ApiCommandInput, answer: unknown): PageStep => {
  const listed = pagination.items === undefined ? [answer] : at(answer, pagination.items)
  const items = Array.isArray(listed) ? listed : []
  switch (pagination.style) {
    case "cursor": {
      const cursor = at(answer, pagination.next)
      const more = pagination.hasMore === undefined || at(answer, pagination.hasMore) !== false
      return more && typeof cursor === "string" && cursor !== ""
        ? { items, next: { input: withValue(input, pagination.cursor, cursor) } }
        : { items }
    }
    case "offset":
    case "page": {
      const parameter = pagination.style === "offset" ? pagination.offset : pagination.page
      const total = pagination.total === undefined ? undefined : numberOf(at(answer, pagination.total))
      const current = numberOf(parameterValue(input, parameter)) ?? (pagination.style === "offset" ? 0 : 1)
      const next = pagination.style === "offset" ? current + items.length : current + 1
      // A short page is not the last: a service may cap the page below the limit asked for. Only a total or an
      // empty page ends it.
      const last = items.length === 0 || (total !== undefined && pagination.style === "offset" && next >= total)
      return last ? { items } : { items, next: { input: withValue(input, parameter, next) } }
    }
    case "link": {
      const url = at(answer, pagination.next)
      return typeof url === "string" && url !== "" ? { items, next: { url } } : { items }
    }
  }
}
