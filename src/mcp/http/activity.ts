import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** What each logged-in app did last, keyed by its client id. Tool names and times only: never arguments. */
export interface ClientActivity {
  lastRequestAt: string
  lastTool?: string
  lastToolAt?: string
  /** The local day `toolCalls` counts, `YYYY-MM-DD`. */
  day: string
  toolCalls: number
}

export type Activity = Record<string, ClientActivity>

const WRITE_EVERY_MS = 2000
/** Any app may send any name; one that does not look like a tool's is not kept. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

export const httpActivityFile = (tokenFile: string) => `${tokenFile.replace(/\.json$/, "")}.activity.json`

export const localDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export const readActivity = (path: string): Activity => {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Activity) : {}
  } catch {
    return {}
  }
}

/** The names of the tools a JSON-RPC body calls; a batch may call several. */
export const calledTools = (body: unknown): string[] =>
  (Array.isArray(body) ? body : [body]).flatMap((message) => {
    if (!message || typeof message !== "object") return []
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } }
    const name = params?.name
    return method === "tools/call" && typeof name === "string" && TOOL_NAME.test(name) ? [name] : []
  })

/**
 * Keeps the activity file of one running server. A call is written at once, so status shows it while the owner
 * watches; other requests at most every two seconds. Its own file, not the token file: `mcp --revoke` rewrites that
 * from another process.
 */
export const activityRecorder = (path: string, now: () => number = Date.now) => {
  const activity = readActivity(path)
  let timer: NodeJS.Timeout | undefined
  const write = () => {
    timer = undefined
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
      writeFileSync(temporary, JSON.stringify(activity), { mode: 0o600, flag: "wx" })
      chmodSync(temporary, 0o600)
      renameSync(temporary, path)
    } catch {
      // Activity is a convenience for the owner; serving must not fail over it.
    }
  }
  return {
    record: (clientId: string, tools: string[]) => {
      const at = now()
      const iso = new Date(at).toISOString()
      const day = localDay(at)
      const before = activity[clientId]
      const counted = before?.day === day ? before.toolCalls : 0
      const last = tools.at(-1)
      activity[clientId] = {
        lastRequestAt: iso,
        day,
        toolCalls: counted + tools.length,
        ...(last
          ? { lastTool: last, lastToolAt: iso }
          : before?.lastTool
            ? { lastTool: before.lastTool, ...(before.lastToolAt ? { lastToolAt: before.lastToolAt } : {}) }
            : {}),
      }
      if (last) {
        clearTimeout(timer)
        write()
      } else if (!timer) {
        timer = setTimeout(write, WRITE_EVERY_MS)
        timer.unref()
      }
    },
    flush: () => {
      if (!timer) return
      clearTimeout(timer)
      write()
    },
  }
}
