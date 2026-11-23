import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import type { FileTarget } from "../../documents/file-mirror-model.js"
import { type GuardedFileWriteResult, guardedFileWrite } from "../../services/files/guarded-write.js"
import type { FileVersions } from "../../services/files/versions.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { REMOTE_WRITE } from "../effects.js"
import { type Body, itemOf } from "../envelope.js"
import { bufferedInput, MAX_BUFFERED_INPUT } from "../input-policy.js"
import { type DocumentWords, examples, wordsOf } from "./words.js"

/** What `files update` writes through, signed in for one run. */
export interface FileUpdatePort {
  target: FileTarget
  /** The profile's version store, under its state folder. */
  versions: FileVersions
  signal?: AbortSignal
}

export interface FileUpdateCommands {
  words: DocumentWords
  output(body: Body): void
  /** What the user typed, as the target's path. */
  path(input: string): string
  /** The command that reads the file and its sha256 again, for a conflict's message (`ydisk personal files show …`). */
  reread(input: string): string
  /** Read for the text when --text is absent. */
  stdin(): NodeJS.ReadableStream | undefined
  /**
   * The CLI's own write path: its permission key for the command and `extra` (the delete key when a file is
   * replaced), its run and send journal. Answers what `act` answered, with whatever the CLI adds (`operation_id`).
   */
  write(extra: readonly string[], act: (port: FileUpdatePort) => Promise<object>): Promise<object>
  /** The key an overwrite also asks; `files.delete` when absent. */
  deleteKey?: string
}

const SHA256 = /^[0-9a-f]{64}$/u

// A read gives the text extracted from these, never the file itself: written back, it would replace the whole file.
const EXTRACTED = /\.(pdf|docx|xlsx)$/iu

/** A sha256 the user typed, in lower case; `flag` names it in the refusal. */
export const sha256Of = (input: string | undefined, flag = "--expected-fingerprint") => {
  const hash = input?.toLowerCase()
  if (hash !== undefined && !SHA256.test(hash))
    throw new CliError("validation_error", `${flag} takes a 64-character sha256`, { param: flag })
  return hash
}

/** The answer's `replaced`: the old sha256 and where its copy is kept, or null when nothing was there. */
export const replacedOf = (done: GuardedFileWriteResult, versions: FileVersions) =>
  done.replaced
    ? {
        sha256: done.replaced.sha256,
        ...(versions.dir ? { kept_at: join(versions.dir, "objects", done.replaced.sha256) } : {}),
      }
    : null

const newText = async (input: NodeJS.ReadableStream | undefined, text: string | undefined) => {
  if (text !== undefined) return text
  if (!input || (input as { isTTY?: boolean }).isTTY)
    throw new CliError("validation_error", "give the new text with --text or on stdin", { param: "--text" })
  const read = await bufferedInput(input, { maxBytes: MAX_BUFFERED_INPUT })
  // An agent over MCP has no stdin: an empty one is a missing --text, not a wish to empty the file.
  if (read.length === 0)
    throw new CliError("validation_error", "stdin gave no text; give the new text with --text or on stdin", {
      param: "--text",
    })
  return read.toString("utf8")
}

const addFileUpdateCommandDefinition = (files: Command, helpers: FileUpdateCommands) => {
  const { prefix, place } = wordsOf(helpers.words)
  const group = files.name()
  const deleteKey = helpers.deleteKey ?? "files.delete"
  return examples(
    annotate(files.command("update"), { effects: REMOTE_WRITE, offline: false })
      .summary(`replace a ${place} file's text, or create a text file`)
      .description(
        `replace a ${place} file's text, or create a text file. A file already there is replaced only with ` +
          `--expected-fingerprint, the sha256 read from it; it asks as ${deleteKey} does. The file is checked just ` +
          "before the write, and what it replaced is kept on this computer. Write back only a whole plain-text file: " +
          "a text cut with truncated: true would replace the whole file, and a .pdf, .docx or .xlsx is refused",
      )
      .argument("<path>", `the file on ${place}`)
      .option("--text <text>", "the file's new text; without it, the text is read from stdin")
      .option("--expected-fingerprint <hash>", "the sha256 the file had when it was read; required when it exists"),
    [
      `${prefix} ${group} update /notes.md --text "# Notes"`,
      `${prefix} ${group} update /notes.md --text "# Notes" --expected-fingerprint 9f86d081…`,
    ],
  ).action(async (input: string, args: { text?: string; expectedFingerprint?: string }) => {
    const expected = sha256Of(args.expectedFingerprint)
    const path = helpers.path(input)
    if (EXTRACTED.test(path))
      throw new CliError(
        "validation_error",
        `${path} is not a plain-text file; change a .docx with ${group} documents update and a .xlsx with ${group} ` +
          "sheets update, where a CLI has them",
        { reason: "file.not-plain-text" },
      )
    const text = await newText(helpers.stdin(), args.text)
    const answer = await helpers.write(expected ? [deleteKey] : [], async ({ target, versions, signal }) => {
      const folder = await mkdtemp(join(tmpdir(), "wirecat-update-"))
      try {
        const from = join(folder, "text")
        await writeFile(from, text, { mode: 0o600 })
        const done = await guardedFileWrite({
          target,
          versions,
          path,
          from,
          reread: helpers.reread(input),
          ...(expected ? { expected } : {}),
          ...(signal ? { signal } : {}),
        })
        return {
          path,
          sha256: done.file.sha256 ?? null,
          replaced: replacedOf(done, versions),
        }
      } finally {
        await rm(folder, { recursive: true, force: true })
      }
    })
    helpers.output(itemOf(answer))
  })
}

/**
 * `<files> update <path> (--text | stdin) [--expected-fingerprint <sha256>]`: a text written over a file only at the
 * content it was read at, the replaced content kept in the profile's version store (`guardedFileWrite`).
 */
export const addFileUpdateCommand = honoursDryRun(sharedCommand(addFileUpdateCommandDefinition))
