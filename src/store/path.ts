import { join } from "node:path"
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
