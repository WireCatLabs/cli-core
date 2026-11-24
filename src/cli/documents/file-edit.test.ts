import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, errorObjectOf } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { FileTarget } from "../../documents/file-mirror-model.js"
import { failureContext } from "../../errors/reasons.js"
import { readDocxParagraphs, readXlsxCells } from "../../office/index.js"
import { fileVersions } from "../../services/files/versions.js"
import { commandPathOf } from "../command-contract.js"
import type { Body } from "../envelope.js"
import { addFileEditCommands, cellEditsOf, sheetRangeOf } from "./file-edit.js"

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../testing/fixtures/${name}`, import.meta.url)))
const budget = fixture("budget.xlsx")
const letter = fixture("letter.docx")
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** The letter with a tracked-change paragraph after "Plain second paragraph.", at index 3. */
const tracked = () => {
  const files = unzipSync(letter)
  const xml = strFromU8(files["word/document.xml"] as Uint8Array)
  files["word/document.xml"] = strToU8(
    xml.replace(
      "Plain second paragraph.</w:t></w:r></w:p>",
      '$&<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>added</w:t></w:r></w:ins></w:p>',
    ),
  )
  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) })
}

/** A provider in memory with no conditional upload: `upload` checks `expect` itself, as a real target does. */
const harness = (start: Record<string, Uint8Array | string> = {}, creates?: boolean) => {
  const files = new Map<string, Uint8Array>(
    Object.entries({ "/budget.xlsx": budget, "/letter.docx": letter, ...start }).map(([path, bytes]) => [
      path,
      typeof bytes === "string" ? strToU8(bytes) : bytes,
    ]),
  )
  const uploads: string[] = []
  const target: FileTarget = {
    identity: async () => "fake",
    list: async () => undefined,
    exists: async (path) => files.has(path),
    download: async (path, into) => writeFileSync(into, files.get(path) ?? new Uint8Array(), { flag: "wx" }),
    upload: async (path, from, expect) => {
      const here = files.get(path)
      const ok = "absent" in expect ? here === undefined : here !== undefined && sha256(here) === expect.sha256
      if (!ok) throw new CliError("conflict", "the remote file is not as expected")
      const bytes = new Uint8Array(await readFile(from))
      uploads.push(path)
      files.set(path, bytes)
      return { path, id: `id-${path}`, size: bytes.length, sha256: sha256(bytes), modifiedAt: "2026-11-23T00:00:00Z" }
    },
    trash: async () => {},
    ensureFolder: async () => {},
  }
  const versions = fileVersions(join(mkdtempSync(join(tmpdir(), "file-edit-")), "files.versions"))
  const asked: (readonly string[])[] = []
  const ran: string[] = []
  const running = (command: Command) => ran.push(commandPathOf(command).join(" "))
  const answers: Body[] = []
  const trashed: string[] = []
  const group = new Command("files").exitOverride()
  addFileEditCommands(group, {
    words: { app: "disk", remote: "disk", provider: "Disk", source: "disk" },
    output: (body) => answers.push(body),
    path: (input) => input,
    reread: (input) => `disk personal files show ${input}`,
    stdin: () => undefined,
    read: (act, command) => {
      running(command)
      return act({ target, versions })
    },
    write: async (extra, act, command) => {
      running(command)
      asked.push(extra)
      return { operation_id: "op-1", ...(await act({ target, versions })) }
    },
    restoreFromTrash: async (input, command) => {
      running(command)
      trashed.push(input)
      return { path: input, restored: "trash" }
    },
    ...(creates === undefined ? {} : { creates }),
  })
  const run = (...argv: string[]) => group.parseAsync(argv, { from: "user" })
  const item = <T = Record<string, unknown>>() => (answers.at(-1) as { item: T }).item
  const command = (...path: string[]) =>
    path.reduce((at, name) => at.commands.find((child) => child.name() === name) as Command, group)
  return { files, uploads, versions, asked, ran, trashed, run, item, command }
}

describe("files sheets", () => {
  it("shows a range's cells with the file's sha256, which update takes to write values in place", async () => {
    const disk = harness()
    await disk.run("sheets", "show", "/budget.xlsx", "'Synthetic Budget'!A2:B4")
    const shown = disk.item<{ sha256: string; sheets: { name: string; cells: { address: string }[] }[] }>()
    expect(shown.sha256).toBe(sha256(budget))
    expect(shown.sheets[0]?.cells.map((cell) => cell.address)).toContain("B4")
    expect(disk.uploads).toEqual([])

    await disk.run(
      "sheets",
      "update",
      "/budget.xlsx",
      "A2:B2",
      "--values",
      '[["Lease", 950]]',
      "--expected-fingerprint",
      shown.sha256,
    )
    const item = disk.item<{ changed: unknown[]; replaced: { sha256: string; kept_at: string }; sha256: string }>()
    expect(item.changed).toMatchObject([
      { sheet: "Synthetic Budget", cell: "A2", before: "Rent", after: "Lease" },
      { sheet: "Synthetic Budget", cell: "B2", after: 950 },
    ])
    expect(disk.asked).toEqual([["files.delete"]])
    expect(disk.ran).toEqual(["sheets show", "sheets update"])
    expect(item.replaced.sha256).toBe(sha256(budget))
    expect(readFileSync(item.replaced.kept_at)).toEqual(Buffer.from(budget))
    const [sheet] = await readXlsxCells(disk.files.get("/budget.xlsx") as Uint8Array, { range: "A2:B2" })
    expect(sheet?.cells.map((cell) => cell.value)).toEqual(["Lease", 950])
    expect(item.sha256).toBe(sha256(disk.files.get("/budget.xlsx") as Uint8Array))
  })

  it("a stale sha256 is a conflict that says how to read the file again, and nothing is uploaded", async () => {
    const disk = harness()
    const stale = disk.run(
      "sheets",
      "update",
      "/budget.xlsx",
      "B2",
      "--values",
      "[[1]]",
      "--expected-fingerprint",
      sha256("old"),
    )
    await expect(stale).rejects.toMatchObject({ code: "conflict", details: { reason: "mirror.remote-changed" } })
    await expect(stale).rejects.toThrow("disk personal files sheets show /budget.xlsx")
    await expect(disk.run("sheets", "update", "/budget.xlsx", "B2", "--values", "[[1]]")).rejects.toThrow(
      /pass its sha256 as --expected-fingerprint/,
    )
    expect(disk.uploads).toEqual([])
  })

  it("a formula cell is refused with the flag that replaces it, and --replace writes the value", async () => {
    const disk = harness()
    const args = [
      "sheets",
      "update",
      "/budget.xlsx",
      "B4",
      "--values",
      "[[5]]",
      "--expected-fingerprint",
      sha256(budget),
    ]
    const refused = disk.run(...args)
    await expect(refused).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "office.formula-cell" },
    })
    await expect(refused).rejects.toThrow("pass --replace")
    const shown = errorObjectOf(await refused.catch((error: unknown) => error), failureContext())
    expect(shown.error).toMatchObject({ code: "validation_error", reason: "office.formula-cell" })
    expect(disk.uploads).toEqual([])
    await disk.run(...args, "--replace")
    expect(disk.item()).toMatchObject({ changed: [{ cell: "B4", after: 5 }] })
  })

  it("reads a range as its sheet and cells, and spreads values from the first cell or over a range of their shape", () => {
    expect(sheetRangeOf("'It''s'!A1:C10")).toEqual({ sheet: "It's", range: "A1:C10" })
    expect(sheetRangeOf("Budget")).toEqual({ sheet: "Budget" })
    expect(sheetRangeOf("b2")).toEqual({ range: "b2" })
    expect(cellEditsOf("S", "B2", [[1, 2], [3]]).map((edit) => edit.cell)).toEqual(["B2", "C2", "B3"])
    expect(() => cellEditsOf("S", "B2:C3", [[1, 2]])).toThrow(/2 rows by 2 columns/)
    expect(cellEditsOf("S", "Z1:AA1", [[1, 2]]).map((edit) => edit.cell)).toEqual(["Z1", "AA1"])
  })
})

describe("files documents", () => {
  it("replaces, inserts and deletes paragraphs at the sha256 shown, and warns of collapsed formatting", async () => {
    const disk = harness()
    await disk.run("documents", "show", "/letter.docx")
    const shown = disk.item<{
      sha256: string
      paragraphs: { index: number; text: string; mixed_formatting: boolean }[]
    }>()
    expect(shown.paragraphs[1]).toMatchObject({ index: 1, mixed_formatting: true })

    const payload = JSON.stringify([
      { index: 1, text: "Dear crane." },
      { insert_after: 2, text: "A new paragraph." },
      { delete: 2 },
    ])
    await disk.run("documents", "update", "/letter.docx", "--payload", payload, "--expected-fingerprint", shown.sha256)
    expect(disk.item()).toMatchObject({
      paragraphs: { replaced: [1], inserted: 1, deleted: [2] },
      warnings: ["paragraph 1 had mixed formatting; its new text has its first run's formatting"],
      replaced: { sha256: sha256(letter) },
    })
    const after = await readDocxParagraphs(disk.files.get("/letter.docx") as Uint8Array)
    expect(after.map((paragraph) => paragraph.text)).toEqual([
      "Synthetic letter",
      "Dear crane.",
      "A new paragraph.",
      "Cell one",
      "Cell two",
      "Closing words.",
    ])
  })

  it("a paragraph that cannot be edited is refused with its reason, and a malformed payload says its shape", async () => {
    const changed = tracked()
    const disk = harness({ "/letter.docx": changed })
    await disk.run("documents", "show", "/letter.docx")
    expect(disk.item<{ paragraphs: unknown[] }>().paragraphs[3]).toMatchObject({
      editable: false,
      reason: "it holds a tracked change",
    })
    const edit = (payload: string) =>
      disk.run("documents", "update", "/letter.docx", "--payload", payload, "--expected-fingerprint", sha256(changed))
    await expect(edit('[{"index": 3, "text": "x"}]')).rejects.toThrow(/tracked change/)
    await expect(edit('[{"index": "3"}]')).rejects.toMatchObject({ details: { param: "--payload" } })
    expect(disk.uploads).toEqual([])
  })
})

describe("files sheets create and documents create", () => {
  it("create a workbook and a document that show reads back, asking only the write's own permission", async () => {
    const disk = harness()
    await disk.run("sheets", "create", "/new.xlsx", "--values", '[["Item", "Cost"], ["Rent", 950]]', "--name", "Budget")
    const sheet = disk.item<{ path: string; sha256: string; sheets: unknown }>()
    expect(sheet).toMatchObject({ path: "/new.xlsx", sheets: [{ name: "Budget", rows: 2 }] })
    expect(sheet.sha256).toBe(sha256(disk.files.get("/new.xlsx") as Uint8Array))
    const [cells] = await readXlsxCells(disk.files.get("/new.xlsx") as Uint8Array)
    expect(cells?.name).toBe("Budget")
    expect(cells?.cells.map((cell) => cell.value)).toEqual(["Item", "Cost", "Rent", 950])

    await disk.run(
      "documents",
      "create",
      "/new.docx",
      "--payload",
      '[{"text": "Plan", "style": "Heading1"}, {"text": "Go."}]',
    )
    const document = disk.item<{ sha256: string; paragraphs: number }>()
    expect(document.paragraphs).toBe(2)
    const paragraphs = await readDocxParagraphs(disk.files.get("/new.docx") as Uint8Array)
    expect(paragraphs.map((paragraph) => [paragraph.text, paragraph.style])).toEqual([
      ["Plan", "heading 1"],
      ["Go.", undefined],
    ])

    expect(disk.asked).toEqual([[], []])
    expect(disk.ran).toEqual(["sheets create", "documents create"])
    expect(disk.versions.list("/new.xlsx")).toEqual([])

    await disk.run(
      "sheets",
      "update",
      "/new.xlsx",
      "Budget!B2",
      "--values",
      "[[1000]]",
      "--expected-fingerprint",
      sheet.sha256,
    )
    expect(disk.item()).toMatchObject({ changed: [{ cell: "B2", before: 950, after: 1000 }] })
  })

  it("refuse a file already there, naming update, and upload nothing", async () => {
    const disk = harness()
    const there = disk.run("sheets", "create", "/budget.xlsx", "--values", "[[1]]")
    await expect(there).rejects.toMatchObject({ code: "conflict", details: { reason: "office.file-exists" } })
    await expect(there).rejects.toThrow(
      "Read it (disk personal files sheets show /budget.xlsx) and change it with disk personal files sheets update",
    )
    await expect(disk.run("documents", "create", "/letter.docx", "--payload", '[{"text": "x"}]')).rejects.toMatchObject(
      {
        details: { reason: "office.file-exists" },
      },
    )
    expect(disk.uploads).toEqual([])
  })

  it("refuse the wrong extension, a malformed payload and an unknown style before asking to write", async () => {
    const disk = harness()
    await expect(disk.run("sheets", "create", "/new.csv", "--values", "[[1]]")).rejects.toMatchObject({
      details: { reason: "office.wrong-format" },
    })
    await expect(disk.run("sheets", "create", "/new.xlsx")).rejects.toMatchObject({ details: { param: "--values" } })
    await expect(disk.run("sheets", "create", "/new.xlsx", "--values", "[[1]]", "--name", "a/b")).rejects.toMatchObject(
      {
        details: { reason: "office.invalid-sheet-name" },
      },
    )
    await expect(
      disk.run("documents", "create", "/new.docx", "--payload", '[{"text": "x", "style": "Heading9"}]'),
    ).rejects.toMatchObject({ details: { param: "--payload" } })
    expect(disk.asked).toEqual([])
    expect(disk.uploads).toEqual([])
  })

  it("are left out where a provider names files by its own ids, and the edits stay", () => {
    const drive = harness({}, false)
    expect(drive.command("sheets", "create")).toBeUndefined()
    expect(drive.command("documents", "create")).toBeUndefined()
    expect(drive.command("sheets", "update")).toBeDefined()
    expect(drive.command("documents", "update")).toBeDefined()
  })
})

describe("files history and restore", () => {
  it("lists what a write replaced and puts it back as a guarded write that keeps the current content", async () => {
    const disk = harness({ "/notes.md": "first" })
    await disk.run("update", "/notes.md", "--text", "second", "--expected-fingerprint", sha256("first"))
    await disk.run("history", "/notes.md")
    const listed = disk.item<{ versions: { version: string; available: boolean }[] }>().versions
    expect(listed).toMatchObject([
      { event: "changed", direction: "local-to-remote", version: sha256("first"), available: true },
    ])

    const restore = (...more: string[]) => disk.run("restore", "/notes.md", sha256("first"), ...more)
    await expect(restore()).rejects.toMatchObject({ code: "validation_error" })
    await expect(restore("--expected-fingerprint", sha256("stale"))).rejects.toMatchObject({ code: "conflict" })
    await restore("--expected-fingerprint", sha256("second"))
    expect(strFromU8(disk.files.get("/notes.md") as Uint8Array)).toBe("first")
    expect(disk.item()).toMatchObject({ restored: sha256("first"), replaced: { sha256: sha256("second") } })
    expect(disk.asked.at(-1)).toEqual(["files.delete"])
    expect(disk.versions.list("/notes.md").at(-1)).toMatchObject({ direction: "restored", old: sha256("second") })
    expect(disk.versions.has(sha256("second"))).toBe(true)
    expect(new Set(disk.ran)).toEqual(new Set(["update", "history", "restore"]))
  })

  it("a version not kept is not found; without a version it is the CLI's own trash restore", async () => {
    const disk = harness()
    await expect(disk.run("restore", "/gone.md", sha256("never"))).rejects.toMatchObject({ code: "not_found" })
    await disk.run("restore", "trash:/old.pdf")
    expect(disk.trashed).toEqual(["trash:/old.pdf"])
    expect(disk.ran).toEqual(["restore", "restore"])
    expect(disk.uploads).toEqual([])
  })

  it("update refuses a file whose text a read extracts, so an extracted text never replaces a document", async () => {
    const disk = harness()
    await expect(
      disk.run("update", "/letter.docx", "--text", "flattened", "--expected-fingerprint", sha256(letter)),
    ).rejects.toMatchObject({ details: { reason: "file.not-plain-text" } })
    expect(disk.uploads).toEqual([])
  })

  it("the MCP catalogue reads the shows and history, and writes the edits, the creates and the restore", () => {
    const disk = harness()
    const effects = (...path: string[]) => metaOf(disk.command(...path)).effects
    for (const read of [["sheets", "show"], ["documents", "show"], ["history"]])
      expect(effects(...read)).toMatchObject({ remote: "read" })
    const writes = [
      ["sheets", "update"],
      ["sheets", "create"],
      ["documents", "update"],
      ["documents", "create"],
    ]
    for (const write of [...writes, ["restore"], ["update"]])
      expect(effects(...write)).toMatchObject({ remote: "write" })
  })
})
