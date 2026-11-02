import { userInfo } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"

/** The folder the CLIs share: the store, its backups and the models. `WIRECAT_STATE_DIR` moves all of it. */
export const wirecatDirectory = (env: NodeJS.ProcessEnv = process.env, platform?: NodeJS.Platform): string =>
  resolvePaths({ appName: "WireCat", prefix: "WIRECAT", env, ...(platform ? { platform } : {}) }).state

/**
 * One file for every messenger and account. `MESSAGING_STORE` is read here and nowhere else: the
 * test sandbox and `bin/tg` point it away from the owner's real file. Not `messages.db`, the file of the schema
 * before this one: a build still installed would open that name and run its own migrations over these tables.
 */
export const storePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.MESSAGING_STORE ?? join(wirecatDirectory(env), "wirecat.db")

// The account's home from the user database, not HOME: the test sandbox moves HOME, and a worker thread's
// `os.homedir()` still answers the real one (the 2026-10-18 leak).
const accountHome = (): string | undefined => {
  try {
    return userInfo().homedir
  } catch {
    return undefined
  }
}

/** Throws when a test is about to open a file in the owner's real WireCat folder. */
export const refuseOwnerStoreInTests = (
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string | undefined = accountHome(),
): void => {
  if (!env.VITEST || !home || file === ":memory:") return
  const inside = relative(wirecatDirectory({ HOME: home, USERPROFILE: home }), resolve(file))
  if (inside.startsWith("..") || isAbsolute(inside)) return
  throw new Error(
    `a test tried to open ${file}, in the owner's real WireCat folder; give it a MESSAGING_STORE or HOME of its own`,
  )
}
