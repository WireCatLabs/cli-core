import { readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { CliError, isCliError, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import * as v from "valibot"
import { deadlineMargin } from "../../background/budget.js"
import {
  exclusionPattern,
  type FileMirrorSyncOptions,
  type FileTarget,
  fileMirrorStatus,
  fileRemoteChanges,
  fileSyncState,
  fileVersions,
  type Keep,
  type Mirror,
  type MirrorAction,
  mirrorId,
  restoreFileVersion,
  syncFileMirrors,
  watchMirrors,
} from "../../documents.js"
import { parseDuration } from "../../domain/duration.js"
import { writeFileAtomic } from "../../files/atomic-write.js"
import { acquireLock } from "../../files/lock.js"
import type { AppIdentity } from "../../ports/app.js"
import type { Asker } from "../../sends/guard.js"
import { guardedWrite } from "../../sends/guarded.js"
import type { KeyedGuard } from "../../sends/keyed-guard.js"
import { newOperationId } from "../../sends/send-id.js"
import { refusedPlace } from "../../sends/upload.js"
import { environmentOf, outputFor } from "../context.js"
import { FETCH, LOCAL_READ, LOCAL_WRITE, ownerOnlyOption, REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { type Body, itemOf, jsonlRecords, listOf, snakeKeys } from "../envelope.js"
import { commandPath } from "../list-query.js"
import { terminalAsker } from "../messenger/ask.js"
import { notLocalPaths } from "../path-options.js"
import { marksUntrusted } from "../untrusted-marks.js"
import { fileConflictsCommand } from "./file-conflicts.js"

/** One write a sync is about to make, as the app's permission keys see it. */
export interface FileMirrorWrite {
  action: MirrorAction
  side: "local" | "remote"
}

/** The remote, signed in for one run. */
export interface FileMirrorRemote {
  target: FileTarget
  /**
   * The remote folder `mirrors add` was given, as the app names it: `folder` is what the mirror saves and the target
   * lists, `rootId` the folder's id, pinned so a folder put in its place is refused. Refuses anything that is not a
   * folder the account can mirror.
   */
  root(input: string): Promise<{ folder: string; rootId: string }>
}

/** What a file-mirror CLI gives `fileMirrorsCommand`. */
export interface FileMirrorCommands {
  /** Who the app is: its command names the examples and hints, its folders are never mirrored. */
  identity: AppIdentity
  /** The service as people name it, `Yandex Disk`, `Notion`. */
  service: string
  /** How the remote side is named in `--keep`, in reports (`disk_changed_at`) and in a conflict copy's name. */
  remote: string
  /**
   * What a mirror pairs a local folder with, as help names it (`Yandex Disk folder`, `Notion page`), the remote
   * argument of `mirrors add`, two examples of the command after `mirrors add`, and a sentence its help ends with.
   */
  root: { place: string; description: string; examples: readonly [string, string]; note?: string }
  /** How often `mirrors watch` asks the remote by default; a remote without a revision lists everything each time. */
  every?: string
  output(command: Command, body: Body): void
  /** The selected profile; refuses when there is none. */
  profile(command: Command): string
  /** The profile's own state folder: `mirrors.json`, and `mirrors/` with each mirror's state, versions and lock. */
  stateDir(command: Command): string
  /** How long a replaced or deleted version stays: the profile's `keep_versions_for_days`. */
  keepForDays(command: Command): number
  /**
   * Runs `body` inside the app's run (its `--timeout`, run record and request log) with the remote signed in. `watch`
   * passes `unbounded`, since it ends at `--timeout` on its own.
   */
  connect<T>(
    command: Command,
    body: (remote: FileMirrorRemote) => Promise<T>,
    options?: { unbounded?: boolean },
  ): Promise<T>
  /** The guard of a write under the command's own key and `extra`, asking at `ask`. */
  writeGuard(command: Command, extra: readonly string[], ask: Asker): KeyedGuard
  /** The keys one write checks beside the command's own, `files.delete` for a replaced file on Yandex Disk. */
  keysOf(write: FileMirrorWrite): readonly string[]
}

/** A mirror with the account it was added for: a sync signed in to another account is refused. */
const SavedMirror = v.strictObject({
  id: v.string(),
  path: v.string(),
  folder: v.string(),
  account: v.string(),
  exclude: v.optional(v.array(v.string())),
})
type SavedMirror = v.InferOutput<typeof SavedMirror>

interface Listed {
  files: number
  complete: boolean
  resumed?: true
  soFar?: number
}

type Synced = Awaited<ReturnType<typeof syncFileMirrors>>["items"][number]
type Reported = (Synced & { listed?: Listed; unlisted?: number }) | { id: string; path: string; stopped: true }

interface Cycle {
  at: string
  triggers: string[]
  mirrors: string[]
  error?: { code: string; message: string }
  results?: {
    id: string
    uploaded: string[]
    downloaded: string[]
    merged: string[]
    trashed: unknown[]
    conflicts: unknown[]
    errors: { path: string; message: string }[]
  }[]
}

const ID = "mirror id from mirrors list"
const PATH = "the file's path inside the mirror, like notes/plan.md"
// A mirror's own path is the owner's folder; the files in it and their new names are whoever shares the remote's.
const PREVIEW_UNTRUSTED = [
  "uploaded",
  "downloaded",
  "merged",
  "rewritten",
  "adopted",
  "trashed.path",
  "renamed.from",
  "renamed.to",
  "plan.path",
  "plan.to",
  "unknown.path",
  "errors.path",
  "conflicts.path",
  "conflicts.remote_changed_by",
]
/** The engine's refusals of a whole run, which a sync ends with instead of the generic partial one. */
const STOPS = new Set(["mirror.too-many-deletions", "mirror.too-many-replacements", "mirror.no-space"])

const errorOf = (error: unknown) =>
  isCliError(error) ? error : new CliError("provider_error", error instanceof Error ? error.message : String(error))

const accountOf = (chosen: SavedMirror[]) => {
  const accounts = new Set(chosen.map((mirror) => mirror.account))
  if (accounts.size > 1)
    throw new CliError("validation_error", "these mirrors belong to different accounts; sync them one at a time")
  return chosen[0]?.account as string
}

const realOf = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** A path inside the mirror as the version log names it: relative, with `/`, from a relative or absolute path. */
const insideOf = (root: string, input: string) => {
  const path = isAbsolute(input) ? relative(root, input) : input
  return path.split(sep).join("/")
}

const collect = (value: string, previous: string[] = []) => [...previous, value]

const allOf = <T>(command: string, items: T[]) =>
  listOf(command, { items, limit: Math.max(1, items.length), has_more: false })

/** The target with each listing's size kept by remote folder, so the answer says how far it got. */
const recorded = (target: FileTarget) => {
  const listings = new Map<string, Listed>()
  const list: FileTarget["list"] = async (folder, signal, options) => {
    const listing = await target.list(folder, signal, options)
    if (listing)
      listings.set(folder, {
        files: listing.files.length,
        complete: listing.complete,
        ...(options?.from === undefined ? {} : { resumed: true as const }),
      })
    return listing
  }
  return { listings, target: { ...target, list } }
}

const moved = (item: Reported) =>
  "uploaded" in item &&
  [item.uploaded, item.downloaded, item.merged, item.trashed, item.renamed, item.adopted].some((done) => done.length)

/** A sync kept its place in the remote's listing, so the next run lists from there instead of from the start. */
const keptPlace = (item: Reported) => "listed" in item && item.listed?.soFar !== undefined

/**
 * Fires a margin before the run's deadline (cli-core's, at most half the run), so a sync stops on its own between
 * steps, saves and answers instead of being cut with nothing said.
 */
const beforeDeadline = (command: Command) => {
  const environment = environmentOf(command)
  const deadline = environment.deadline?.()
  const soon = new AbortController()
  const timer =
    deadline &&
    setTimeout(
      () => soon.abort(),
      Math.max(0, deadline.endsAt - Math.min(deadlineMargin(deadline), deadline.ms / 2) - Date.now()),
    )
  timer?.unref()
  return {
    signal: environment.signal ? AbortSignal.any([environment.signal, soon.signal]) : soon.signal,
    deadline,
    clear: () => clearTimeout(timer),
  }
}

/**
 * `mirrors add|list|status|preview|sync|watch|update|remove`, `mirrors versions list|restore` and `mirrors conflicts
 * list|show|resolve`: local folders and remote folders kept the same both ways, file by file, over `syncFileMirrors`.
 * The app gives its remote, how `add` finds a remote folder, its write guard and its keys. Each profile keeps its
 * mirrors in `mirrors.json` under its state folder, and each mirror's state, versions and the sync lock in `mirrors/`.
 */
export const fileMirrorsCommand = (helpers: FileMirrorCommands): Command => {
  const { identity, service, remote: REMOTE } = helpers
  const CLI = identity.command
  const output = helpers.output

  /** The profile's mirrors, their sync state, version stores and lock, under its state folder. */
  const homeOf = (command: Command) => {
    const profile = helpers.profile(command)
    const dir = helpers.stateDir(command)
    const listPath = join(dir, "mirrors.json")
    const states = join(dir, "mirrors")
    const mirrors = (): SavedMirror[] => {
      let value: unknown
      try {
        value = JSON.parse(readFileSync(listPath, "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw new CliError("configuration_error", `${listPath} is unreadable; refusing to reset it`)
      }
      const parsed = v.safeParse(v.array(SavedMirror), value)
      if (!parsed.success) throw new CliError("configuration_error", `${listPath} is invalid; refusing to reset it`)
      return parsed.output
    }
    const find = (id: string) => {
      const mirror = mirrors().find((one) => one.id === id)
      if (!mirror)
        throw new CliError("not_found", `no mirror ${id} in profile ${profile}; see ${CLI} ${profile} mirrors list`, {
          reason: "mirror.not-found",
        })
      return mirror
    }
    const keepForDays = helpers.keepForDays(command)
    return {
      profile,
      mirrors,
      find,
      chosen: (id?: string) => {
        const chosen = id ? [find(id)] : mirrors()
        if (!chosen.length)
          throw new CliError(
            "not_found",
            `profile ${profile} has no mirrors; add one with ${CLI} ${profile} mirrors add`,
            { reason: "mirror.none" },
          )
        return chosen
      },
      save: (list: SavedMirror[]) => writeFileAtomic(listPath, JSON.stringify(list, null, 2), { mode: 0o600 }),
      statePath: (mirror: Mirror) => join(states, `${mirror.id}.json`),
      stateOf: (mirror: SavedMirror) => fileSyncState(states, mirror, mirror.account),
      versionsOf: (mirror: Mirror) => fileVersions(join(states, `${mirror.id}.versions`), Date.now, keepForDays),
      lock: () =>
        acquireLock(join(states, "sync.lock")).catch((error: unknown) => {
          throw new CliError("provider_unavailable", "another mirrors sync or watch holds this profile; retry later", {
            reason: "profile.busy",
            ...(isCliError(error) ? { holders: error.details.holders } : {}),
          })
        }),
    }
  }

  const hintsOf = (profile: string) => ({
    preview: `${CLI} ${profile} mirrors preview <id>`,
    repin: `\`${CLI} ${profile} mirrors sync <id> --repin\``,
    sync: `${CLI} ${profile} mirrors sync <id>`,
    allowDeletions: "--allow-deletions <count>",
    exclude: `${CLI} ${profile} mirrors update <id> --ignore <path>`,
  })

  /**
   * What the engine needs beside the mirrors: the remote, the account and each write behind the command's own key
   * and the keys the app names for it. One question per set of keys, however many files.
   */
  const engineOf = (command: Command, target: FileTarget, chosen: SavedMirror[], signal?: AbortSignal) => {
    const home = homeOf(command)
    const key = commandPath(command).replaceAll(" ", ".")
    const guards = new Map<string, KeyedGuard>()
    // Each set of keys has its own guard, so a deny on a delete key still lets additions through; a key the owner
    // allowed once is not asked again in the same run.
    const approved = new Set<string>()
    const terminal = terminalAsker(command)
    const ask: Asker = async (question, request) => {
      const keys = question.split(" and ")
      if (keys.every((one) => approved.has(one))) return
      await terminal(question, request)
      for (const one of keys) approved.add(one)
    }
    const guard: FileMirrorSyncOptions["guard"] = (attempt, act) => {
      const extra = [...helpers.keysOf({ action: attempt.action, side: attempt.side })]
      const name = extra.join(" ")
      const keyed = guards.get(name) ?? helpers.writeGuard(command, extra, ask)
      guards.set(name, keyed)
      const request = { chatId: null, kind: "edit" as const, key, operationId: attempt.operationId }
      keyed.refuse(request)
      return guardedWrite(keyed, request, act)
    }
    const own = signal ?? environmentOf(command).signal
    return {
      target,
      principal: accountOf(chosen),
      guard,
      operationId: newOperationId,
      errorOf,
      lock: home.lock,
      hints: hintsOf(home.profile),
      stateOf: (mirror: Mirror) => home.stateOf(mirror as SavedMirror),
      versionsOf: home.versionsOf,
      remote: REMOTE,
      ...(own ? { signal: own } : {}),
    } satisfies Omit<FileMirrorSyncOptions, "mirrors">
  }

  /**
   * Each mirror in turn until the deadline is near; one left for then is answered as stopped, since the engine refuses
   * to start once the signal has fired. The remote files a stopped listing did not reach are counted, not listed: a
   * big remote's would pass the output's limit, none of them is deleted, and the next sync lists them.
   */
  const syncEach = async (
    command: Command,
    remoteTarget: FileTarget,
    chosen: SavedMirror[],
    options: Partial<FileMirrorSyncOptions>,
    stop: AbortSignal,
  ) => {
    const { listings, target } = recorded(remoteTarget)
    const engine = engineOf(command, target, chosen, stop)
    const items: Reported[] = []
    const issues: Awaited<ReturnType<typeof syncFileMirrors>>["issues"] = []
    // One lock for the run, as one call for every mirror takes it, so no watch syncs between two mirrors.
    const held = await engine.lock()
    const lock = async () => ({ held: () => held.held(), release: () => {} })
    try {
      for (const mirror of chosen) {
        if (stop.aborted) {
          items.push({ id: mirror.id, path: mirror.path, stopped: true })
          continue
        }
        const one = await syncFileMirrors({ ...engine, ...options, lock, mirrors: [mirror] })
        // A dry run saves no listing, so only a sync's kept place says the next run goes on from it.
        const kept = options.dryRun ? undefined : engine.stateOf(mirror).read().listing
        const run = listings.get(mirror.folder)
        const listed = run && kept ? { ...run, soFar: kept.files.length } : run
        for (const item of one.items) {
          const cut = item.stopped === true || (listed?.complete === false && stop.aborted)
          const unreached = cut && listed?.complete === false
          const unknown = unreached ? item.unknown.filter((file) => file.side !== "remote") : item.unknown
          if (item.errors.length || item.conflicts.length || unknown.length)
            for (const issue of one.issues) issues.push(issue)
          items.push({
            ...item,
            unknown,
            ...(listed ? { listed } : {}),
            ...(cut ? { stopped: true as const } : {}),
            ...(unreached ? { unlisted: item.unknown.length - unknown.length } : {}),
          })
        }
      }
    } finally {
      await held.release()
    }
    return { items, issues }
  }

  /**
   * What a stopped run offers: the same run again when it moved or kept its place in the listing, since it goes on
   * from where it stopped; when only a listing that cannot go on fit (a folder's, or any preview's), a longer run, as
   * the same deadline would list the same files again.
   */
  const resumeOf = (
    command: Command,
    name: "sync" | "preview",
    items: Reported[],
    deadline: { ms: number } | undefined,
    id?: string,
  ) => {
    const stopped = items.filter((item) => item.stopped)
    if (!stopped.length) return []
    const only = stopped.length === 1 ? stopped[0]?.id : id
    const timeout = command.optsWithGlobals<{ timeout?: string }>().timeout
    const ms = deadline?.ms ?? 0
    const longer = ms < 15 * 60_000 ? "15m" : `${Math.ceil((ms * 2) / 3_600_000)}h`
    const again = name === "sync" && items.some((item) => moved(item) || keptPlace(item))
    const listing = again && !items.some(moved)
    return [
      {
        kind: "command" as const,
        step: again ? "mirrors.sync" : `mirrors.${name}.longer`,
        command: `mirrors ${name}`,
        args: { ...(only ? { id: only } : {}), ...(again ? (timeout ? { timeout } : {}) : { timeout: longer }) },
        why: listing
          ? `the ${service} listing stopped before its deadline and kept its place; run it again to go on from there`
          : again
            ? "the sync stopped before its deadline and kept what it did; run it again to go on from there"
            : `listing ${service} took the whole run; give it more time, in a terminal`,
        safe_to_auto_execute: false,
      },
    ]
  }

  /**
   * A mirror would send every file under its folder to the remote. `files upload`'s rule refuses credential folders,
   * the WireCat apps' folders and the store; a folder holding this CLI's own folders would also send its state and
   * the versions it keeps, and change under every sync.
   */
  const refuseSensitive = (root: string, env: NodeJS.ProcessEnv) => {
    const real = realOf(root)
    const own = Object.values(resolvePaths({ appName: identity.appName, prefix: identity.envPrefix, env })).map(realOf)
    const holds = (dir: string) => {
      const way = relative(real, dir)
      return way === "" || (!way.startsWith("..") && !isAbsolute(way))
    }
    // The home folder, or one holding it, is never a mirror, even with the CLI's folders moved out of it.
    // On Windows a drive root other than the home's drive holds none of the folders above, yet is a whole disk.
    const driveRoot = real === parse(real).root
    if (driveRoot || own.some(holds) || holds(realOf(env.HOME ?? homedir())) || refusedPlace(root, identity, env))
      throw new CliError(
        "validation_error",
        `${root} is not mirrored: the home folder, credential folders, the WireCat apps' folders and a folder holding ` +
          `${CLI}'s own settings or state are never sent to ${service}; mirror a folder of its own`,
        { reason: "mirror.not-folder" },
      )
  }

  const ignoreOption = () =>
    new Option(
      "--ignore <path>",
      "leave this path out on both sides, a path or a glob; repeat it for more: a name at any depth (node_modules, " +
        "*.iso) or a path from the mirror's root (/Photos)",
    ).argParser(collect)

  const keepOption = () =>
    new Option("--keep <side>", `settle each conflict: keep the local file, the ${service} one, or both`).choices([
      "local",
      REMOTE,
      "both",
    ])

  const keepOf = (side?: string): Keep | undefined => (side === REMOTE ? "remote" : (side as Keep | undefined))

  const addCommand = () =>
    notLocalPaths(
      annotate(new Command("add"), {
        effects: FETCH,
        offline: false,
        mcp: false,
        examples: helpers.root.examples.map((example) => `${CLI} personal mirrors add ${example}`),
      }),
      "folder",
    )
      .summary(`mirror a local folder and a ${helpers.root.place} both ways`)
      .description(
        `mirror a local folder and a ${helpers.root.place} both ways: checks the ${helpers.root.place} and saves the ` +
          `pair; nothing is copied until mirrors sync${helpers.root.note ? `. ${helpers.root.note}` : ""}`,
      )
      .argument("<folder>", helpers.root.description)
      .argument("<path>", "the local folder")
      .addOption(ignoreOption())
      .action(async function (this: Command, folder: string, path: string, args: { ignore?: string[] }) {
        const root = resolve(path)
        let directory = false
        try {
          directory = statSync(root).isDirectory()
        } catch {}
        if (!directory)
          throw new CliError("validation_error", "the local path is not a folder", { reason: "mirror.not-folder" })
        refuseSensitive(root, environmentOf(this).env ?? process.env)
        const exclude = [...new Set((args.ignore ?? []).map(exclusionPattern))]
        const home = homeOf(this)
        const found = await helpers.connect(this, async (remote) => ({
          ...(await remote.root(folder)),
          account: await remote.target.identity(),
        }))
        const mirror = {
          path: root,
          folder: found.folder,
          account: found.account,
          ...(exclude.length ? { exclude } : {}),
        }
        const id = mirrorId(mirror.path, mirror.folder)
        const list = home.mirrors()
        const added = !list.some((one) => one.id === id)
        if (added) {
          list.push({ id, ...mirror })
          // The remote folder is pinned now, so a folder put in its place before the first sync is refused, not
          // mirrored. A fresh state, whatever a removal cut short left behind: an old one would read every file
          // missing since as deleted.
          home.stateOf({ id, ...mirror }).save({
            version: 1,
            principal: mirror.account,
            root: mirror.path,
            target: mirror.folder,
            rootId: found.rootId,
            entries: {},
            pending: {},
          })
          await home.save(list)
        }
        const saved = home.find(id)
        output(this, itemOf({ id, path: root, folder: mirror.folder, ignore: saved.exclude ?? [], added }))
      })

  /** Changes what a mirror ignores under the sync lock, so no running sync reads half of it. */
  const updateCommand = () =>
    annotate(new Command("update"), {
      effects: LOCAL_WRITE,
      mcp: false,
      examples: [
        `${CLI} personal mirrors update 1a2b3c4d --ignore Photos --ignore "*.iso"`,
        `${CLI} personal mirrors update 1a2b3c4d --clear --ignore Photos`,
      ],
    })
      .summary("add paths a mirror ignores, or clear the list; nothing is deleted on either side")
      .description(
        "add paths to what a mirror ignores, as mirrors list shows it. --clear empties the list first, so --clear " +
          "with --ignore keeps only the paths given: that is how one path stops being ignored. An ignored path is " +
          "left alone on both sides and never deleted, now or later; one no longer ignored is synced as a new " +
          "folder, copying one-sided files and reporting different ones as conflicts, deleting nothing",
      )
      .argument("<id>", ID)
      .addOption(ignoreOption())
      .addOption(new Option("--clear", "empty the list before adding any --ignore paths; alone, sync every path again"))
      .action(async function (this: Command, id: string, args: { ignore?: string[]; clear?: boolean }) {
        const home = homeOf(this)
        home.find(id)
        if (!args.ignore?.length && !args.clear)
          throw new CliError("validation_error", "give a path to ignore with --ignore, or --clear to empty the list", {
            param: "--ignore",
          })
        const added = (args.ignore ?? []).map(exclusionPattern)
        const held = await home.lock()
        let exclude: string[] = []
        try {
          await home.save(
            home.mirrors().map((one) => {
              if (one.id !== id) return one
              exclude = [...new Set([...(args.clear ? [] : (one.exclude ?? [])), ...added])]
              const { exclude: _, ...rest } = one
              return exclude.length ? { ...rest, exclude } : rest
            }),
          )
        } finally {
          await held.release()
        }
        output(this, itemOf({ id, ignore: exclude }))
      })

  const listCommand = () =>
    annotate(new Command("list"), {
      effects: LOCAL_READ,
      examples: [`${CLI} personal mirrors list --json`],
    })
      .description("list this profile's mirrors")
      .action(function (this: Command) {
        output(
          this,
          allOf(
            "mirrors list",
            homeOf(this)
              .mirrors()
              .map(({ id, path, folder, exclude }) => ({ id, path, folder, ignore: exclude ?? [] })),
          ),
        )
      })

  const removeCommand = () =>
    annotate(new Command("remove"), {
      effects: LOCAL_WRITE,
      mcp: false,
      examples: [`${CLI} personal mirrors remove 1a2b3c4d`],
    })
      .summary("stop mirroring a folder; nothing on either side changes")
      .description(
        `stop mirroring a folder: nothing on ${service} or in the local folder is changed; its kept versions stay`,
      )
      .argument("<id>", ID)
      .action(async function (this: Command, id: string) {
        const home = homeOf(this)
        const mirror = home.find(id)
        const held = await home.lock()
        try {
          // The state goes first: added again later, the pair starts as a first sync, which deletes nothing.
          rmSync(home.statePath(mirror), { force: true })
          await home.save(home.mirrors().filter((one) => one.id !== id))
        } finally {
          await held.release()
        }
        output(this, itemOf({ id, removed: true }))
      })

  const statusCommand = () =>
    annotate(new Command("status"), {
      effects: LOCAL_READ,
      examples: [`${CLI} personal mirrors status --json`],
    })
      .summary("show what the next sync would send from local changes")
      .description(`show which local files the next sync would send or delete on ${service}; ${service} is not asked`)
      .argument("[id]", `${ID}; every mirror of the profile when omitted`)
      .action(async function (this: Command, id?: string) {
        const home = homeOf(this)
        const chosen = id ? [home.find(id)] : home.mirrors()
        const items = await fileMirrorStatus(chosen, (mirror) => home.stateOf(mirror as SavedMirror))
        output(
          this,
          allOf(
            "mirrors status",
            items.map((item) => ({
              id: item.id,
              path: item.path,
              folder: item.folder,
              upload: item.upload.length,
              delete: item.delete.length,
              unchanged: item.unchanged,
              remote_checked: item.remote_checked,
            })),
          ),
        )
      })

  const previewCommand = () =>
    marksUntrusted(
      annotate(new Command("preview"), {
        effects: REMOTE_READ,
        offline: false,
        // Listing a big remote can take minutes: it stops before its deadline (5 min, 45 s over MCP) and says so.
        cooperative: true,
        examples: [
          `${CLI} personal mirrors preview --json`,
          `${CLI} personal mirrors preview 1a2b3c4d --keep ${REMOTE}`,
        ],
      }),
      PREVIEW_UNTRUSTED,
    )
      .summary(`list ${service} and show what mirrors sync would do`)
      .description(
        `list ${service} and show what mirrors sync would do: each upload, download, merge, rename, trash and ` +
          "conflict; nothing is changed on either side",
      )
      .argument("[id]", `${ID}; every mirror of the profile when omitted`)
      .addOption(keepOption())
      .action(async function (this: Command, id: string | undefined, args: { keep?: string }) {
        const chosen = homeOf(this).chosen(id)
        const keep = keepOf(args.keep)
        const soon = beforeDeadline(this)
        const { items } = await helpers
          .connect(this, (remote) =>
            syncEach(this, remote.target, chosen, { dryRun: true, ...(keep ? { keep } : {}) }, soon.signal),
          )
          .finally(soon.clear)
        const body = allOf(
          "mirrors preview",
          items.map((item) => snakeKeys(item)),
        )
        const stopped = items.filter((item) => item.stopped)
        // Not a resumable command: a plan cut short is no plan, so it exits with the issue's code.
        if (stopped.length) {
          body.meta = {
            complete: false,
            issues: stopped.map((item) => ({
              code: "timeout" as const,
              reason: "mirror.stopped",
              source: `mirror ${item.id}`,
            })),
          }
          body.next = resumeOf(this, "preview", items, soon.deadline, id)
        }
        output(this, body)
      })

  const syncCommand = () =>
    annotate(new Command("sync"), {
      effects: REMOTE_WRITE,
      offline: false,
      // A big remote's first sync takes hours: each run stops before its deadline (15 min, 45 s over MCP), keeps
      // what it did and answers partial, and the next goes on from there.
      cooperative: true,
      partial: true,
      examples: [`${CLI} personal mirrors sync`, `${CLI} personal mirrors sync 1a2b3c4d --keep ${REMOTE}`],
    })
      .summary("sync mirrors both ways once")
      .description(
        "sync mirrors both ways once: a change on one side is copied to the other, a deletion goes to the other " +
          "side's trash, a text file changed on both sides in different places is merged, and any other file " +
          "changed on both sides is reported for mirrors conflicts or --keep; mirrors preview shows the plan first. " +
          "A run stops before its deadline, keeps what it did, and the next sync goes on from there",
      )
      .argument("[id]", `${ID}; every mirror of the profile when omitted`)
      .addOption(keepOption())
      .addOption(
        ownerOnlyOption(
          "--allow-deletions <count>",
          "let this run delete up to this many files when the guard stops it",
        ),
      )
      .addOption(
        ownerOnlyOption(
          "--allow-replacements <count>",
          "let this run overwrite up to this many existing files when the guard stops it; each is kept as a version first",
        ),
      )
      .addOption(
        ownerOnlyOption(
          "--replace",
          "let this run overwrite any number of existing files when the guard stops it; each is kept as a version first",
        ),
      )
      .addOption(
        ownerOnlyOption(
          "--repin",
          `the ${service} or local folder was replaced and the new one is right: record it and sync`,
        ),
      )
      .action(async function (
        this: Command,
        id: string | undefined,
        args: {
          keep?: string
          allowDeletions?: string
          allowReplacements?: string
          replace?: boolean
          repin?: boolean
        },
      ) {
        const home = homeOf(this)
        const chosen = home.chosen(id)
        // An approval is for the files one mirror's preview showed, never for every mirror at once.
        const oneMirror = (flag: string) => {
          if (chosen.length > 1)
            throw new CliError(
              "validation_error",
              `${flag} needs the mirror's id; see ${CLI} ${home.profile} mirrors list`,
              { param: flag },
            )
        }
        const countOf = (flag: string, value: string | undefined, what: string) => {
          if (value === undefined) return undefined
          const count = Number(value)
          if (!Number.isSafeInteger(count) || count < 1)
            throw new CliError("validation_error", `${flag} takes the number of files the run may ${what}`, {
              param: flag,
            })
          oneMirror(flag)
          return count
        }
        const allowDeletions = countOf("--allow-deletions", args.allowDeletions, "delete")
        if (args.replace && args.allowReplacements !== undefined)
          throw new CliError("validation_error", "give --allow-replacements <count> or --replace, not both", {
            param: "--replace",
          })
        if (args.replace) oneMirror("--replace")
        const allowReplacements = args.replace
          ? Number.POSITIVE_INFINITY
          : countOf("--allow-replacements", args.allowReplacements, "replace")
        const keep = keepOf(args.keep)
        const soon = beforeDeadline(this)
        const { items, issues } = await helpers
          .connect(this, (remote) =>
            syncEach(
              this,
              remote.target,
              chosen,
              {
                ...(keep ? { keep } : {}),
                ...(allowDeletions ? { allowDeletions } : {}),
                ...(allowReplacements ? { allowReplacements } : {}),
                ...(args.repin ? { repin: true } : {}),
              },
              soon.signal,
            ),
          )
          .finally(soon.clear)
        const body = allOf(
          "mirrors sync",
          items.map((item) => snakeKeys(item)),
        )
        const stopped = items.some((item) => item.stopped)
        if (issues.length || stopped)
          body.meta = { ...body.meta, complete: false, ...(issues.length ? { issues } : {}) }
        if (stopped) body.next = resumeOf(this, "sync", items, soon.deadline, id)
        output(this, body)
        const stop = items
          .flatMap((item) => ("errors" in item ? item.errors : []))
          .find((error) => error.reason && STOPS.has(error.reason))
        if (stop)
          throw new CliError(stop.code === "confirmation_required" ? stop.code : "validation_error", stop.message, {
            reason: stop.reason,
          })
        if (issues.length)
          throw new CliError(
            "provider_error",
            `some files were not synced; see conflicts, unknown and errors, then settle each conflict with mirrors ` +
              `conflicts resolve, or rerun with --keep local, ${REMOTE} or both`,
            { reason: "mirror.partial" },
          )
      })

  const describeCycle = (cycle: Cycle) => {
    const time = cycle.at.slice(11, 19)
    if (cycle.error) return `${time} ${cycle.triggers.join("+")}: ${cycle.error.message}; trying again`
    const parts = (cycle.results ?? []).map(
      (result) =>
        `${result.id} ${result.uploaded.length} sent, ${result.downloaded.length} pulled, ` +
        (result.merged.length ? `${result.merged.length} merged, ` : "") +
        `${result.trashed.length} trashed` +
        (result.conflicts.length
          ? `, ${result.conflicts.length} conflicts (mirrors conflicts list ${result.id})`
          : "") +
        // A run the guard or a root problem stopped says why at every cycle, until the owner settles it.
        result.errors
          .filter((error) => error.path === ".")
          .map((error) => `; stopped: ${error.message}`)
          .join(""),
    )
    return `${time} ${cycle.triggers.join("+")}: ${parts.join("; ") || "nothing to do"}`
  }

  const watchCommand = () =>
    annotate(new Command("watch"), {
      effects: REMOTE_WRITE,
      offline: false,
      lifetime: "persistent",
      examples: [`${CLI} personal mirrors watch`, `${CLI} personal mirrors watch 1a2b3c4d --every 2m --jsonl`],
    })
      .summary("keep syncing both ways until Ctrl-C or --timeout")
      .description(
        `keep syncing both ways until Ctrl-C or --timeout: on each local save, and when ${service} changes; a file ` +
          "changed on both sides that cannot be merged is reported for mirrors conflicts",
      )
      .argument("[id]", `${ID}; every mirror of the profile when omitted`)
      .option("--every <duration>", `how often to ask ${service} whether anything changed`, helpers.every ?? "60s")
      .action(async function (this: Command, id: string | undefined, args: { every: string }) {
        const pollMs = parseDuration(args.every, "--every")
        if (pollMs < 10_000)
          throw new CliError("validation_error", "--every must be at least 10s", { param: "--every" })
        const chosen = homeOf(this).chosen(id)
        const environment = environmentOf(this)
        const { format, streams } = outputFor(this)
        // cli-core bounds a persistent command by nothing, so its --timeout is the watch's own to keep.
        const timeout = this.optsWithGlobals<{ timeout?: string }>().timeout
        const signal = AbortSignal.any(
          [
            environment.untilStopped?.(),
            timeout === undefined ? undefined : AbortSignal.timeout(parseDuration(timeout, "--timeout")),
          ].filter((one): one is AbortSignal => one !== undefined),
        )
        const print = (text: string) => streams.data(`${text}\n`)
        let cycles = 0
        await helpers.connect(
          this,
          async (remote) => {
            const engine = engineOf(this, remote.target, chosen)
            const local = async (mirrors: Mirror[]) =>
              (await fileMirrorStatus(mirrors, engine.stateOf))
                .filter((item) => item.upload.length || item.delete.length)
                .map((item) => item.id)
            for await (const event of watchMirrors((mirrors) => syncFileMirrors({ ...engine, mirrors }), {
              mirrors: chosen,
              signal,
              localChanges: local,
              remoteChanges: fileRemoteChanges(engine.target),
              pollMs,
            })) {
              cycles++
              const data: Cycle = {
                at: new Date().toISOString(),
                triggers: event.triggers,
                mirrors: event.mirrors,
                ...("error" in event
                  ? { error: { code: event.error.code, message: event.error.message } }
                  : {
                      results: event.result.items,
                      ...(event.result.issues.length ? { issues: event.result.issues } : {}),
                    }),
              }
              print(format === "pretty" ? describeCycle(data) : JSON.stringify({ type: "item", data: snakeKeys(data) }))
            }
          },
          { unbounded: true },
        )
        if (format === "pretty") return
        const end = listOf("mirrors watch", {
          items: [],
          limit: Math.max(1, cycles),
          has_more: false,
          paging: "cursor",
          meta: { complete: true },
        })
        for (const record of jsonlRecords(end)) print(JSON.stringify(record))
      })

  const versionsCommand = () =>
    notLocalPaths(annotate(new Command("versions"), { effects: LOCAL_READ, mcp: false }), "path")
      .summary("versions of mirrored files that syncs replaced or deleted")
      .description("the versions of a mirrored file that syncs replaced or deleted, kept on this computer")
      .addCommand(
        annotate(new Command("list"), {
          effects: LOCAL_READ,
          examples: [`${CLI} personal mirrors versions list 1a2b3c4d notes/plan.md --json`],
        })
          .summary("list what syncs did to a mirrored file, oldest first")
          .description("list what syncs did to a mirrored file, oldest first, and which versions are still kept")
          .argument("<id>", ID)
          .argument("<path>", PATH)
          .action(function (this: Command, id: string, input: string) {
            const home = homeOf(this)
            const mirror = home.find(id)
            const path = insideOf(mirror.path, input)
            output(
              this,
              allOf(
                "mirrors versions list",
                home
                  .versionsOf(mirror)
                  .list(path)
                  .map((one) => snakeKeys(one)),
              ),
            )
          }),
      )
      .addCommand(
        annotate(new Command("restore"), {
          effects: LOCAL_WRITE,
          examples: [`${CLI} personal mirrors versions restore 1a2b3c4d notes/plan.md 9f86d081…`],
        })
          .summary("put a kept version back into the local folder")
          .description(
            "put a kept version back into the local folder; the file there now is kept first, and the next mirrors " +
              `sync sends the restored one to ${service}`,
          )
          .argument("<id>", ID)
          .argument("<path>", PATH)
          .argument("<sha256>", "the version's hash, old or new in mirrors versions list")
          .action(async function (this: Command, id: string, input: string, sha256: string) {
            const home = homeOf(this)
            const mirror = home.find(id)
            const path = insideOf(mirror.path, input)
            if (!(await restoreFileVersion(mirror.path, path, sha256, home.versionsOf(mirror), home.lock)))
              throw new CliError(
                "not_found",
                "that version is no longer kept, or the file changed while it was restored; see mirrors versions list",
              )
            output(this, itemOf({ id, path, sha256, restored: true }))
          }),
      )

  /** `mirrors conflicts list|show|resolve` over this profile's mirrors; a resolve writes as a sync does. */
  const conflictsCommand = () =>
    fileConflictsCommand({
      identity,
      remote: REMOTE,
      output,
      mirrors: (command, id) => homeOf(command).chosen(id),
      pathOf: (mirror, input) => insideOf(mirror.path, input),
      stateOf: (command, mirror) => homeOf(command).stateOf(mirror as SavedMirror),
      versionsOf: (command, mirror) => homeOf(command).versionsOf(mirror),
      connect: (command, mirror, body) =>
        helpers.connect(command, (remote) => {
          const { target, principal, guard, operationId, lock, signal } = engineOf(command, remote.target, [
            mirror as SavedMirror,
          ])
          return body({ target, principal, guard, operationId, lock, ...(signal ? { signal } : {}) })
        }),
    })

  return annotate(new Command("mirrors"), { effects: LOCAL_READ })
    .description(`keep local folders and ${helpers.root.place}s the same, both ways, file by file`)
    .addCommand(addCommand())
    .addCommand(listCommand())
    .addCommand(statusCommand())
    .addCommand(previewCommand())
    .addCommand(syncCommand())
    .addCommand(watchCommand())
    .addCommand(updateCommand())
    .addCommand(removeCommand())
    .addCommand(versionsCommand())
    .addCommand(conflictsCommand())
}
