import { BASE_CONSTANTS, baseConstantsSchema, CliError, loadConstants } from "@wirecat/cli-base"
import * as v from "valibot"
import { readClientFile } from "../oauth/client-file.js"
import type { OAuthClient } from "../oauth/provider.js"
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

export type AppSource = "file" | "env" | "wirecat"

export interface GoogleAppOptions {
  env: NodeJS.ProcessEnv
  /** The tool's environment prefix: `GCAL` reads `GCAL_GOOGLE_CLIENT_ID` and `GCAL_GOOGLE_CLIENT_SECRET`. */
  prefix: string
  /** The owner's Desktop client JSON, `--client-file`; it must be private to the owner. */
  clientFile?: string | undefined
  platform?: NodeJS.Platform
  /** The tool's own constants, when its layer overrides the app. */
  constants?: Constants
}

/**
 * The Google Desktop app a sign-in uses: the owner's `--client-file`, else `<PREFIX>_GOOGLE_CLIENT_ID` (with an
 * optional `_SECRET`), else WireCat's app. Google treats a Desktop app's secret as public
 * (https://developers.google.com/identity/protocols/oauth2/native-app), so WireCat's ships, obscured, in cli-core's
 * constants.
 */
export const googleApp = (options: GoogleAppOptions): { client: OAuthClient; source: AppSource } => {
  const { env, prefix, clientFile, platform } = options
  if (clientFile) return { client: readClientFile(clientFile, platform ? { platform } : {}), source: "file" }

  const clientId = env[`${prefix}_GOOGLE_CLIENT_ID`]
  const clientSecret = env[`${prefix}_GOOGLE_CLIENT_SECRET`]
  if (clientId) return { client: { clientId, ...(clientSecret ? { clientSecret } : {}) }, source: "env" }
  if (clientSecret)
    throw new CliError(
      "configuration_error",
      `${prefix}_GOOGLE_CLIENT_SECRET is set without ${prefix}_GOOGLE_CLIENT_ID; set both, or neither to use WireCat's app`,
      { reason: "sign-in.secret-without-id" },
    )

  const { client_id, client_secret } = (options.constants ?? constants()).google.app
  return {
    client: { clientId: client_id, ...(client_secret ? { clientSecret: client_secret } : {}) },
    source: "wirecat",
  }
}
