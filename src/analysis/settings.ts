import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { endpoint } from "../models/endpoint.js"
import { modelSettingsShape, resolveModelSettings } from "../models/settings.js"

export { endpoint } from "../models/endpoint.js"

const model = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))
const url = v.pipe(v.string(), v.check(endpoint, "use an HTTP/S endpoint without credentials, query or fragment"))
const AI_FIELDS = {
  embeddingProvider: v.optional(v.picklist(["local", "openai"])),
  embeddingModel: v.optional(model),
  embeddingBaseUrl: v.optional(url),
  embeddingDims: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65536))),
  models: v.optional(modelSettingsShape),
}
const fileKey = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/** The AI settings as the config file names them, in snake_case; `AISettings` is what the code reads. */
export const AI_ENTRIES = Object.fromEntries(
  Object.entries(AI_FIELDS).map(([key, schema]) => [fileKey(key), schema]),
) as {
  embedding_provider: (typeof AI_FIELDS)["embeddingProvider"]
  embedding_model: (typeof AI_FIELDS)["embeddingModel"]
  embedding_base_url: (typeof AI_FIELDS)["embeddingBaseUrl"]
  embedding_dims: (typeof AI_FIELDS)["embeddingDims"]
  models: (typeof AI_FIELDS)["models"]
}
export type AISettings = v.InferOutput<v.ObjectSchema<typeof AI_FIELDS, undefined>>
export const AI_DEFAULTS: AISettings = { embeddingProvider: "local" }

export const AI_SETTING_KEYS = Object.keys(AI_FIELDS) as (keyof AISettings)[]

export const resolveAISettings = (
  prefix: string,
  layers: readonly (readonly [string, Readonly<Record<string, unknown>> | undefined])[],
  env: NodeJS.ProcessEnv,
): { values: AISettings; sources: Record<string, string> } => {
  const resolved = Object.entries(AI_FIELDS)
    .filter(([key]) => key !== "models")
    .map(([key, schema]) => {
      const variable = `${prefix}_${fileKey(key).toUpperCase()}`
      const raw = env[variable]?.trim() || undefined
      const candidates: [string, unknown][] = [
        [variable, raw === undefined ? undefined : key === "embeddingDims" ? Number(raw) : raw],
        ...layers.map(([from, scope]): [string, unknown] => [from, scope?.[fileKey(key)]]),
      ]
      const [from, value] = candidates.find(([, value]) => value !== undefined) ?? [
        "default",
        AI_DEFAULTS[key as keyof AISettings],
      ]
      const checked = v.safeParse(schema, value)
      if (!checked.success) throw new CliError("configuration_error", `${fileKey(key)} from ${from} is invalid`)
      return { key, value: checked.output, from }
    })
  const values = Object.fromEntries(resolved.map(({ key, value }) => [key, value])) as AISettings
  const sources = Object.fromEntries(resolved.map(({ key, from }) => [key, from]))
  const models = resolveModelSettings(prefix, layers, env)
  return {
    values: { ...values, models: models.models },
    sources: {
      ...sources,
      ...models.sources,
      models: Object.values(models.sources).some((source) => source !== "default") ? "resolved per purpose" : "default",
    },
  }
}
