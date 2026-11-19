import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { ContentManifest } from "../content/manifest/manifest.js"
import type { CrmManifest } from "../crm/manifest/manifest.js"
import type { OAuthProvider } from "../oauth/provider.js"
import type { TrackerManifest } from "../tracker/manifest/manifest.js"

/** A dotted path into an answer, as the source manifest reads it: `auth.verify`'s `id`, `name` and `active`. */
export { at as valueAt } from "../crm/manifest/map.js"

/**
 * The operation that answers whose the token is, and where its answer holds the account's id (and a name to show):
 * `{ operation: "getV2Self", id: "workspace_id", name: "workspace_name" }`. `session start` checks a token with it.
 */
export interface CliVerify {
  operation: string
  id: string
  name?: string
  /**
   * Where the answer says the token still works, for a service that answers a dead token with success: Attio's
   * `GET /v2/self` gives 200 `{ "active": false }` to an unknown, revoked or deleted token. Anything but `true` there is
   * a refused sign-in.
   */
  active?: string
}

export type CliAuth =
  | { preset: "none" }
  /** A token or key, sent where the spec's `securitySchemes` say: a bearer header, an API key header or query. */
  | { preset: "token"; verify?: CliVerify }
  /**
   * A WordPress application password: the profile's own site (`--site host/blog`), a user name and the password, sent
   * by Basic to that site alone.
   */
  | { preset: "app-password"; verify?: CliVerify }
  /** The browser sign-in the spec's authorization code flow declares; the redirect is what the app registered. */
  | {
      preset: "oauth2-pkce"
      verify?: CliVerify
      scopes: readonly string[]
      scheme?: string
      redirect?: OAuthProvider["redirect"]
      revokeUrl?: string
      authorizeParams?: Record<string, string>
      /** The provider sends a new refresh token on each refresh; the spec cannot say so. */
      rotating?: boolean
    }

export const CLI_CATEGORIES = [
  "messenger",
  "mail",
  "notes",
  "files",
  "meetings",
  "calendar",
  "crm",
  "tracker",
  "content",
  "other",
] as const
export type CliCategory = (typeof CLI_CATEGORIES)[number]

/** One file, `wirecat.config.ts`, that `new --from-config` builds a CLI from. */
export interface CliConfig {
  identity: {
    /** The word people type: `attio`. */
    command: string
    /** `@wirecat/attio-cli`. */
    package: string
    /** The environment variables' prefix: `WCATTIO`. */
    prefix: string
    /** The name people know: `Attio`. */
    service: string
    /** The GitHub owner of the repository. */
    owner: string
  }
  /**
   * `from`: the https URL the description is published at. For `wp-json`, a WordPress site's REST index
   * (`https://wp.example/wp-json/`), from a plain WordPress the CLI is made against, as it serves every site.
   */
  spec: {
    kind: "openapi" | "swagger" | "graphql" | "wp-json"
    from: string
    /** The WordPress version `from` runs, for the snapshot's provenance: the index does not say it. */
    version?: string
  }
  auth: CliAuth
  /** cli-template's `--category`; `other` is any API outside them. */
  category: CliCategory
  /**
   * A crm, tracker or content CLI's source; checked against the generated API by `parseCrmManifest`,
   * `parseTrackerManifest` or `parseContentManifest` once the api group exists.
   */
  source?: CrmManifest | TrackerManifest | ContentManifest
  /** The module of named hooks, relative to the config: `./src/hooks.ts`. */
  hooks?: string
}

/** Types the config in the editor; it returns what it is given. */
export const defineCli = (config: CliConfig): CliConfig => config

const word = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "lower-case letters and digits, words joined by one dash"),
)

// A query parameter with such a word in its name holds a secret, which the URL would put into a committed file. Whole
// words, so `design` or `keyword` stay allowed.
const SECRET_WORDS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "sig",
  "signature",
  "auth",
  "password",
  "pass",
  "passwd",
  "credential",
  "credentials",
  "session",
  "sessionid",
  "jwt",
  "code",
])
const secretName = (name: string) =>
  name.split(/[_\-.]+|(?<=[a-z0-9])(?=[A-Z])/).some((part) => SECRET_WORDS.has(part.toLowerCase()))

const urlOf = (text: string) => (URL.canParse(text) ? new URL(text) : undefined)

/** An https URL that can be committed: a host, no spaces, no user name or password, no secret in its query. */
const httpsUrl = v.pipe(
  v.string(),
  v.check((text) => !/\s/.test(text), "an https URL without spaces"),
  v.check((text) => {
    const url = urlOf(text)
    return url?.protocol === "https:" && url.hostname.length > 0
  }, "a valid https URL with a host"),
  v.check((text) => {
    const url = urlOf(text)
    return !url?.username && !url?.password
  }, "an https URL without a user name or password, which would be committed"),
  v.check(
    (text) => ![...(urlOf(text)?.searchParams.keys() ?? [])].some(secretName),
    "an https URL without a key or token in its query, which would be committed",
  ),
  // A token handed back in the fragment (OAuth's implicit flow) would be committed too; a description needs none.
  v.check((text) => !urlOf(text)?.hash, "an https URL without a #fragment"),
)

const dotPath = v.pipe(v.string(), v.regex(/^[^.\s]+(\.[^.\s]+)*$/, "a dot path into the answer, such as data.id"))

const verify = v.optional(
  v.strictObject({
    operation: v.pipe(v.string(), v.minLength(1)),
    id: dotPath,
    name: v.optional(dotPath),
    active: v.optional(dotPath),
  }),
)

const schema = v.strictObject({
  identity: v.strictObject({
    command: word,
    package: v.pipe(v.string(), v.regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "an npm package name")),
    prefix: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/, "upper-case letters, digits and underscores")),
    service: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/, "a GitHub owner")),
  }),
  spec: v.strictObject({
    kind: v.picklist(["openapi", "swagger", "graphql", "wp-json"]),
    from: httpsUrl,
    version: v.optional(v.pipe(v.string(), v.regex(/^\d+\.\d+(\.\d+)?$/, "a version such as 6.9.4"))),
  }),
  auth: v.variant("preset", [
    v.strictObject({ preset: v.literal("none") }),
    v.strictObject({ preset: v.literal("token"), verify }),
    v.strictObject({ preset: v.literal("app-password"), verify }),
    v.strictObject({
      preset: v.literal("oauth2-pkce"),
      verify,
      scopes: v.array(v.string()),
      scheme: v.optional(v.string()),
      revokeUrl: v.optional(httpsUrl),
      authorizeParams: v.optional(v.record(v.string(), v.string())),
      rotating: v.optional(v.boolean()),
      redirect: v.optional(
        v.variant("kind", [
          v.strictObject({ kind: v.literal("loopback"), host: v.optional(v.literal("localhost")) }),
          v.strictObject({ kind: v.literal("relay"), url: httpsUrl }),
        ]),
      ),
    }),
  ]),
  category: v.picklist(CLI_CATEGORIES),
  source: v.optional(v.looseObject({})),
  hooks: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\.\/([^\s]*\/)?[^/\s.][^/\s]*\.[cm]?[jt]s$/, "a module in the project, such as ./src/hooks.ts"),
      v.check((text) => !/\.d\.[cm]?ts$/.test(text), "a module, not a .d.ts declaration file"),
      v.check((text) => !text.split(/[\\/]/).includes(".."), "a module in the project, without .."),
    ),
  ),
})

/**
 * The config checked against its shape; every error names where it is. A crm, tracker or content CLI needs its source. `source` comes back
 * unchecked: `parseCrmManifest` checks it against the generated API.
 */
export const parseCliConfig = (input: unknown): CliConfig => {
  const parsed = v.safeParse(schema, input)
  if (!parsed.success) {
    const [issue] = parsed.issues
    // valibot's own words for a key: "Invalid key: Expected never but received …". By the issue's shape, so a value
    // that is undefined inside a list or record keeps valibot's words.
    const keyed = issue.type === "strict_object" || issue.type === "variant"
    const message =
      keyed && issue.expected === "never"
        ? "not a field of wirecat.config"
        : keyed && issue.input === undefined
          ? "missing"
          : issue.message
    throw new CliError("configuration_error", `wirecat.config: ${v.getDotPath(issue) ?? "(root)"}: ${message}`, {
      reason: "manifest.invalid",
    })
  }
  // Typed, not cast: a field CliConfig needs that the schema lacks or types otherwise fails to compile (not the reverse).
  const output: Omit<CliConfig, "source"> & { source?: Readonly<Record<string, unknown>> } = parsed.output
  const config = output as CliConfig
  const sourced = config.category === "crm" || config.category === "tracker" || config.category === "content"
  if (!sourced && config.source)
    throw new CliError(
      "configuration_error",
      "wirecat.config: source: only a crm, tracker or content CLI reads a source yet",
      {
        reason: "manifest.invalid",
      },
    )
  if (sourced && !config.source)
    throw new CliError("configuration_error", `wirecat.config: source: a ${config.category} CLI needs its source`, {
      reason: "manifest.invalid",
    })
  return config
}
