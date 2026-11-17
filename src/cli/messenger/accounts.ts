import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { Provider } from "../../domain/models.js"
import type { AppIdentity } from "../../ports/app.js"
import type { AccountKey } from "../../store/store.js"

/** Which account a profile is, remembered so `--offline` can find its rows without connecting. */
export const accountFileFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "accounts", `${profile}.json`)

export const rememberAccount = (app: AppIdentity, profile: string, id: string, env: NodeJS.ProcessEnv): void =>
  writeSecurely(accountFileFor(app, profile, env), `${JSON.stringify({ account: id })}\n`, 0o600)

export const recalledAccount = (
  app: AppIdentity,
  provider: Provider,
  profile: string,
  env: NodeJS.ProcessEnv,
): AccountKey | undefined => {
  try {
    const { account } = JSON.parse(readFileSync(accountFileFor(app, profile, env), "utf8")) as { account?: unknown }
    return typeof account === "string" ? { provider, account } : undefined
  } catch {
    return undefined
  }
}

/** Profiles somebody has logged in to, whether or not the configuration file names them. */
export const profilesWithAccounts = (app: AppIdentity, env: NodeJS.ProcessEnv): string[] => {
  const dir = join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "accounts")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
}

/** The profiles on this computer, as `account list` shows them: named in the configuration file, or logged in to. */
export const profilesHere = (app: AppIdentity, configured: readonly string[], env: NodeJS.ProcessEnv): string[] =>
  [...new Set([...configured, ...profilesWithAccounts(app, env)])].sort()
