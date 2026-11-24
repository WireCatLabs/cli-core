import { resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import {
  type FileConflictResolveOptions,
  type FileMirrorStatePort,
  type FileVersions,
  type Keep,
  listFileConflicts,
  type Mirror,
  resolveFileConflict,
  showFileConflict,
} from "../../documents.js"
import type { AppIdentity } from "../../ports/app.js"
import { refusedPlace } from "../../sends/upload.js"
import { environmentOf } from "../context.js"
import { LOCAL_READ, ownerOnlyOption, REMOTE_WRITE } from "../effects.js"
import { type Body, itemOf, listOf, snakeKeys } from "../envelope.js"
import { marksUntrusted } from "../untrusted-marks.js"

/** What a file-mirror CLI gives `fileConflictsCommand`: its mirrors, their state and stores, and its remote. */
export interface FileConflictCommands {
  /** Who the app is: its command names the examples, its folders are never read by `--file`. */
  identity: AppIdentity
  /** How the app names the remote side, `disk` for Yandex Disk: `--keep`'s other choice and a kept copy's name. */
  remote: string
  output(command: Command, body: Body): void
  /** The profile's mirrors, or the one with `id`; unknown ids and a profile without mirrors are refused. */
  mirrors(command: Command, id?: string): Mirror[]
  /** A path as the owner typed it (relative, or absolute inside the mirror), as a path inside the mirror. */
  pathOf(mirror: Mirror, input: string): string
  stateOf(command: Command, mirror: Mirror): FileMirrorStatePort
  versionsOf(command: Command, mirror: Mirror): FileVersions
  /**
   * Runs `body` inside the app's run (its `--timeout`, run record and request log) with the remote signed in for the
   * mirror's account, the write guard and the mirrors' sync lock; answers what `body` answered.
   */
  connect<T>(command: Command, mirror: Mirror, body: (connection: FileConflictConnection) => Promise<T>): Promise<T>
}

/** What `connect` hands `mirrors conflicts resolve`. */
export type FileConflictConnection = Pick<
  FileConflictResolveOptions,
  "target" | "principal" | "guard" | "operationId" | "lock" | "signal"
>

const ID = "mirror id from mirrors list"
const PATH = "the file's path inside the mirror, like notes/plan.md"
const CONFLICT_UNTRUSTED = [
  "path",
  "base.text",
  "local.text",
  "remote.text",
  "merged",
  "hunks.base",
  "hunks.local",
  "hunks.remote",
]

/**
 * `mirrors conflicts list|show|resolve` for a file mirror: the conflicts the last sync left, each with its three
 * versions and the line merge that failed, and a resolution that writes one final content to both sides.
 */
export const fileConflictsCommand = (helpers: FileConflictCommands): Command => {
  const { remote, identity } = helpers
  const app = identity.command
  const one = (command: Command, id: string) => helpers.mirrors(command, id)[0] as Mirror
  return annotate(new Command("conflicts"), { effects: LOCAL_READ })
    .summary("files changed on both sides that a sync could not merge")
    .description(
      `files changed on both sides that a sync could not merge: list them, show the three versions and the lines ` +
        `that conflict, and resolve each by keeping a side or giving the final file`,
    )
    .addCommand(
      marksUntrusted(
        annotate(new Command("list"), {
          effects: LOCAL_READ,
          examples: [`${app} personal mirrors conflicts list --json`],
        }),
        ["path"],
      )
        .summary("list the conflicts the last sync left")
        .description("list the conflicts each mirror's last sync left, with why and when it found them")
        .argument("[id]", `${ID}; every mirror of the profile when omitted`)
        .action(function (this: Command, id: string | undefined) {
          const items = listFileConflicts(helpers.mirrors(this, id), (mirror) => helpers.stateOf(this, mirror))
          helpers.output(
            this,
            listOf("mirrors conflicts list", {
              items: items.map((item) => snakeKeys(item)),
              limit: Math.max(1, items.length),
              has_more: false,
            }),
          )
        }),
    )
    .addCommand(
      // The remote side is someone else's, and the base and the merge hold it too.
      marksUntrusted(
        annotate(new Command("show"), {
          effects: LOCAL_READ,
          examples: [`${app} personal mirrors conflicts show 1a2b3c4d notes/plan.md --json`],
        }),
        CONFLICT_UNTRUSTED,
      )
        .summary("show a conflict's three versions and the lines that conflict")
        .description(
          "show a conflict's three versions (the last sync's, the local and the remote) and each changed stretch " +
            "of the line merge; merged is the whole file with conflict markers, a start for resolve --file",
        )
        .argument("<id>", ID)
        .argument("<path>", PATH)
        .action(async function (this: Command, id: string, input: string) {
          const mirror = one(this, id)
          const view = await showFileConflict({
            root: mirror.path,
            path: helpers.pathOf(mirror, input),
            state: helpers.stateOf(this, mirror),
            versions: helpers.versionsOf(this, mirror),
            remote,
          })
          helpers.output(this, itemOf(snakeKeys({ id, ...view })))
        }),
    )
    .addCommand(
      annotate(new Command("resolve"), {
        effects: REMOTE_WRITE,
        offline: false,
        examples: [
          `${app} personal mirrors conflicts resolve 1a2b3c4d notes/plan.md --keep ${remote}`,
          `${app} personal mirrors conflicts resolve 1a2b3c4d notes/plan.md --file ~/plan-final.md`,
        ],
      })
        .summary("settle a conflict on both sides: keep a side, both, or the final file")
        .description(
          `settle a conflict on both sides at once: keep the local file, the ${remote}'s, or both (the ${remote}'s ` +
            `beside the local one), or give the final file. Refused with nothing written when either side changed ` +
            "since the conflict was found; every replaced version is kept",
        )
        .argument("<id>", ID)
        .argument("<path>", PATH)
        .addOption(
          new Option("--keep <side>", `keep the local file, the ${remote}'s, or both`).choices([
            "local",
            remote,
            "both",
          ]),
        )
        .addOption(ownerOnlyOption("--file <file>", "the final content, written to both sides"))
        .action(async function (this: Command, id: string, input: string, args: { keep?: string; file?: string }) {
          if ((args.keep === undefined) === (args.file === undefined))
            throw new CliError("validation_error", "give either --keep or --file", { param: "--keep" })
          const file = args.file === undefined ? undefined : resolve(args.file)
          if (file && refusedPlace(file, identity, environmentOf(this).env ?? process.env))
            throw new CliError("validation_error", `--file may not read ${file}: it holds sign-ins or state`, {
              param: "--file",
            })
          const mirror = one(this, id)
          const keep = (args.keep === remote ? "remote" : args.keep) as Keep | undefined
          const path = helpers.pathOf(mirror, input)
          const resolved = await helpers.connect(this, mirror, (connection) =>
            resolveFileConflict({
              ...connection,
              root: mirror.path,
              folder: mirror.folder,
              path,
              state: helpers.stateOf(this, mirror),
              versions: helpers.versionsOf(this, mirror),
              remote,
              choice: keep ? { keep } : { file: file as string },
            }),
          )
          const resolution = resolved.resolution === "remote" ? remote : resolved.resolution
          helpers.output(this, itemOf(snakeKeys({ id, ...resolved, resolution })))
        }),
    )
}
