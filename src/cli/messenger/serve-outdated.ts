import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileSchemaOf, SPEAKS, writableBy } from "../../store/compatibility.js"
import { openSqlite } from "../../store/store.js"

export const OUTDATED_CHECK_MS = 60_000

/** The folder of the package this process was started from, when its `package.json` still names `running`. */
export const ownPackageRoot = (running: string, script = process.argv[1]): string | undefined => {
  let dir: string
  try {
    dir = dirname(realpathSync(script ?? ""))
  } catch {
    return undefined
  }
  for (let up = 0; up < 8; up++) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) return installedVersion(dir) === running ? dir : undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

const installedVersion = (root: string): string | undefined => {
  try {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
}

const newer = (one: string, other: string): boolean => {
  const parts = (version: string) => version.split(/[.+-]/, 3).map(Number)
  const [a, b] = [parts(one), parts(other)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/**
 * Why this serve should stop so its unit starts the installed build (BUG-643): the store moved past what this build
 * may write, or a newer version was installed over it. A store that cannot be read now is not a reason.
 */
export const outdatedReason = async ({
  command,
  running,
  storePath,
  packageRoot,
  speaks = SPEAKS,
}: {
  command: string
  running: string
  storePath: string
  packageRoot?: string | undefined
  speaks?: number
}): Promise<string | undefined> => {
  const installed = packageRoot === undefined ? undefined : installedVersion(packageRoot)
  if (installed !== undefined && newer(installed, running))
    return `${command} ${installed} is installed and this serve runs ${running}: stopping so it starts again on ${installed}`
  if (!existsSync(storePath)) return undefined
  let schema: ReturnType<typeof fileSchemaOf>
  try {
    const { database } = await openSqlite(storePath, { readOnly: true })
    try {
      schema = fileSchemaOf(database)
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
  if (writableBy(schema, speaks)) return undefined
  return (
    `the store is at format ${schema.version} and needs at least ${schema.minCompatible}; this serve (${command} ` +
    `${running}) speaks ${speaks} and can no longer write it: stopping — \`${command} upgrade\` if it does not start ` +
    "again on a newer version"
  )
}

/** Runs `check` every `everyMs` and calls `onOutdated` once with its first reason. */
export const watchOutdated = ({
  check,
  onOutdated,
  everyMs = OUTDATED_CHECK_MS,
}: {
  check: () => Promise<string | undefined>
  onOutdated: (reason: string) => void
  everyMs?: number
}): { stop: () => void } => {
  let busy = false
  let done = false
  const timer = setInterval(() => {
    if (busy || done) return
    busy = true
    check()
      .then((reason) => {
        if (reason === undefined || done) return
        done = true
        clearInterval(timer)
        onOutdated(reason)
      })
      .catch(() => {})
      .finally(() => {
        busy = false
      })
  }, everyMs)
  timer.unref()
  return {
    stop: () => {
      done = true
      clearInterval(timer)
    },
  }
}
