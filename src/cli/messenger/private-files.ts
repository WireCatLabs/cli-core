import { existsSync, statSync } from "node:fs"

export interface ModeProblem {
  path: string
  mode: string
  want: string
  fix: string
}

export type PrivateFiles = { checked: false; reason: string } | { checked: true; ok: boolean; problems: ModeProblem[] }

const shellQuoted = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`

/**
 * Whether anybody but the owner can read these files or enter these folders. Only `stat`, never an
 * open: the session is among them. Read-only for the owner is fine, so only group and other bits count.
 */
export const privateFiles = (
  { files, dirs }: { files: string[]; dirs: string[] },
  platform: NodeJS.Platform = process.platform,
): PrivateFiles => {
  if (platform === "win32") return { checked: false, reason: "Windows has no Unix file modes" }
  const problems: ModeProblem[] = []
  // A folder where a file should be, or the reverse, is a problem of its own; a mode is no fix for it.
  const check = (path: string, want: number, folder: boolean) => {
    if (!existsSync(path)) return
    const stat = statSync(path)
    if (stat.isDirectory() !== folder) return
    const mode = stat.mode & 0o777
    if ((mode & 0o077) === 0) return
    const octal = (value: number) => `0${value.toString(8)}`
    problems.push({ path, mode: octal(mode), want: octal(want), fix: `chmod ${want.toString(8)} ${shellQuoted(path)}` })
  }
  for (const file of files) check(file, 0o600, false)
  for (const dir of dirs) check(dir, 0o700, true)
  return { checked: true, ok: problems.length === 0, problems }
}

/** A SQLite database in write-ahead mode keeps its newest pages beside it. */
export const withSqliteSidecars = (path: string): string[] => [path, `${path}-wal`, `${path}-shm`]
