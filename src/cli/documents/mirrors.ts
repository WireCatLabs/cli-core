import { statSync } from "node:fs"
import { resolve } from "node:path"
import { CliError, isCliError, type RenderFormat } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { type Command, Option } from "commander"
import {
  type Keep,
  type Mirror,
  type MirrorSyncOptions,
  mirrorId,
  mirrorStatus,
  type PushStatePort,
  syncMirrors,
  watchMirrors,
} from "../../documents.js"
import { parseDuration } from "../../domain/duration.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { FETCH, LOCAL_READ, LOCAL_WRITE, REMOTE_WRITE } from "../effects.js"
import { type Body, itemOf, jsonlRecords, listOf } from "../envelope.js"
import { bindQuery, documentQueries, mirrorRow, termsOf } from "./queries.js"
import { allOf, type DocumentWords, examples, wordsOf } from "./words.js"

/** The provider, signed in for one `mirrors sync` or `mirrors watch`. */
export interface DocumentMirrorConnection<S> {
  /** What `syncMirrors` takes beside the mirrors, the state and the user's choices. */
  sync: Omit<MirrorSyncOptions<S>, "mirrors" | "keep" | "recreate" | "remote" | "stateOf">
  /** The provider's change feed, which `mirrors watch` polls. */
  startToken(): Promise<string>
  /**
   * The changes since `token`. Throws a `listing.too-large` CliError when the feed cannot go on from it (expired, or
   * over its bound): `mirrors watch` then starts a new feed and checks every mirror once.
   */
  changes(token: string): Promise<{ cursor: string; items: { id: string }[] }>
}

export interface DocumentMirrorCommands<S> {
  words: DocumentWords
  output(body: Body): void
  /** Prints one `mirrors watch` record in the run's format. */
  print(render: (format: RenderFormat, data: (text: string) => void) => void): void
  /** The selected profile, as messages name it. */
  profile(): string
  /** The selected profile's mirrors. */
  mirrors(): Mirror[]
  /** Replaces the selected profile's mirrors. */
  save(mirrors: Mirror[]): void
  /** Resolves `--parent` and checks it is a folder the account can write into; refuses anything else. */
  parent(input: string): Promise<{ id: string; name: string }>
  kindOf(path: string): string | undefined
  stateOf(mirror: Mirror): PushStatePort<S>
  connect(): Promise<DocumentMirrorConnection<S>>
  /** Ctrl-C or `--timeout` ends `mirrors watch` normally; its signal says when. */
  endsOnStop(): AbortSignal | undefined
}

const addDocumentMirrorCommandsDefinition = <S>(program: Command, helpers: DocumentMirrorCommands<S>) => {
  const { output } = helpers
  const wording = wordsOf(helpers.words)
  const { app, prefix, provider, remote, text } = wording
  const queries = documentQueries()
  const mirrors = annotate(program.command("mirrors"), { effects: LOCAL_READ }).description(text.mirrors)
  const find = (id: string): Mirror => {
    const mirror = helpers.mirrors().find((item) => item.id === id)
    if (!mirror)
      throw new CliError(
        "not_found",
        `no mirror ${id} in profile ${helpers.profile()}; see ${app} ${helpers.profile()} mirrors list`,
        {
          reason: "mirror.not-found",
        },
      )
    return mirror
  }
  const syncing = (connection: DocumentMirrorConnection<S>) => ({
    ...connection.sync,
    stateOf: (mirror: Mirror) => helpers.stateOf(mirror),
    remote,
  })
  const chosenOf = (id?: string) => {
    const name = helpers.profile()
    const chosen = id ? [find(id)] : helpers.mirrors()
    if (!chosen.length)
      throw new CliError("not_found", `profile ${name} has no mirrors; add one with ${app} ${name} mirrors add`, {
        reason: "mirror.none",
      })
    return chosen
  }

  examples(
    annotate(mirrors.command("add"), { effects: FETCH })
      .argument("<path>", "local folder to mirror")
      .requiredOption("--parent <id>", text.mirrorParent)
      .description(text.mirrorsAdd),
    [`${prefix} mirrors add ./notes --parent FOLDER_ID`],
  ).action(async (path: string, args: { parent: string }) => {
    const root = resolve(path)
    let directory = false
    try {
      directory = statSync(root).isDirectory()
    } catch {}
    if (!directory)
      throw new CliError("validation_error", "the path to mirror is not a folder", { reason: "mirror.not-folder" })
    const parent = await helpers.parent(args.parent)
    const folder = parent.id
    const id = mirrorId(root, folder)
    const list = helpers.mirrors()
    if (!list.some((mirror) => mirror.id === id)) list.push({ id, path: root, folder })
    helpers.save(list)
    output(itemOf({ id, path: root, folder, folder_name: parent.name, added: true }))
  })

  bindQuery(
    examples(annotate(mirrors.command("list"), { effects: LOCAL_READ }).description("list this profile's mirrors"), [
      `${prefix} mirrors list`,
    ]),
    queries.mirrors,
    mirrorRow,
  ).action((words: string[]) => {
    const filter = termsOf(words, queries.mirrors, "mirrors list")
    output(
      allOf(
        helpers
          .mirrors()
          .filter((row) => Object.entries(filter).every(([key, value]) => row[key as keyof Mirror] === value)),
      ),
    )
  })

  examples(
    annotate(mirrors.command("remove"), { effects: LOCAL_WRITE })
      .argument("<id>", "mirror id from mirrors list")
      .description(`stop mirroring a folder; nothing in ${wording.place} is changed or deleted`),
    [`${prefix} mirrors remove 1a2b3c4d`],
  ).action((id: string) => {
    find(id)
    helpers.save(helpers.mirrors().filter((mirror) => mirror.id !== id))
    output(itemOf({ id, removed: true }))
  })

  examples(
    annotate(mirrors.command("status"), { effects: LOCAL_READ })
      .argument("[id]", "mirror id; every mirror of the profile when omitted")
      .description(`show which local files the next sync would create or send; ${provider} is not asked`),
    [`${prefix} mirrors status`],
  ).action(async (id?: string) => {
    const items = await mirrorStatus(id ? [find(id)] : helpers.mirrors(), helpers.kindOf, (mirror) =>
      helpers.stateOf(mirror),
    )
    output(
      allOf(
        items.map(({ id, folder, create, update, unchanged, orphans, unsupported, remote_checked }) => ({
          id,
          folder,
          create: create.length,
          update: update.length,
          unchanged,
          orphans: orphans.length,
          unsupported,
          remote_checked,
        })),
      ),
    )
  })

  examples(
    annotate(mirrors.command("sync"), { effects: REMOTE_WRITE })
      .argument("[id]", "mirror id; every mirror of the profile when omitted")
      .addOption(
        new Option("--keep <side>", "where a part changed on both sides, keep this side").choices([
          "local",
          remote,
          "both",
        ]),
      )
      .option("--replace", `same as --keep local, and create again files deleted in ${provider}`)
      .description(text.mirrorsSync),
    [
      `${prefix} mirrors sync`,
      `${prefix} mirrors sync 1a2b3c4d --keep ${remote}`,
      `${prefix} mirrors sync 1a2b3c4d --replace`,
    ],
  ).action(async (id: string | undefined, args: { keep?: string; replace?: boolean }) => {
    const chosen = chosenOf(id)
    if (args.replace && args.keep && args.keep !== "local")
      throw new CliError(
        "validation_error",
        `--replace keeps the local side; it cannot be combined with --keep ${remote} or both`,
      )
    const keep = (args.replace ? "local" : args.keep === remote ? "remote" : args.keep) as Keep | undefined
    const connection = await helpers.connect()
    const { items, issues } = await syncMirrors({
      ...syncing(connection),
      mirrors: chosen,
      ...(keep ? { keep } : {}),
      recreate: args.replace === true,
    })
    const body = allOf(items)
    if (issues.length) body.meta = { complete: false, issues }
    output(body)
    if (issues.length)
      throw new CliError(
        "provider_error",
        `some files were not synced; see conflicts, missing and errors, then rerun with --keep local, ${remote} or both`,
        { reason: "mirror.partial" },
      )
  })

  examples(
    annotate(mirrors.command("watch"), { effects: REMOTE_WRITE, lifetime: "persistent" })
      .argument("[id]", "mirror id; every mirror of the profile when omitted")
      .option("--every <duration>", `how often to ask ${provider} for changes`, "60s")
      .summary("keep syncing both ways until Ctrl-C or --timeout")
      .description(
        `keep syncing both ways until Ctrl-C or --timeout: on each local save and each ${provider} change; ` +
          "a part changed on both sides is reported and left for mirrors sync --keep",
      ),
    [`${prefix} mirrors watch`, `${prefix} mirrors watch 1a2b3c4d --every 2m --jsonl`],
  ).action(async (id: string | undefined, args: { every: string }) => {
    const pollMs = parseDuration(args.every, "--every")
    if (pollMs < 10_000) throw new CliError("validation_error", "--every must be at least 10s")
    const chosen = chosenOf(id)
    const signal = helpers.endsOnStop() ?? new AbortController().signal
    const connection = await helpers.connect()
    const states = (mirror: Mirror) => helpers.stateOf(mirror)
    let token = await connection.startToken()
    const remoteChanges = async (): Promise<string[] | "all"> => {
      let changed: Set<string>
      try {
        const feed = await connection.changes(token)
        token = feed.cursor
        changed = new Set(feed.items.map((item) => item.id))
      } catch (error) {
        if (!isCliError(error) || error.details?.reason !== "listing.too-large") throw error
        token = await connection.startToken()
        return "all"
      }
      return chosen
        .filter((mirror) => Object.values(states(mirror).read().entries).some((entry) => changed.has(entry.id)))
        .map((mirror) => mirror.id)
    }
    let cycles = 0
    for await (const event of watchMirrors((mirrors) => syncMirrors({ ...syncing(connection), mirrors }), {
      mirrors: chosen,
      signal,
      kindOf: helpers.kindOf,
      stateOf: states,
      remoteChanges,
      pollMs,
    })) {
      cycles++
      const data = {
        at: new Date().toISOString(),
        triggers: event.triggers,
        mirrors: event.mirrors,
        ...("error" in event
          ? { error: { code: event.error.code, message: event.error.message } }
          : { results: event.result.items, ...(event.result.issues.length ? { issues: event.result.issues } : {}) }),
      }
      helpers.print((format, write) =>
        write(format === "pretty" ? describeCycle(data) : JSON.stringify({ type: "item", data })),
      )
    }
    helpers.print((format, write) => {
      if (format === "pretty") return
      const end = listOf("mirrors watch", {
        items: [],
        limit: Math.max(1, cycles),
        has_more: false,
        paging: "cursor",
        meta: { complete: true },
      })
      for (const record of jsonlRecords(end)) write(JSON.stringify(record))
    })
  })
}

const describeCycle = (cycle: {
  at: string
  triggers: string[]
  mirrors: string[]
  error?: { message: string }
  results?: { id: string; created: string[]; updated: string[]; pulled: string[]; conflicts: unknown[] }[]
}) => {
  const time = cycle.at.slice(11, 19)
  if (cycle.error) return `${time} ${cycle.triggers.join("+")}: ${cycle.error.message}; trying again`
  const parts = (cycle.results ?? []).map(
    (result) =>
      `${result.id} ${result.created.length} created, ${result.updated.length} sent, ${result.pulled.length} pulled` +
      (result.conflicts.length ? `, ${result.conflicts.length} conflicts (mirrors sync ${result.id} --keep …)` : ""),
  )
  return `${time} ${cycle.triggers.join("+")}: ${parts.join("; ") || "nothing to do"}`
}

/** `mirrors add|list|remove|status|sync|watch`: local folders kept in step with the provider both ways. */
export const addDocumentMirrorCommands = honoursDryRun(sharedCommand(addDocumentMirrorCommandsDefinition))
