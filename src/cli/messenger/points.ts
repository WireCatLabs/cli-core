import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { Id } from "../../domain/models.js"
import type { AppIdentity } from "../app.js"

interface Saved {
  /** Where a chat with no point of its own starts: the first check, or the one point older versions kept. */
  lastCheckAt?: string
  chats?: Record<string, string>
}

export interface CheckPoints {
  /** ms: where a chat never checked starts — the first check, which stays put. */
  first: number
  /** ms, per chat: where its next check starts. */
  chats: ReadonlyMap<Id, number>
  /** Moves the chats checked; the rest keep their point. */
  save(checked: Record<Id, string>): void
}

/**
 * Where `<command> --new` stopped, per chat and profile, beside the remembered account. `inbox` and
 * `review` keep a file each: sharing one, an `inbox` run would move `review` past what it never showed.
 * The MCP tools keep their own too, so an agent's run never moves the owner's `--new`.
 */
export const checkPoints = (
  app: AppIdentity,
  {
    command,
    profile,
    env,
    firstLookMs,
  }: {
    command: "inbox" | "review" | "mcp-inbox" | "mcp-review"
    profile: string
    env: NodeJS.ProcessEnv
    firstLookMs: number
  },
): CheckPoints => {
  const file = join(
    resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state,
    command,
    `${profile}.json`,
  )
  const saved = read(file)
  const first = saved.lastCheckAt ?? new Date(Date.now() - firstLookMs).toISOString()
  return {
    first: Date.parse(first),
    chats: new Map(Object.entries(saved.chats ?? {}).map(([chat, at]) => [chat, Date.parse(at)])),
    save: (checked) => {
      if (Object.keys(checked).length === 0) return
      const kept: Saved = { lastCheckAt: first, chats: { ...saved.chats, ...checked } }
      writeSecurely(file, `${JSON.stringify(kept)}\n`, 0o600)
    },
  }
}

const read = (file: string): Saved => {
  try {
    const { lastCheckAt, chats } = JSON.parse(readFileSync(file, "utf8")) as { lastCheckAt?: unknown; chats?: unknown }
    return {
      ...(typeof lastCheckAt === "string" ? { lastCheckAt } : {}),
      ...(chats !== null && typeof chats === "object"
        ? {
            chats: Object.fromEntries(
              Object.entries(chats).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            ),
          }
        : {}),
    }
  } catch {
    return {}
  }
}
