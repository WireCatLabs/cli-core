import { BASE_CONSTANTS, baseConstantsSchema, CliError, loadConstants } from "@wirecat/cli-base"
import * as v from "valibot"
import { readClientFile } from "../oauth/client-file.js"
import type { AppSource, OAuthClient } from "../oauth/provider.js"
import { reveal } from "./obscure.js"

/** cli-core's layer, read after cli-base's and before the tool's. */
export const CORE_CONSTANTS = new URL("../../constants.json", import.meta.url)

/** What cli-base's and cli-core's layers hold; a tool extends it with `v.object({ ...constantsSchema.entries, … })`. */
export const constantsSchema = v.object({
  ...baseConstantsSchema.entries,
  google: v.object({
    app: v.object({
      client_id: v.pipe(v.string(), v.nonEmpty(), v.transform(reveal)),
      client_secret: v.optional(v.pipe(v.string(), v.transform(reveal))),
    }),
  }),
  microsoft: v.object({ app: v.object({ client_id: v.pipe(v.string(), v.nonEmpty()) }) }),
})

export type Constants = v.InferOutput<typeof constantsSchema>

const loaded = new Map<string, unknown>()

/**
 * The packaged constants, base → core → the tool's `constants.json` when given, read once per process for each tool
 * layer. A tool with constants of its own passes its layer and a schema built on `constantsSchema`; the first call for
 * a layer decides its schema.
 */
export const constants = <TSchema extends v.GenericSchema<unknown, Constants> = typeof constantsSchema>(
  toolLayer?: URL,
  schema?: TSchema,
): v.InferOutput<TSchema> => {
  const key = toolLayer?.href ?? ""
  if (!loaded.has(key)) {
    const layers = toolLayer ? [BASE_CONSTANTS, CORE_CONSTANTS, toolLayer] : [BASE_CONSTANTS, CORE_CONSTANTS]
    loaded.set(key, loadConstants(layers, schema ?? constantsSchema))
  }
  return loaded.get(key) as v.InferOutput<TSchema>
}

export interface AppOptions {
  env: NodeJS.ProcessEnv
  /** The tool's environment prefix: `GCAL` with provider `google` reads `GCAL_GOOGLE_CLIENT_ID` and `_SECRET`. */
  prefix: string
  /** `--client-id`. A secret for it comes from `<PREFIX>_<PROVIDER>_CLIENT_SECRET`. */
  clientId?: string | undefined
  /** The account's config key `<provider>.client_id`. A config file never holds the secret: it comes from the env. */
  configClientId?: string | undefined
}

export interface OAuthAppOptions extends AppOptions {
  /** `google`, `microsoft`, `zoom`: names the env variables, upper-cased. */
  provider: string
  /** WireCat's app from the constants; an empty or missing id means WireCat has none for this provider. */
  wirecat?: { client_id?: string | undefined; client_secret?: string | undefined } | undefined
}

export interface OAuthApp {
  client: OAuthClient & { source: AppSource }
  source: AppSource
}

/**
 * The app a sign-in uses, first match wins (WC-SECR-25): `--client-id`, `<PREFIX>_<PROVIDER>_CLIENT_ID`, the account's
 * `<provider>.client_id`, WireCat's app. A secret without any of the first three ids is a `configuration_error`.
 * Undefined when nothing names an app and WireCat has none.
 */
export const oauthApp = (options: OAuthAppOptions): OAuthApp | undefined => {
  const { env, prefix, provider } = options
  const name = `${prefix}_${provider.toUpperCase()}_CLIENT`
  const clientSecret = env[`${name}_SECRET`]
  const own: [string | undefined, AppSource][] = [
    [options.clientId, "flag"],
    [env[`${name}_ID`], "env"],
    [options.configClientId, "config"],
  ]
  const [clientId, source] = own.find(([id]) => id) ?? []
  if (clientId && source) return app({ clientId, ...(clientSecret ? { clientSecret } : {}) }, source)
  if (clientSecret)
    throw new CliError(
      "configuration_error",
      `${name}_SECRET is set without a client id; set ${name}_ID too, or unset it to use WireCat's app`,
      { reason: "sign-in.secret-without-id" },
    )
  const wirecat = options.wirecat
  if (!wirecat?.client_id) return undefined
  return app(
    { clientId: wirecat.client_id, ...(wirecat.client_secret ? { clientSecret: wirecat.client_secret } : {}) },
    "constants",
  )
}

const app = (client: OAuthClient, source: AppSource): OAuthApp => ({ client: { ...client, source }, source })

export interface GoogleAppOptions extends AppOptions {
  /** The owner's Desktop client JSON, `--client-file`; it must be private to the owner. */
  clientFile?: string | undefined
  platform?: NodeJS.Platform
  /** The tool's own constants, when its layer overrides the app. */
  constants?: Constants
}

/**
 * The Google Desktop app a sign-in uses: `--client-file`, then `oauthApp`'s order. Google treats a Desktop app's
 * secret as public (https://developers.google.com/identity/protocols/oauth2/native-app), so WireCat's ships, obscured,
 * in cli-core's constants.
 */
export const googleApp = (options: GoogleAppOptions): OAuthApp => {
  const { clientFile, platform } = options
  if (clientFile) return app(readClientFile(clientFile, platform ? { platform } : {}), "flag")
  const wirecat = (options.constants ?? constants()).google.app
  return oauthApp({ ...options, provider: "google", wirecat }) as OAuthApp
}

/** WireCat's Microsoft app is a public client: it has an id and no secret. */
export const microsoftApp = (options: AppOptions & { constants?: Constants }): OAuthApp => {
  const wirecat = (options.constants ?? constants()).microsoft.app
  return oauthApp({ ...options, provider: "microsoft", wirecat }) as OAuthApp
}

export interface OAuthClientReport {
  client: "wirecat" | "own" | null
  source: AppSource | null
  /** Why there is no app, when `client` is null. */
  reason?: string
}

/** `doctor`'s `oauth_client` for one provider: the app a new sign-in would use; doctor reads no keyring. */
export const oauthClientReport = (
  app: { source?: AppSource | undefined } | undefined,
  reason?: string,
): OAuthClientReport =>
  app?.source
    ? { client: app.source === "constants" ? "wirecat" : "own", source: app.source }
    : { client: null, source: null, ...(reason ? { reason } : {}) }

export type { AppSource }

/**
 * The hosts cli-core itself reaches in any tool: the default model providers, then cli-base's `SHARED_HOSTS` (npm for
 * `upgrade`, the model downloads and the hosts they redirect to), which `cli-dev manifest` adds to every CLI's hosts.
 * Typed out, not imported, so a CLI on an older cli-base still loads this module; a test keeps the two equal. A model
 * endpoint or calendar feed the person configures belongs in `userHosts`.
 */
export const CORE_HOSTS: readonly string[] = [
  "api.openai.com",
  "api.anthropic.com",
  "registry.npmjs.org",
  "huggingface.co",
  "*.huggingface.co",
  "*.hf.co",
  "github.com",
  "*.githubusercontent.com",
]
