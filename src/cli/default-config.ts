import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const DEFAULT_CONFIG = {
  defaults: { limit: 20, keep_runs_for_days: 30, sends_per_hour: 30, update_check: true, skill_hint: true },
  profiles: {},
}

/** Publish a complete starter file without replacing a concurrent first run or the owner's settings. */
export function ensureDefaultConfig(path: string): void {
  if (existsSync(path)) return
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = mkdtempSync(join(directory, ".config-"))
  const candidate = join(temporary, "config.json")
  try {
    writeFileSync(candidate, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    try {
      linkSync(candidate, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
