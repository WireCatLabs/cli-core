import { readFileSync } from "node:fs"
import { configFilePath, resolvePaths } from "@wirecat/cli-base"
import { type AppIdentity, envName } from "./app.js"
import { byteCount, DEFAULT_OUTPUT_BYTES } from "./execution.js"
import type { GlobalFlags, ResolveOptions } from "./settings.js"

/** Output control must also work for discovery and commands that repair an invalid config. */
export const outputBudget = (
  app: AppIdentity,
  flags: GlobalFlags,
  options: ResolveOptions & { configuration?: boolean },
): number => {
  if (flags.maxOutputBytes !== undefined) return byteCount(String(flags.maxOutputBytes), "--max-output-bytes", true)
  const env = options.env ?? process.env
  const environmentKey = envName(app, "MAX_OUTPUT_BYTES")
  const environment = env[environmentKey]?.trim()
  if (environment) return byteCount(environment, environmentKey, true)
  if (options.configuration === false) return DEFAULT_OUTPUT_BYTES
  let config: Record<string, unknown>
  try {
    config = object(
      JSON.parse(
        readFileSync(
          configFilePath(
            options.configDir ?? resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config,
          ),
          "utf8",
        ),
      ),
    )
  } catch {
    return DEFAULT_OUTPUT_BYTES
  }
  const profile = flags.profile ?? env[envName(app, "PROFILE")] ?? config.defaultProfile
  const kind = object(config[options.kind ?? "personal"])
  const layers = [
    object(object(kind.profiles)[String(profile)]),
    object(object(config.profiles)[String(profile)]),
    object(kind.defaults),
    object(config.defaults),
  ]
  for (const layer of layers) {
    if (layer.maxOutputBytes === undefined) continue
    return byteCount(String(layer.maxOutputBytes), "maxOutputBytes", true)
  }
  return DEFAULT_OUTPUT_BYTES
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
