import { CliError } from "@wirecat/cli-base"
import {
  type ApiServer,
  type ManifestOperation,
  type Pagination,
  type SecurityRequirement,
  type SecurityScheme,
  type SignInPlace,
  signInPlace,
  signInRequirements,
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
 * The first server the spec names. A variable is filled from `variables` first, such as the site a profile signed in
 * to; else with its default, only when its `enum` lists the choices: a free one (`{site}`) names the owner's own host,
 * which the default would send the token past.
 */
export const manifestBaseUrl = (
  manifest: ServiceApiManifest,
  given?: string,
  variables: Readonly<Record<string, string>> = {},
): string => {
  const server = manifest.servers?.[0]
  if (given === undefined && !server)
    throw new CliError("configuration_error", "the manifest names no server; give the api a baseUrl")
  const url =
    given ??
    (server as ApiServer).url.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = variables[name]
      // Only a variable that is the whole host takes a host with a port or a path: `{subdomain}.example.com` given
      // `evil.test/x` would send the token to evil.test.
      if (value !== undefined)
        return wholeHost(server as ApiServer, name) ? serverValue(name, value) : labelValue(name, value)
      const variable = server?.variables?.[name]
      if (variable?.default === undefined || !variable.enum?.includes(variable.default))
        throw new CliError(
          "configuration_error",
          `the server's {${name}} is the owner's own; sign in with session start --${name}, or give the api a baseUrl`,
        )
      return variable.default
    })
  if (!/^https:\/\//.test(url)) throw new CliError("configuration_error", `the api's server ${url} is not https`)
  if (!URL.canParse(url) || new URL(url).username || new URL(url).password)
    throw new CliError("configuration_error", `the api's server ${url} is not a URL without a user name`)
  return url
}

/**
 * The site an owner types, as a server's free variable takes it: a host with a port or a path if any, from
 * `blog.example.com` or `https://blog.example.com/`. Only https: an `http://` address is refused, not rewritten.
 */
export const siteValue = (raw: string): string => {
  const text = raw
    .trim()
    .replace(/^https:\/\//i, "")
    .replace(/\/+$/, "")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    throw new CliError("validation_error", `--site takes an https address or a host, not ${JSON.stringify(raw)}`)
  const [host = "", ...path] = serverValue("site", text, "validation_error").split("/")
  const site = [host.toLowerCase(), ...path].join("/")
  // What a URL makes of it must be what was typed: `0x7f.1`, `a.test/..` or a port past 65535 lands elsewhere.
  const url = URL.canParse(`https://${site}`) ? new URL(`https://${site}`) : undefined
  if (
    !url ||
    url.host !== site.split("/")[0] ||
    url.pathname.replace(/\/$/, "") !== site.slice(site.split("/")[0]?.length)
  )
    throw new CliError("validation_error", `--site ${JSON.stringify(raw)} is not a plain https address`)
  return site
}

const wholeHost = (server: ApiServer, name: string) =>
  server.url === `https://{${name}}` || server.url.startsWith(`https://{${name}}/`)

const labelValue = (name: string, value: string) => {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value))
    throw new CliError("configuration_error", `{${name}} ${JSON.stringify(value)} is not one name without dots`)
  return value
}

// A value only names a place: a user name, query or fragment in it would change where the token goes, or add to it.
const serverValue = (
  name: string,
  value: string,
  code: "configuration_error" | "validation_error" = "configuration_error",
) => {
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d+)?(\/[A-Za-z0-9._~%-]+)*$/.test(value))
    throw new CliError(code, `{${name}} ${JSON.stringify(value)} is not a host, with a port or a path if any`)
  return value
}

/**
 * Where the sign-in goes for one operation: the first place its requirements' schemes name that a token can be sent
 * to, a header before a key in the query, which a proxy or a server log could keep. `undefined` for a call that needs
 * none: its security, its own or else the document's, is absent, as in a spec that says nothing about sign-in, or
 * empty (`[]`, `[{}]`). An optional sign-in (`[{}, { oauth: [] }]`) still sends the token.
 */
// cli-base reads no basic scheme yet; the token of one is `<user>:<password>`, as `session start --login` keeps it.
const basicPlace = (scheme: SecurityScheme): SignInPlace | undefined =>
  scheme.type === "http" && /^basic$/i.test(scheme.scheme ?? "")
    ? {
        in: "header",
        name: "authorization",
        value: (token) => {
          if (!token.includes(":"))
            throw new CliError(
              "authentication_error",
              "this service signs in with a user name and a password: run session start --login <name>",
            )
          return `Basic ${Buffer.from(token).toString("base64")}`
        },
      }
    : undefined

const authOf = (manifest: ServiceApiManifest, operation: ManifestOperation): SignInPlace | undefined => {
  const requirements = signInRequirements(operation, manifest.security)
  if (!requirements) return undefined
  const names = requirements.flatMap((one) => Object.keys(one))
  const sendable = names.flatMap((name) => {
    const scheme = manifest.securitySchemes?.[name]
    const place = scheme && (signInPlace(scheme) ?? basicPlace(scheme))
    return place ? [{ place, basic: !signInPlace(scheme) }] : []
  })
  // Basic only when nothing else is offered: it needs a user name a token sign-in does not keep.
  const auth = (
    sendable.find((one) => one.place.in === "header" && !one.basic) ??
    sendable.find((one) => !one.basic) ??
    sendable[0]
  )?.place
  if (auth) return auth
  throw new CliError(
    "configuration_error",
    `${operation.command} signs in by ${names.join(" or ")}, which the api cannot send`,
  )
}

/**
 * Signs one request for its operation. Set the final URL first: a key in the query goes into it. Anything but the
 * standard sign-in header, or a key in the query, never follows a redirect, even to the same host: another host would
 * get the key. The URL then holds the key, so a fetch wrapper must not log it. Without `token`, for a CLI that never
 * signs in, nothing is added.
 */
export const signRequest = async (
  manifest: ServiceApiManifest,
  operation: ManifestOperation,
  request: { url: URL; headers: Headers; redirect?: "follow" | "manual" | "error" },
  token: (() => Promise<string> | string) | undefined,
): Promise<void> => {
  if (!token) return
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
