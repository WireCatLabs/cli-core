import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import * as v from "valibot"
import {
  type CellValue,
  type DocxEdit,
  editDocxParagraphs,
  editXlsxCells,
  readDocxParagraphs,
  readXlsxCells,
  type XlsxEdit,
} from "../../office/index.js"
import { guardedFileWrite, remoteChanged } from "../../services/files/guarded-write.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf } from "../envelope.js"
import {
  addFileUpdateCommand,
  type FileUpdateCommands,
  type FileUpdatePort,
  replacedOf,
  sha256Of,
} from "./file-update.js"
import { examples, wordsOf } from "./words.js"

export interface FileEditCommands extends FileUpdateCommands {
  /**
   * The CLI's read path, signed in: the target and the profile's version store, for a command that changes nothing.
   * `command` is the one running.
   */
  read(act: (port: FileUpdatePort) => Promise<object>, command: Command): Promise<object>
  /**
   * `restore <path>` with no version: the CLI's own restore from the provider's trash, which answers what it did. A
   * CLI without one leaves it out, and the version is then required.
   */
  restoreFromTrash?(input: string, command: Command): Promise<object>
}

/** The whole file is held in memory to edit it. */
const MAX_OFFICE_BYTES = 64 * 1024 * 1024

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const inTemp = async <T>(act: (folder: string) => Promise<T>) => {
  const folder = await mkdtemp(join(tmpdir(), "wirecat-office-"))
  try {
    return await act(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

const downloaded = ({ target, signal }: FileUpdatePort, path: string) =>
  inTemp(async (folder) => {
    const into = join(folder, "file")
    await target.download(path, into, signal)
    const { size } = await stat(into)
    if (size > MAX_OFFICE_BYTES)
      throw new CliError("validation_error", `${path} is ${size} bytes; an Office file is read up to 64 MiB`, {
        reason: "file.too-large",
      })
    const bytes = new Uint8Array(await readFile(into))
    return { bytes, sha256: sha256(bytes) }
  })

const jsonOf = <T>(input: string, flag: string, schema: v.GenericSchema<unknown, T>, shape: string): T => {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new CliError("validation_error", `${flag} is not JSON; give ${shape}`, { param: flag })
  }
  const checked = v.safeParse(schema, parsed)
  if (!checked.success) throw new CliError("validation_error", `${flag} takes ${shape}`, { param: flag })
  return checked.output
}

const ADDRESS = /^([A-Z]{1,3})([1-9]\d{0,6})$/u
const CELLS = /^[A-Z]{1,3}[1-9]\d*(:[A-Z]{1,3}[1-9]\d*)?$/iu

const columnName = (column: number) => {
  let name = ""
  for (let left = column; left > 0; left = Math.floor((left - 1) / 26))
    name = String.fromCharCode(65 + ((left - 1) % 26)) + name
  return name
}

const cornerOf = (address: string) => {
  const match = ADDRESS.exec(address.toUpperCase())
  if (!match)
    throw new CliError("validation_error", `${address} is not a cell like B7`, { reason: "office.invalid-cell" })
  const letters = match[1] as string
  return {
    column: [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0),
    row: Number(match[2]),
  }
}

/** `Sheet1!A1:C10`, `'My sheet'!B2`, `Sheet1` or `A1:C10`, as the sheet and the cells. */
export const sheetRangeOf = (input: string | undefined): { sheet?: string; range?: string } => {
  if (!input) return {}
  const bang = input.lastIndexOf("!")
  const quoted = (name: string) => (/^'.*'$/u.test(name) ? name.slice(1, -1).replaceAll("''", "'") : name)
  if (bang >= 0) {
    const range = input.slice(bang + 1)
    return { sheet: quoted(input.slice(0, bang)), ...(range ? { range } : {}) }
  }
  return CELLS.test(input) ? { range: input } : { sheet: quoted(input) }
}

const VALUES = v.pipe(
  v.array(v.pipe(v.array(v.union([v.string(), v.number(), v.boolean(), v.null()])), v.minLength(1))),
  v.minLength(1),
)
const VALUES_SHAPE = 'rows of cell values as JSON, such as [["Total", 42], [null, true]]'

/** The cells `values` fills from the range's top-left cell; a range of more than one cell must have their shape. */
export const cellEditsOf = (sheet: string, range: string, values: CellValue[][]): XlsxEdit[] => {
  const [from, to] = range.split(":") as [string, string?]
  const start = cornerOf(from)
  if (to !== undefined) {
    const end = cornerOf(to)
    const rows = end.row - start.row + 1
    const columns = end.column - start.column + 1
    if (rows < 1 || columns < 1 || values.length !== rows || values.some((row) => row.length !== columns))
      throw new CliError(
        "validation_error",
        `${range} is ${rows} rows by ${columns} columns; --values must have that shape, or name only its first cell`,
        { param: "--values" },
      )
  }
  return values.flatMap((row, down) =>
    row.map((value, across) => ({ sheet, cell: `${columnName(start.column + across)}${start.row + down}`, value })),
  )
}

const PAYLOAD = v.pipe(
  v.array(
    v.union([
      v.strictObject({ index: v.pipe(v.number(), v.integer()), text: v.string() }),
      v.strictObject({
        insert_after: v.pipe(v.number(), v.integer()),
        text: v.string(),
        style_from: v.optional(v.pipe(v.number(), v.integer())),
      }),
      v.strictObject({ delete: v.pipe(v.number(), v.integer()) }),
    ]),
  ),
  v.minLength(1),
)
const PAYLOAD_SHAPE =
  'paragraph edits as JSON: [{"index": 3, "text": "…"}, {"insert_after": 5, "text": "…"}, {"delete": 7}]'

const docxEditsOf = (payload: v.InferOutput<typeof PAYLOAD>): DocxEdit[] =>
  payload.map((edit) => {
    if ("insert_after" in edit)
      return {
        insertAfter: edit.insert_after,
        text: edit.text,
        ...(edit.style_from === undefined ? {} : { styleFrom: edit.style_from }),
      }
    return edit
  })

const addFileEditCommandsDefinition = (files: Command, helpers: FileEditCommands) => {
  const { prefix, place } = wordsOf(helpers.words)
  const group = files.name()
  const deleteKey = helpers.deleteKey ?? "files.delete"
  const show = (kind: "sheets" | "documents", input: string) => `${prefix} ${group} ${kind} show ${input}`

  /** Downloads the file, edits it only at the sha256 it was read at, and writes it back as `files update` does. */
  const editInPlace = async (
    command: Command,
    kind: "sheets" | "documents",
    input: string,
    fingerprint: string | undefined,
    edit: (bytes: Uint8Array) => Promise<{ bytes: Uint8Array; answer: object }>,
  ) => {
    const reread = show(kind, input)
    const expected = sha256Of(fingerprint)
    if (expected === undefined)
      throw new CliError(
        "validation_error",
        `read the file first (${reread}) and pass its sha256 as --expected-fingerprint`,
        {
          param: "--expected-fingerprint",
        },
      )
    const path = helpers.path(input)
    const answer = await helpers.write(
      [deleteKey],
      async (port) => {
        const read = await downloaded(port, path)
        if (read.sha256 !== expected) throw remoteChanged(path, "changed since it was read", reread)
        const edited = await edit(read.bytes)
        return inTemp(async (folder) => {
          const from = join(folder, "edited")
          await writeFile(from, edited.bytes, { mode: 0o600 })
          const { target, versions, signal } = port
          const done = await guardedFileWrite({
            target,
            versions,
            path,
            from,
            expected,
            reread,
            ...(signal ? { signal } : {}),
          })
          return { path, sha256: done.file.sha256 ?? null, replaced: replacedOf(done, versions), ...edited.answer }
        })
      },
      command,
    )
    helpers.output(itemOf(answer), command)
  }

  const readOffice = async (command: Command, input: string, answer: (bytes: Uint8Array) => Promise<object>) => {
    const path = helpers.path(input)
    const item = await helpers.read(async (port) => {
      const read = await downloaded(port, path)
      return { path, sha256: read.sha256, ...(await answer(read.bytes)) }
    }, command)
    helpers.output(itemOf(item), command)
  }

  const sheets = annotate(files.command("sheets"), { effects: REMOTE_READ }).description(
    `the cells of an Excel workbook (.xlsx) on ${place}, read and changed in place`,
  )
  examples(
    annotate(sheets.command("show"), { effects: REMOTE_READ, offline: false })
      .summary("show a workbook's cells and the sha256 to edit them at")
      .description(
        "show a workbook's stored cells, each with its value, type, formula and format, and the file's sha256 to pass " +
          "as --expected-fingerprint to sheets update. Formulas show the value Excel saved last",
      )
      .argument("<path>", `the .xlsx file on ${place}`)
      .argument(
        "[range]",
        "the cells to show: Sheet1!A1:C10, a sheet's name, or A1:C10 on every sheet; all without it",
      ),
    [`${prefix} ${group} sheets show /budget.xlsx "Sheet1!A1:C10"`, `${prefix} ${group} sheets show /budget.xlsx`],
  ).action(async function (this: Command, input: string, range: string | undefined) {
    const wanted = sheetRangeOf(range)
    await readOffice(this, input, async (bytes) => ({
      sheets: (await readXlsxCells(bytes, wanted)).map((sheet) => ({
        name: sheet.name,
        cells: sheet.cells.map((cell) => ({
          address: cell.address,
          row: cell.row,
          column: cell.column,
          value: cell.value,
          type: cell.type,
          ...(cell.formula === undefined ? {} : { formula: cell.formula }),
          style: cell.style,
        })),
      })),
    }))
  })

  examples(
    annotate(sheets.command("update"), { effects: REMOTE_WRITE, offline: false })
      .summary("write values into a workbook's cells, at the sha256 it was read at")
      .description(
        "write values into a workbook's cells in place: the rest of the file, its formatting and its other sheets " +
          `stay as they are. It needs --expected-fingerprint from sheets show and asks as ${deleteKey} does; what it ` +
          "replaced is kept on this computer (see history). A text is written as text, even one that starts with =. " +
          "A formula cell is refused unless --replace",
      )
      .argument("<path>", `the .xlsx file on ${place}`)
      .argument(
        "<range>",
        "where the values go: Sheet1!B2:C3, or its first cell Sheet1!B2; the sheet may be left out when there is one",
      )
      .option("--values <json>", "the cell values as JSON rows; null empties a cell")
      .option("--expected-fingerprint <hash>", "the sha256 sheets show gave for the file")
      .option("--replace", "replace a formula with the value instead of refusing it"),
    [
      `${prefix} ${group} sheets update /budget.xlsx "Sheet1!B2:C2" --values '[[120, "paid"]]' --expected-fingerprint 9f86d081…`,
    ],
  ).action(async function (
    this: Command,
    input: string,
    range: string,
    args: { values?: string; expectedFingerprint?: string; replace?: boolean },
  ) {
    if (args.values === undefined)
      throw new CliError("validation_error", `give the cells' values with --values: ${VALUES_SHAPE}`, {
        param: "--values",
      })
    const values = jsonOf(args.values, "--values", VALUES, VALUES_SHAPE)
    const wanted = sheetRangeOf(range)
    if (wanted.range === undefined)
      throw new CliError("validation_error", `${range} names no cell; give one like Sheet1!B2`, {
        reason: "office.invalid-cell",
      })
    cellEditsOf("", wanted.range, values)
    await editInPlace(this, "sheets", input, args.expectedFingerprint, async (bytes) => {
      let sheet = wanted.sheet
      if (sheet === undefined) {
        const names = (await readXlsxCells(bytes, { range: "A1" })).map((one) => one.name)
        if (names.length !== 1)
          throw new CliError(
            "validation_error",
            `the workbook has ${names.length} sheets (${names.map((name) => `"${name}"`).join(", ")}); name one, like ${names[0] ?? "Sheet1"}!${wanted.range}`,
            { reason: "office.no-sheet" },
          )
        sheet = names[0] as string
      }
      try {
        const done = await editXlsxCells(bytes, cellEditsOf(sheet, wanted.range as string, values), {
          overwriteFormulas: args.replace === true,
        })
        return {
          bytes: done.bytes,
          answer: {
            changed: done.changed,
            calc_chain_dropped: done.calcChainDropped,
            warnings: done.calcChainDropped
              ? ["a formula was replaced, so Excel rebuilds the workbook's calculation order when it opens it"]
              : [],
          },
        }
      } catch (error) {
        if (isCliError(error) && error.details?.reason === "office.formula-cell")
          throw new CliError(
            "validation_error",
            error.message.replace("pass overwriteFormulas", "pass --replace"),
            error.details,
          )
        throw error
      }
    })
  })

  const documents = annotate(files.command("documents"), { effects: REMOTE_READ }).description(
    `the paragraphs of a Word document (.docx) on ${place}, read and changed in place`,
  )
  examples(
    annotate(documents.command("show"), { effects: REMOTE_READ, offline: false })
      .summary("show a document's paragraphs and the sha256 to edit them at")
      .description(
        "show a Word document's paragraphs by index, with their style, whether each can be edited and why not, and " +
          "the file's sha256 to pass as --expected-fingerprint to documents update",
      )
      .argument("<path>", `the .docx file on ${place}`),
    [`${prefix} ${group} documents show /report.docx`],
  ).action(async function (this: Command, input: string) {
    await readOffice(this, input, async (bytes) => ({
      paragraphs: (await readDocxParagraphs(bytes)).map((paragraph) => ({
        index: paragraph.index,
        text: paragraph.text,
        ...(paragraph.styleId === undefined ? {} : { style_id: paragraph.styleId }),
        ...(paragraph.style === undefined ? {} : { style: paragraph.style }),
        location: paragraph.location,
        editable: paragraph.editable,
        ...(paragraph.reason === undefined ? {} : { reason: paragraph.reason }),
        mixed_formatting: paragraph.mixedFormatting,
      })),
    }))
  })

  examples(
    annotate(documents.command("update"), { effects: REMOTE_WRITE, offline: false })
      .summary("replace, insert or delete paragraphs, at the sha256 it was read at")
      .description(
        "replace, insert or delete a Word document's paragraphs in place; the rest of the file stays as it is. " +
          "Indexes are the ones documents show gave. It needs --expected-fingerprint from documents show and asks as " +
          `${deleteKey} does; what it replaced is kept on this computer (see history). A paragraph that is not ` +
          "editable is refused with its reason, and a replaced one with mixed formatting takes its first run's",
      )
      .argument("<path>", `the .docx file on ${place}`)
      .option("--payload <json>", "the edits as JSON: {index, text}, {insert_after, text, style_from?} or {delete}")
      .option("--expected-fingerprint <hash>", "the sha256 documents show gave for the file"),
    [
      `${prefix} ${group} documents update /report.docx --payload '[{"index": 2, "text": "Revenue grew 12%."}]' --expected-fingerprint 9f86d081…`,
    ],
  ).action(async function (this: Command, input: string, args: { payload?: string; expectedFingerprint?: string }) {
    if (args.payload === undefined)
      throw new CliError("validation_error", `give the edits with --payload: ${PAYLOAD_SHAPE}`, { param: "--payload" })
    const edits = docxEditsOf(jsonOf(args.payload, "--payload", PAYLOAD, PAYLOAD_SHAPE))
    await editInPlace(this, "documents", input, args.expectedFingerprint, async (bytes) => {
      const done = await editDocxParagraphs(bytes, edits)
      return {
        bytes: done.bytes,
        answer: {
          paragraphs: { replaced: done.replaced, inserted: done.inserted, deleted: done.deleted },
          warnings: done.collapsed.map(
            (index) => `paragraph ${index} had mixed formatting; its new text has its first run's formatting`,
          ),
        },
      }
    })
  })

  examples(
    annotate(files.command("history"), { effects: REMOTE_READ, offline: false })
      .summary("list the earlier versions of a file kept on this computer")
      .description(
        "list what the writes and syncs of this profile replaced in a file, newest last. Each entry's version is the " +
          `sha256 of the content it replaced, kept on this computer while available is true; ${group} restore puts it back`,
      )
      .argument("<path>", `the file on ${place}`),
    [`${prefix} ${group} history /budget.xlsx`],
  ).action(async function (this: Command, input: string) {
    const path = helpers.path(input)
    const item = await helpers.read(
      async ({ versions }) => ({
        path,
        versions: versions.list(path).map((event) => ({
          at: event.at,
          event: event.event,
          direction: event.direction,
          version: event.old ?? null,
          available: event.available,
          ...(event.new === undefined ? {} : { new: event.new }),
          ...(event.size === undefined ? {} : { size: event.size }),
          ...(event.to === undefined ? {} : { to: event.to }),
          ...(event.oldIn === undefined ? {} : { old_in: event.oldIn }),
        })),
      }),
      this,
    )
    helpers.output(itemOf(item), this)
  })

  const trash = helpers.restoreFromTrash
  examples(
    annotate(files.command("restore"), { effects: REMOTE_WRITE, offline: false })
      .summary(
        trash
          ? "bring a file back from the trash, or put back a version kept here"
          : "put back a version of a file kept here",
      )
      .description(
        `${trash ? `with no version, bring a file or folder back from ${place}'s trash. With one, put` : "put"} back ` +
          `a version history lists: it is written as ${group} update writes, so a file there needs ` +
          `--expected-fingerprint, asks as ${deleteKey} does, and is kept first`,
      )
      .argument("<path>", trash ? `the file on ${place}, or its path in the trash` : `the file on ${place}`)
      .argument(trash ? "[version]" : "<version>", "the version's sha256, from history")
      .option("--expected-fingerprint <hash>", "the sha256 the file has now; required when it exists"),
    [`${prefix} ${group} restore /budget.xlsx 2c26b46b… --expected-fingerprint 9f86d081…`],
  ).action(async function (
    this: Command,
    input: string,
    versionInput: string | undefined,
    args: { expectedFingerprint?: string },
  ) {
    if (versionInput === undefined) {
      if (!trash) throw new CliError("validation_error", `give the version from ${group} history`, { param: "version" })
      helpers.output(itemOf(await trash(input, this)), this)
      return
    }
    const version = sha256Of(versionInput, "the version") as string
    const expected = sha256Of(args.expectedFingerprint)
    const path = helpers.path(input)
    const reread = helpers.reread(input)
    const answer = await helpers.write(
      expected ? [deleteKey] : [],
      async ({ target, versions, signal }) =>
        inTemp(async (folder) => {
          const from = join(folder, "version")
          if (!(await versions.write(version, from)))
            throw new CliError(
              "not_found",
              `version ${version} of ${path} is no longer kept here; see ${group} history`,
              {
                reason: "item.not-found",
              },
            )
          const done = await guardedFileWrite({
            target,
            versions,
            path,
            from,
            reread,
            direction: "restored",
            ...(expected ? { expected } : {}),
            ...(signal ? { signal } : {}),
          })
          return { path, sha256: done.file.sha256 ?? null, restored: version, replaced: replacedOf(done, versions) }
        }),
      this,
    )
    helpers.output(itemOf(answer), this)
  })

  addFileUpdateCommand(files, helpers)
}

/**
 * Mounts `<files> update`, `sheets show|update`, `documents show|update`, `history` and `restore` under the CLI's own
 * files group: Office files edited in place and earlier versions put back, every write at the sha256 it was read at
 * and with the replaced content kept (`guardedFileWrite`). The CLI keeps no `restore` of its own; a trash restore
 * goes in as `restoreFromTrash`.
 */
export const addFileEditCommands = honoursDryRun(sharedCommand(addFileEditCommandsDefinition))
