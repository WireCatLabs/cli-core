import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import { MIGRATIONS } from "../migrations.js"
import { refusalAdvice, storeClients } from "./clients.js"

export const assertReadCompatible = (database: CacheDatabase, command?: string): void => {
  const ours = MIGRATIONS.at(-1)?.version ?? 0
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get())
    throw new CliError(
      "configuration_error",
      "The store has no schema history; initialize it explicitly before a read-only open",
    )
  const row = database
    .prepare("SELECT version,min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get()
  const version = Number(row?.version),
    minCompatible = Number(row?.min_compatible)
  if (
    !Number.isSafeInteger(version) ||
    !Number.isSafeInteger(minCompatible) ||
    version < 1 ||
    minCompatible < 1 ||
    minCompatible > version
  )
    throw new CliError("configuration_error", "The store schema history is invalid; read-only opening cannot repair it")
  if (version < ours)
    throw new CliError(
      "configuration_error",
      `The store needs schema ${ours} maintenance before a read-only open (found ${version})`,
    )
  if (minCompatible > ours)
    throw new CliError(
      "configuration_error",
      `The store requires schema ${minCompatible}, but this tool supports ${ours}; ${refusalAdvice(storeClients(database), command, version)}`,
    )
}
