import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readAttachments, readFileUpload, readUpload, uploadSource } from "./upload.js"
import { uploadBlob, uploadBytes, validateUploadSources } from "./upload-source.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }

const setUp = () => {
  const root = mkdtempSync(join(tmpdir(), "upload-"))
  const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "store", "m.db") }
  const put = (path: string) => {
    const full = join(root, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, "bytes")
    return full
  }
  return { root, env, put }
}

describe("readUpload", () => {
  it("reads a file with its name, and a photo only with a photo's extension", async () => {
    const { env, put } = setUp()

    expect(await readUpload("file", put("docs/plan.pdf"), { app, env })).toMatchObject({
      kind: "file",
      name: "plan.pdf",
    })
    expect((await readUpload("photo", put("pics/cat.JPG"), { app, env })).bytes.byteLength).toBe(5)
    await expect(readUpload("photo", put("pics/cat.gif"), { app, env })).rejects.toThrow(/send .* as a file/)
  })

  it("**refuses credential files, the CLI's own folders and the store**, also through a link — unless anyFile", async () => {
    const { root, env, put } = setUp()
    const key = put(".ssh/id_ed25519")
    const link = join(root, "innocent.txt")
    symlinkSync(key, link)

    for (const path of [key, put("state/session"), put("store/m.db"), put("store/m.db-wal"), link]) {
      await expect(readUpload("file", path, { app, env })).rejects.toThrow(/--allow-any-file/)
    }
    expect(await readUpload("file", key, { app, env, anyFile: true })).toMatchObject({ name: "id_ed25519" })
    expect(await readUpload("file", put("store/report.pdf"), { app, env })).toMatchObject({ name: "report.pdf" })
  })

  it("allows hidden developer folders and similarly named store neighbors", async () => {
    const { env, put } = setUp()
    for (const name of [".worktrees/a.txt", ".cache/a.txt", ".incoming/.notes", "store/m.db-report.pdf"])
      expect(await readUpload("file", put(name), { app, env })).toMatchObject({ kind: "file" })
  })

  it("says what is wrong with a path that is not a readable file", async () => {
    const { root, env } = setUp()

    await expect(readUpload("file", join(root, "missing.pdf"), { app, env })).rejects.toThrow(/no such file/)
    await expect(readUpload("file", root, { app, env })).rejects.toThrow(/a folder/)
  })
})

describe("readAttachments", () => {
  it("gives the --file the --filename, and refuses one without a file or with a path in it", async () => {
    const { env, put } = setUp()
    const file = put("exports/a1b2c3.pdf")

    expect(await readAttachments({ file, filename: "Report Q3.pdf" }, { app, env })).toMatchObject([
      { kind: "file", name: "Report Q3.pdf" },
    ])
    await expect(readAttachments({ photo: put("cat.jpg"), filename: "x.jpg" }, { app, env })).rejects.toThrow(
      "--filename names a --file",
    )
    for (const filename of ["../x.pdf", "a\\b.pdf", " "]) {
      await expect(readAttachments({ file, filename }, { app, env })).rejects.toThrow("not a path")
    }
  })
})

describe("file-backed uploads", () => {
  it("keeps preparation on disk and permits files larger than the buffered budget", async () => {
    const { env, put } = setUp()
    const file = await readFileUpload("file", put("docs/report.pdf"), {
      app,
      env,
      limits: { maxBufferedUploadBytes: 1 },
    })
    expect(file).not.toHaveProperty("bytes")
    expect(await (await uploadBlob(uploadSource(file))).text()).toBe("bytes")
    await expect(uploadBytes(uploadSource(file), { maxBufferedUploadBytes: 1 })).rejects.toThrow(/buffered/i)
  })

  it("refuses a total budget before buffering or sending any attachment", async () => {
    const { env, put } = setUp()
    await expect(
      readAttachments(
        { photo: put("image.jpg"), file: put("doc.pdf") },
        {
          app,
          env,
          fileBacked: true,
          limits: { maxUploadTotalBytes: 9 },
        },
      ),
    ).rejects.toThrow(/maxUploadTotalBytes/)
    expect(() =>
      validateUploadSources(
        [
          { kind: "bytes", bytes: new Uint8Array(6) },
          { kind: "bytes", bytes: new Uint8Array(6) },
        ],
        { maxBufferedUploadBytes: 10 },
      ),
    ).toThrow(/maxBufferedUploadBytes/)
  })
})
