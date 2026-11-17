import { isAbsolute } from "node:path"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { CrmManifest } from "../crm/manifest/manifest.js"
import type { OAuthProvider } from "../oauth/provider.js"

export type CliAuth =
  | { preset: "none" }
  /** A token or key, sent where the spec's `securitySchemes` say: a bearer header, an API key header or query. */
  | { preset: "token" }
  /** The browser sign-in the spec's authorization code flow declares; the redirect is what the app registered. */
  | {
      preset: "oauth2-pkce"
      scopes: readonly string[]
      scheme?: string
      redirect?: OAuthProvider["redirect"]
      revokeUrl?: string
      authorizeParams?: Record<string, string>
      /** The provider sends a new refresh token on each refresh; the spec cannot say so. */
      rotating?: boolean
    }

export const CLI_CATEGORIES = ["messenger", "mail", "notes", "files", "meetings", "calendar", "crm", "other"] as const
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
  /** `from`: the https URL the description is published at. */
  spec: { kind: "openapi" | "swagger"; from: string }
  auth: CliAuth
  /** cli-template's `--category`; `other` is any API outside them. */
  category: CliCategory
  /** The CRM source; checked against the generated API by `parseCrmManifest` once the api group exists. */
  source?: CrmManifest
  /** The module of named hooks, relative to the config: `./src/hooks.ts`. */
  hooks?: string
}

/** Types the config in the editor; it returns what it is given. */
export const defineCli = (config: CliConfig): CliConfig => config

const word = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "lower-case letters and digits, words joined by one dash"),
)

/** In the project: no absolute path, no `..`, no scheme. */
const projectPath = (text: string) =>
  !isAbsolute(text) && !text.split(/[\\/]/).includes("..") && !/^[a-z][a-z0-9+.-]*:/i.test(text)

const schema = v.strictObject({
  identity: v.strictObject({
    command: word,
    package: v.pipe(v.string(), v.regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "an npm package name")),
    prefix: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/, "upper-case letters, digits and underscores")),
    service: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/, "a GitHub owner")),
  }),
  spec: v.strictObject({
    kind: v.picklist(["openapi", "swagger"]),
    from: v.pipe(
      v.string(),
      v.check((text) => /^https:\/\/[^/\s]+/.test(text), "the https URL the description is published at"),
    ),
  }),
  auth: v.variant("preset", [
    v.strictObject({ preset: v.literal("none") }),
    v.strictObject({ preset: v.literal("token") }),
    v.strictObject({
      preset: v.literal("oauth2-pkce"),
      scopes: v.array(v.string()),
      scheme: v.optional(v.string()),
      revokeUrl: v.optional(v.pipe(v.string(), v.startsWith("https://"))),
      authorizeParams: v.optional(v.record(v.string(), v.string())),
      rotating: v.optional(v.boolean()),
      redirect: v.optional(
        v.variant("kind", [
          v.strictObject({ kind: v.literal("loopback"), host: v.optional(v.literal("localhost")) }),
          v.strictObject({ kind: v.literal("relay"), url: v.pipe(v.string(), v.startsWith("https://")) }),
        ]),
      ),
    }),
  ]),
  category: v.picklist(CLI_CATEGORIES),
  source: v.optional(v.looseObject({})),
  hooks: v.optional(v.pipe(v.string(), v.startsWith("./"), v.check(projectPath, "a module in the project"))),
})

/** The config checked against its shape; every error names where it is. A CRM CLI needs its source. */
export const parseCliConfig = (input: unknown): CliConfig => {
  const parsed = v.safeParse(schema, input)
  if (!parsed.success) {
    const [issue] = parsed.issues
    throw new CliError("configuration_error", `wirecat.config: ${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`, {
      reason: "manifest.invalid",
    })
  }
  const config = parsed.output as CliConfig
  if (config.category !== "crm" && config.source)
    throw new CliError("configuration_error", "wirecat.config: source: only a crm CLI reads a source yet", {
      reason: "manifest.invalid",
    })
  if (config.category === "crm" && !config.source)
    throw new CliError("configuration_error", "wirecat.config: source: a crm CLI needs its source", {
      reason: "manifest.invalid",
    })
  return config
}
