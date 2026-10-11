import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"

/**
 * One file for every messenger and account. `MESSAGING_STORE` is read here and nowhere else: the
 * test sandbox and `bin/tg` point it away from the owner's real file. Not `messages.db`, the file of the schema
 * before this one: a build still installed would open that name and run its own migrations over these tables.
 */
export const storePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.MESSAGING_STORE ?? join(resolvePaths({ appName: "cli-messaging", prefix: "MESSAGING", env }).state, "wirecat.db")
