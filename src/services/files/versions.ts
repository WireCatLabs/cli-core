import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs"
import { readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { replaceLocal } from "../documents/push.js"

/** Which way a sync moved a change. */
export type VersionDirection = "local-to-remote" | "remote-to-local" | "restored"

/** One line of a mirror's version log: what a sync did to a path, with the content's hash before and after. */
export interface VersionEvent {
  at: string
  path: string
  event: "created" | "changed" | "deleted" | "renamed"
  direction: VersionDirection
  /** The content the change replaced: the local file kept before a pull or deletion, the remote version an upload replaced. */
  old?: string
  new?: string
  size?: number
  /** A rename's new path. */
  to?: string
}

/** A version of a path, and whether its bytes are still in the store. */
export interface FileVersion extends VersionEvent {
  available: boolean
}

export interface FileVersions {
  /** Copies the file into the store before the sync overwrites or deletes it; returns the hash of what it copied. */
  keep(absolute: string): Promise<string>
  log(event: Omit<VersionEvent, "at">): void
  /** Every event of `path`, oldest first, including renames to or from it. */
  list(path: string): FileVersion[]
  /**
   * Writes a kept version to `into`, replacing the file only while it has `over`, or creating it when `over` is
   * undefined. False when the store no longer has the version or the file was not as `over` said.
   */
  write(sha256: string, into: string, over?: string): Promise<boolean>
  /** Applies the retention rule; see `fileVersions`. */
  prune(): Promise<void>
}

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A mirror's local version store: `<dir>/objects/<sha256>` holds each kept content once, `<dir>/log.jsonl` is
 * append-only. The store lives under the profile's state folder, never inside the mirrored folder. Retention, one
 * rule: a content stays while an event newer than 30 days names it, and the last content of a path whose newest
 * event is a deletion stays for good.
 */
export const fileVersions = (dir: string, now: () => number = Date.now): FileVersions => {
  const objects = join(dir, "objects")
  const logPath = join(dir, "log.jsonl")
  const events = (): VersionEvent[] => {
    try {
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as VersionEvent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }
  const has = (sha256: string) => existsSync(join(objects, sha256))
  return {
    keep: async (absolute) => {
      mkdirSync(objects, { recursive: true, mode: 0o700 })
      const temp = join(objects, `.${randomUUID()}.tmp`)
      const hash = createHash("sha256")
      try {
        // Hashed while copied: the file may change under the sync, and the store is keyed by what it really holds.
        await pipeline(
          createReadStream(absolute),
          new Transform({
            transform(chunk, _encoding, done) {
              hash.update(chunk)
              done(null, chunk)
            },
          }),
          createWriteStream(temp, { flags: "wx", mode: 0o600 }),
        )
        const sha256 = hash.digest("hex")
        if (!has(sha256)) await rename(temp, join(objects, sha256))
        return sha256
      } finally {
        await rm(temp, { force: true })
      }
    },
    log: (event) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(logPath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...event })}\n`, { mode: 0o600 })
    },
    list: (path) => {
      const found = events().filter((event) => event.path === path || event.to === path)
      return found.map((event) => ({
        ...event,
        available: event.old !== undefined && existsSync(join(objects, event.old)),
      }))
    },
    write: async (sha256, into, over) => {
      if (!has(sha256)) return false
      const copy = (temp: string) =>
        pipeline(createReadStream(join(objects, sha256)), createWriteStream(temp, { flags: "wx" }))
      return (await replaceLocal(into, over, copy, { sha256 })) !== undefined
    },
    prune: async () => {
      const all = events()
      const keep = new Set<string>()
      const last = new Map<string, VersionEvent>()
      for (const event of all) {
        last.set(event.path, event)
        if (Date.parse(event.at) > now() - RETAIN_MS)
          for (const hash of [event.old, event.new]) if (hash) keep.add(hash)
      }
      for (const event of last.values()) if (event.event === "deleted" && event.old) keep.add(event.old)
      let names: string[]
      try {
        names = await readdir(objects)
      } catch {
        return
      }
      for (const name of names)
        if (!name.startsWith(".") && !keep.has(name)) await rm(join(objects, name), { force: true })
    },
  }
}

/**
 * Puts a kept version of `path` back into the mirrored folder; the file there now is kept first. The next sync sends
 * it like any local change. False when the store no longer has the version or the file changed meanwhile.
 */
export const restoreFileVersion = async (root: string, path: string, sha256: string, versions: FileVersions) => {
  const absolute = join(root, path)
  const current = existsSync(absolute) ? await versions.keep(absolute) : undefined
  if (current === sha256) return true
  if (!(await versions.write(sha256, absolute, current))) return false
  versions.log({
    path,
    event: current ? "changed" : "created",
    direction: "restored",
    ...(current ? { old: current } : {}),
    new: sha256,
  })
  return true
}
