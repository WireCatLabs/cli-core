import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"

const musl = (): boolean => {
  if (process.platform !== "linux") return false
  try {
    return readFileSync("/proc/self/maps", "utf8").includes("ld-musl")
  } catch {
    return false
  }
}

let found: Promise<string> | undefined

/**
 * The sqlite-vec extension every store connection loads: the vector index's tables and triggers cannot be
 * read or written without it. It ships in `@wirecat/cli-core-sqlite`, so a missing file is a broken install.
 */
export const vectorExtension = (): Promise<string> => {
  found ??= locate()
  return found
}

const locate = async (): Promise<string> => {
  const onMusl = musl()
  const target = `${process.platform}-${process.arch}${onMusl ? "-musl" : ""}`
  let path: string | undefined
  try {
    const { extensionFor } = await import("@wirecat/cli-core-sqlite")
    path = extensionFor({ musl: onMusl })
  } catch {
    path = undefined
  }
  if (path === undefined) {
    found = undefined
    throw new CliError(
      "configuration_error",
      `the message store needs the sqlite-vec extension, and @wirecat/cli-core-sqlite has none for ${target} — ` +
        "reinstall the CLI so its dependencies install with it (an install that skips optional or native " +
        "packages leaves it out)",
      { reason: "store.vector-extension-missing", target },
    )
  }
  return path
}

/** Loads the extension into a connection that allows it, then closes the door for SQL's `load_extension()`. */
export const loadVectorExtension = (
  database: { loadExtension(path: string): void; enableLoadExtension?(allow: boolean): void },
  path: string,
): void => {
  try {
    database.loadExtension(path)
  } catch (error) {
    throw new CliError(
      "configuration_error",
      `the sqlite-vec extension did not load on ${process.platform}-${process.arch} — reinstall the CLI; on macOS ` +
        "under Bun, @wirecat/cli-core-sqlite's SQLite must be installed, since the system's cannot load extensions",
      { reason: "store.vector-extension-failed", cause: error instanceof Error ? error.message : String(error) },
    )
  } finally {
    database.enableLoadExtension?.(false)
  }
}
