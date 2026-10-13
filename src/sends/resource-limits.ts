import { CliError } from "@wirecat/cli-base"

export const DEFAULT_RESOURCE_LIMITS = {
  maxOutputBytes: 64 * 1024 * 1024,
  maxUploadBytes: 0,
  maxUploadTotalBytes: 0,
  maxBufferedUploadBytes: 256 * 1024 * 1024,
  uploadConcurrency: 4,
  maxSubscriberBufferBytes: 64 * 1024 * 1024,
  maxSubscriberTotalBufferBytes: 256 * 1024 * 1024,
} as const

export type ResourceLimitKey = keyof typeof DEFAULT_RESOURCE_LIMITS
export type ResourceLimits = { [K in ResourceLimitKey]: number }
export type ResourceLimitFlags = { [K in ResourceLimitKey]?: string | number }

export const resourceCount = (value: string | number, name: string, positive = false): number => {
  const count = Number(value)
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(count) || count < (positive ? 1 : 0))
    throw new CliError("validation_error", `${name} takes a ${positive ? "positive" : "non-negative"} whole count`)
  return count
}

export const resourceEnvironmentKey = (key: ResourceLimitKey): string =>
  key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()

export const resolveResourceLimits = (
  flags: ResourceLimitFlags,
  env: NodeJS.ProcessEnv,
  prefix: string,
  configured: (key: ResourceLimitKey, fallback: number) => { value: number; from: string },
): { values: ResourceLimits; sources: Record<string, string> } => {
  const values = {} as ResourceLimits
  const sources: Record<string, string> = {}
  for (const key of Object.keys(DEFAULT_RESOURCE_LIMITS) as ResourceLimitKey[]) {
    const environmentKey = `${prefix}_${resourceEnvironmentKey(key)}`
    const flag = flags[key]
    const environment = env[environmentKey]?.trim() || undefined
    const setting = configured(key, DEFAULT_RESOURCE_LIMITS[key])
    const raw = flag ?? environment ?? setting.value
    const from = flag !== undefined ? "flag" : environment !== undefined ? environmentKey : setting.from
    values[key] = resourceCount(raw, key, key === "uploadConcurrency")
    sources[key] = from
  }
  return { values, sources }
}

export const mapUploads = async <T, R>(
  files: readonly T[],
  concurrency: number,
  upload: (file: T, index: number) => Promise<R>,
): Promise<R[]> => {
  resourceCount(concurrency, "uploadConcurrency", true)
  const results = new Array<R>(files.length)
  let cursor = 0
  let failure: unknown
  let failed = false
  const worker = async () => {
    while (!failed && cursor < files.length) {
      const index = cursor++
      try {
        results[index] = await upload(files[index] as T, index)
      } catch (error) {
        failed = true
        failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  if (failed) throw failure
  return results
}
