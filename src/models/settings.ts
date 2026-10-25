import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { endpoint } from "./endpoint.js"
import type { ModelTarget } from "./types.js"

export const MODEL_FIELDS = ["provider", "model", "base_url"] as const
export const modelSettingsShape = v.record(
  v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/)),
  v.strictObject({
    provider: v.optional(v.picklist(["off", "openai", "anthropic"])),
    model: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
    base_url: v.optional(
      v.pipe(
        v.string(),
        v.check((value) => endpoint(value), "use an HTTP/S endpoint without credentials, query or fragment"),
      ),
    ),
  }),
)

export type ModelSettings = v.InferOutput<typeof modelSettingsShape>

export const resolveModelSettings = (
  prefix: string,
  layers: readonly (readonly [string, Readonly<Record<string, unknown>> | undefined])[],
  env: NodeJS.ProcessEnv,
): { models: ModelSettings; sources: Record<string, string> } => {
  const configured = layers.map(([from, scope]) => [from, (scope?.models ?? {}) as ModelSettings] as const)
  const purposes = new Set([
    "default",
    "analysis",
    "replies",
    ...configured.flatMap(([, models]) => Object.keys(models)),
  ])
  for (const name of Object.keys(env)) {
    const match = new RegExp(`^${prefix}_MODELS_([A-Z][A-Z0-9_]*)_(PROVIDER|MODEL|BASE_URL)$`).exec(name)
    if (match?.[1]) purposes.add(match[1].toLowerCase().replaceAll("_", "-"))
  }
  const models: ModelSettings = {}
  const sources: Record<string, string> = {}
  for (const purpose of purposes) {
    const resolved: Record<string, unknown> = {}
    for (const field of MODEL_FIELDS) {
      const variable = `${prefix}_MODELS_${purpose.replaceAll("-", "_").toUpperCase()}_${field.toUpperCase()}`
      const candidates: [string, unknown][] = [
        [variable, env[variable]?.trim() || undefined],
        ...configured.map(([from, model]): [string, unknown] => [
          `${from}: models.${purpose}.${field}`,
          model[purpose]?.[field],
        ]),
        ...(purpose === "default"
          ? []
          : [
              [
                `${prefix}_MODELS_DEFAULT_${field.toUpperCase()}`,
                env[`${prefix}_MODELS_DEFAULT_${field.toUpperCase()}`]?.trim() || undefined,
              ] as [string, unknown],
              ...configured.map(([from, model]): [string, unknown] => [
                `${from}: models.default.${field}`,
                model.default?.[field],
              ]),
            ]),
      ]
      const selected = candidates.find(([, value]) => value !== undefined)
      if (selected) resolved[field] = selected[1]
      sources[`models.${purpose}.${field}`] = selected?.[0] ?? "default"
    }
    if (Object.keys(resolved).length) models[purpose] = resolved
  }
  const checked = v.safeParse(modelSettingsShape, models)
  if (!checked.success)
    throw new CliError("configuration_error", `models.${v.getDotPath(checked.issues[0]) ?? "settings"} is invalid`)
  return { models: checked.output, sources }
}

export const modelTarget = (settings: { models?: ModelSettings }, purpose: string): ModelTarget | undefined => {
  const configured = { ...settings.models?.default, ...settings.models?.[purpose] }
  if (configured.provider === undefined || configured.provider === "off") return undefined
  if (!configured.model)
    throw new CliError("configuration_error", `set models.${purpose}.model before calling its provider`)
  return {
    provider: configured.provider,
    model: configured.model,
    ...(configured.base_url === undefined ? {} : { baseUrl: configured.base_url }),
  }
}
