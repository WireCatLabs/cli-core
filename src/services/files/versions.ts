import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises"
import { join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CliError } from "@wirecat/cli-base"
import { type HeldLock, heldCheck } from "../documents/mirrors.js"
import { assertNoLink, hashFile, replaceLocal, safePath } from "../documents/push.js"

/** Which way a sync moved a change; `both` is a merge or a conflict's resolution, written to both sides. */
export type VersionDirection = "local-to-remote" | "remote-to-local" | "restored" | "both"

/** The contents a merge, a conflict or its resolution worked from: the last sync's, and each side's. */
export interface VersionParts {
  base?: string
  local?: string
  remote?: string
}

/** One line of a mirror's version log: what a sync did to a path, with the content's hash before and after. */
export interface VersionEvent {
  at: string
  path: string
  /**
   * `merged`: both sides' changes merged into `new`. `conflict`: they could not be, and `parts` were kept. `resolved`:
   * the owner settled the conflict with `new`, as `resolution` says.
   */
  event: "created" | "changed" | "deleted" | "renamed" | "merged" | "conflict" | "resolved"
  direction: VersionDirection
  /** The content the change replaced: the local file kept before a pull or deletion, the remote version an upload replaced. */
  old?: string
  /** The side `old` was kept from. */
  from?: "local" | "remote"
  /** Where `old` is when the store does not hold it: a remote deletion leaves it in the provider's trash. */
  oldIn?: "remote-trash"
  new?: string
  size?: number
  /** A rename's new path. */
  to?: string
  /** A merge's, a conflict's or a resolution's contents; with `new`, kept for good. */
  parts?: VersionParts
  /** How the owner resolved a conflict: kept one side, both, or gave the final file. */
  resolution?: "local" | "remote" | "both" | "file"
}

/** Which content of a merge or a conflict a kept version is; `result` is the merge's or the resolution's. */
export type VersionRole = "base" | "local" | "remote" | "result"

/** A version of a path, and whether its bytes are still in the store. */
export interface FileVersion extends VersionEvent {
  available: boolean
  /** Each content of a merge, a conflict or a resolution, and whether the store still has it. */
  versions?: { role: VersionRole; sha256: string; available: boolean }[]
}

export interface FileVersions {
  /** The folder the store keeps its copies in, when it is on disk: a sync checks its free space first. */
  readonly dir?: string
  /**
   * Copies a content into the store before the sync overwrites or deletes it; returns the hash of what it copied. The
   * source is a local file, or a writer that creates the temporary file it is given, such as a target's `download`.
   * A failure of the store itself, the writer's local file-system errors (a full disk) included, is
   * `mirror.version-not-kept`; the writer's other errors pass through.
   */
  keep(source: string | ((temp: string) => Promise<void>)): Promise<string>
  /** Whether the store holds this content. */
  has(sha256: string): boolean
  /** A kept content's bytes, or undefined when the store does not hold it. Meant for text a merge reads whole. */
  read(sha256: string): Promise<Buffer | undefined>
  log(event: Omit<VersionEvent, "at">): void
  /** Every event of `path`, oldest first, including renames to or from it. */
  list(path: string): FileVersion[]
  /**
   * Writes a kept version to `into`, replacing the file only while it has `over`, or creating it when `over` is
   * undefined. False when the store no longer has the version or the file was not as `over` said.
   */
  write(sha256: string, into: string, over?: string): Promise<boolean>
  /**
   * Applies the retention rule; see `fileVersions`. `pinned` stay too: a mirror's last synced contents, the base of
   * its next merge. A sync runs it under its lock; call it only under that lock.
   */
  prune(pinned?: Iterable<string>): Promise<void>
}

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000

/** Errors of the local file system: a writer that fails with one could not write the store, whatever it was reading. */
const LOCAL_FAILURES = new Set(["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM", "EIO", "EFBIG", "EMFILE", "ENFILE"])

const notKept = (error: unknown) => {
  const why = (error as NodeJS.ErrnoException).code ?? String(error)
  return new CliError("provider_error", `the earlier content could not be kept (${why}); nothing was replaced`, {
    reason: "mirror.version-not-kept",
  })
}

const stored = async <T>(act: () => Promise<T>): Promise<T> => {
  try {
    return await act()
  } catch (error) {
    throw notKept(error)
  }
}

/** Copies `from` into the new file `into` and returns the sha256 of the bytes it copied. */
const copyHashed = async (from: string, into: string) => {
  const hash = createHash("sha256")
  // Hashed while copied: the file may change under the sync, and the store is keyed by what it really holds.
  await pipeline(
    createReadStream(from),
    new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk)
        done(null, chunk)
      },
    }),
    createWriteStream(into, { flags: "wx", mode: 0o600 }),
  )
  return hash.digest("hex")
}

const rolesOf = (event: VersionEvent): { role: VersionRole; sha256: string }[] => {
  if (!event.parts) return []
  const { base, local, remote } = event.parts
  return [
    ...(base ? [{ role: "base" as const, sha256: base }] : []),
    ...(local ? [{ role: "local" as const, sha256: local }] : []),
    ...(remote ? [{ role: "remote" as const, sha256: remote }] : []),
    ...(event.new ? [{ role: "result" as const, sha256: event.new }] : []),
  ]
}

/**
 * A mirror's local version store: `<dir>/objects/<sha256>` holds each kept content once, `<dir>/log.jsonl` is
 * append-only. The store lives under the profile's state folder, never inside the mirrored folder. Retention: a
 * content stays while an event newer than 30 days names it; the last content of a path whose newest event is a
 * deletion, and every content a merge, a conflict or a resolution names, stay for good. A content no event names stays
 * 30 days after it was last kept, so a crash between keeping a file and logging the change loses nothing.
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
  const has = (sha256: string) => /^[0-9a-f]{64}$/.test(sha256) && existsSync(join(objects, sha256))
  return {
    dir,
    keep: async (source) => {
      await stored(() => mkdir(objects, { recursive: true, mode: 0o700 }))
      const temp = join(objects, `.${randomUUID()}.tmp`)
      try {
        let sha256: string
        if (typeof source === "function") {
          await source(temp).catch((error: unknown) => {
            if (LOCAL_FAILURES.has((error as NodeJS.ErrnoException).code ?? "")) throw notKept(error)
            throw error
          })
          sha256 = await stored(async () => (await hashFile(temp)).sha256)
        } else sha256 = await stored(() => copyHashed(source, temp))
        await stored(async () => {
          const object = join(objects, sha256)
          if (!has(sha256)) await rename(temp, object)
          const at = now() / 1000
          await utimes(object, at, at)
        })
        return sha256
      } finally {
        await rm(temp, { force: true })
      }
    },
    has,
    read: async (sha256) => {
      if (!has(sha256)) return undefined
      return readFile(join(objects, sha256)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    },
    log: (event) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(logPath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...event })}\n`, { mode: 0o600 })
    },
    list: (path) => {
      const found = events().filter((event) => event.path === path || event.to === path)
      return found.map((event) => {
        const roles = rolesOf(event)
        return {
          ...event,
          available: roles.length
            ? roles.every(({ sha256 }) => has(sha256))
            : event.old !== undefined && has(event.old),
          ...(roles.length ? { versions: roles.map((role) => ({ ...role, available: has(role.sha256) })) } : {}),
        }
      })
    },
    write: async (sha256, into, over) => {
      if (!has(sha256)) return false
      const copy = (temp: string) =>
        pipeline(createReadStream(join(objects, sha256)), createWriteStream(temp, { flags: "wx" }))
      return (await replaceLocal(into, over, copy, { sha256 })) !== undefined
    },
    prune: async (pinned = []) => {
      const all = events()
      const keep = new Set<string>(pinned)
      const last = new Map<string, VersionEvent>()
      for (const event of all) {
        last.set(event.path, event)
        if (Date.parse(event.at) > now() - RETAIN_MS)
          for (const hash of [event.old, event.new]) if (hash) keep.add(hash)
        for (const { sha256 } of rolesOf(event)) keep.add(sha256)
      }
      for (const event of last.values()) if (event.event === "deleted" && event.old) keep.add(event.old)
      let names: string[]
      try {
        names = await readdir(objects)
      } catch {
        return
      }
      for (const name of names) {
        if (name.startsWith(".") || keep.has(name)) continue
        const object = join(objects, name)
        const kept = await stat(object).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (kept && kept.mtimeMs <= now() - RETAIN_MS) await rm(object, { force: true })
      }
    },
  }
}

/**
 * Puts a kept version of `path` back into the mirrored folder; the file there now is kept first. The next sync sends
 * it like any local change. False when the store no longer has the version or the file changed meanwhile. Runs under
 * the mirrors' sync lock (as `acquireLock` returns it, or any `assertHeld`), so a sync never reads the folder halfway
 * through.
 */
export const restoreFileVersion = async (
  root: string,
  path: string,
  sha256: string,
  versions: FileVersions,
  lock: () => Promise<HeldLock>,
) => {
  if (!safePath(path)) throw new CliError("validation_error", `${path} is not a path inside the mirror`)
  const held = await lock()
  try {
    await assertNoLink(root, path)
    const absolute = join(root, path)
    const current = existsSync(absolute) ? await versions.keep(absolute) : undefined
    if (current === sha256) return true
    await heldCheck(held)()
    if (!(await versions.write(sha256, absolute, current))) return false
    versions.log({
      path,
      event: current ? "changed" : "created",
      direction: "restored",
      ...(current ? { old: current, from: "local" as const } : {}),
      new: sha256,
    })
    return true
  } finally {
    await held.release()
  }
}
