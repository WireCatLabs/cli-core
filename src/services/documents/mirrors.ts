import { createHash } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, writeSecurely } from "@wirecat/cli-base"
import * as v from "valibot"
import type { DocumentTarget, Keep, PushState, PushStatePort } from "../../documents/push-model.js"
import { type PushConflict, type PushOptions, planPush, pushDocuments, scanLocal } from "./push.js"

/** A local folder mirrored into a remote folder, as the app's profile config keeps it. */
export interface Mirror {
  id: string
  path: string
  folder: string
}

export const mirrorId = (root: string, folder: string): string =>
  createHash("sha256")
    .update(JSON.stringify([root, folder]))
    .digest("hex")
    .slice(0, 8)

const ID = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,200}$/))

const stateSchema = (kinds: [string, ...string[]]) =>
  v.object({
    version: v.literal(1),
    principal: v.string(),
    root: v.string(),
    target: ID,
    folders: v.record(v.string(), ID),
    entries: v.record(
      v.string(),
      v.object({
        id: ID,
        url: v.string(),
        kind: v.string(),
        hash: v.string(),
        // Checked by kind only: the rest is the provider's own read-back.
        snapshot: v.looseObject({ kind: v.picklist(kinds) }),
        pushedAt: v.string(),
      }),
    ),
    pending: v.record(v.string(), v.object({ origin: v.string(), operationId: v.string() })),
  })

/**
 * A state file read against `schema`, saved 0600 in a 0700 folder. A missing file is `initial`, a first sync; an
 * unreadable or invalid one is refused rather than reset, since a reset would treat every file as new.
 */
export const jsonState = <T>(path: string, schema: v.GenericSchema, initial: () => T) => ({
  read: (): T => {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial()
      throw new CliError("configuration_error", "mirror state is unreadable; refusing to reset it", {
        reason: "state.invalid",
      })
    }
    const parsed = v.safeParse(schema, value)
    if (!parsed.success)
      throw new CliError("configuration_error", "mirror state is invalid; refusing to reset it", {
        reason: "state.invalid",
      })
    return parsed.output as T
  },
  save: (state: T) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeSecurely(path, `${JSON.stringify(state)}\n`, 0o600)
  },
})

/** A mirror's push state in `<dir>/<id>.json`. */
export const fileMirrorState = <S>(
  dir: string,
  mirror: Mirror,
  principal: string,
  kinds: [string, ...string[]],
): PushStatePort<S> =>
  jsonState<PushState<S>>(join(dir, `${mirror.id}.json`), stateSchema(kinds), () => ({
    version: 1,
    principal,
    root: mirror.path,
    target: mirror.folder,
    folders: {},
    entries: {},
    pending: {},
  }))

/** What the next sync of each mirror would create or send, from local files and the state alone. */
export const mirrorStatus = async <S>(
  mirrors: Mirror[],
  kindOf: (path: string) => string | undefined,
  stateOf: (mirror: Mirror) => PushStatePort<S>,
) => {
  const items = []
  for (const mirror of mirrors) {
    const { files, unsupported } = await scanLocal(mirror.path, kindOf)
    const plan = planPush(files, stateOf(mirror).read())
    items.push({
      id: mirror.id,
      path: mirror.path,
      folder: mirror.folder,
      create: plan.create.map((file) => file.path),
      update: plan.update.map((file) => file.path),
      unchanged: plan.unchanged.length,
      orphans: plan.orphans,
      unsupported,
      remote_checked: false,
    })
  }
  return items
}

/** A conflict as the user reads it, with the remote side named the way the app names it (`google`). */
export const conflictReport = (conflict: PushConflict, remote: string) => ({
  path: conflict.path,
  ...(conflict.url ? { url: conflict.url } : {}),
  reason: conflict.reason,
  ...(conflict.parts
    ? { parts: conflict.parts.map((part) => ({ last_sync: part.base, local: part.local, [remote]: part.remote })) }
    : {}),
  ...(conflict.localChangedAt ? { local_changed_at: conflict.localChangedAt } : {}),
  ...(conflict.remoteChangedAt ? { [`${remote}_changed_at`]: conflict.remoteChangedAt } : {}),
  ...(conflict.remoteChangedBy ? { [`${remote}_changed_by`]: conflict.remoteChangedBy } : {}),
  ...(conflict.localSize !== undefined ? { local_size: conflict.localSize } : {}),
  ...(conflict.remoteSize !== undefined ? { [`${remote}_size`]: conflict.remoteSize } : {}),
})

interface MirrorLock {
  assertHeld(): void
  release(): Promise<void> | void
}

/**
 * Runs `sync` for each mirror under one lock. A mirror with conflicts, missing remote files or errors does not stop
 * the others; it gets one `mirror.partial` issue, so the caller can answer `complete: false` and fail after printing.
 */
export const eachMirror = async <R extends { conflicts: PushConflict[]; errors: unknown[]; missing?: unknown[] }>(
  mirrors: Mirror[],
  lock: () => Promise<MirrorLock>,
  remote: string,
  sync: (mirror: Mirror, assertHeld: () => void) => Promise<R>,
) => {
  const held = await lock()
  const results: ({ id: string; path: string } & R)[] = []
  try {
    for (const mirror of mirrors)
      results.push({ id: mirror.id, path: mirror.path, ...(await sync(mirror, () => held.assertHeld())) })
  } finally {
    await held.release()
  }
  const issues = results
    .filter((result) => result.errors.length || result.conflicts.length || result.missing?.length)
    .map((result) => ({ code: "provider_error" as const, reason: "mirror.partial", source: `mirror ${result.id}` }))
  return {
    items: results.map(({ conflicts, ...result }) => ({
      ...result,
      conflicts: conflicts.map((conflict) => conflictReport(conflict, remote)),
    })),
    issues,
  }
}

export interface MirrorSyncOptions<S>
  extends Pick<PushOptions<S>, "principal" | "recreate" | "guard" | "operationId" | "errorOf" | "signal"> {
  mirrors: Mirror[]
  target: DocumentTarget<S>
  stateOf(mirror: Mirror): PushStatePort<S>
  keep?: Keep
  /** Taken once for all the mirrors, so a second sync or a watcher's next cycle waits its turn. */
  lock(): Promise<MirrorLock>
  /** How the app names the remote side in conflict reports. */
  remote: string
}

/** Syncs each mirror both ways, as `eachMirror` runs them. */
export const syncMirrors = <S>(options: MirrorSyncOptions<S>) =>
  eachMirror(options.mirrors, options.lock, options.remote, (mirror, assertHeld) =>
    pushDocuments({
      root: mirror.path,
      folder: mirror.folder,
      target: options.target,
      state: options.stateOf(mirror),
      principal: options.principal,
      ...(options.keep ? { keep: options.keep } : {}),
      recreate: options.recreate === true,
      guard: options.guard,
      operationId: options.operationId,
      errorOf: options.errorOf,
      assertHeld,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  )
