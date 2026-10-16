import { createHash } from "node:crypto"
import { appendFile, mkdtemp, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { type RecordingAssetLocator, transferRecording } from "../../meetings/index.js"
import { NativeRecordingPartialStore } from "./index.js"

const locator = { provider: "example-calls", account: "alice", occurrenceId: "weekly", assetId: "video" }
const settings = { prefix: ".example-partial-", persistent: true, maxBytes: 1024 }
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const root = () => mkdtemp(join(tmpdir(), "cli-messaging-test-native-partial-"))
const metaPath = (store: NativeRecordingPartialStore) => store.path.replace(/\.part$/, ".json")
const prefix = async (store: NativeRecordingPartialStore) => {
  const writer = await store.open(locator, { validator: '"v1"', total: 6 })
  try {
    await writer.write(Buffer.from("abc"))
    await writer.checkpoint()
  } finally {
    await writer.close()
  }
}

describe("native recording partial persistence", () => {
  it("resumes an invented provider with unchanged locator hashing and durable metadata", async () => {
    const folder = await root()
    const store = new NativeRecordingPartialStore(folder, locator, settings)
    const key = digest(JSON.stringify(["example-calls", "alice", "weekly", "video"]))
    expect(basename(store.path)).toBe(`.example-partial-${key}.part`)
    // This is the existing host byte format, written independently of the new adapter.
    await writeFile(store.path, "abc")
    await writeFile(
      metaPath(store),
      JSON.stringify({ locator, offset: 3, sha256: digest("abc"), validator: '"v1"', total: 6 }),
    )
    const result = await transferRecording(
      {
        open: async (request) => {
          expect(request.offset).toBe(3)
          expect(request.validator).toBe('"v1"')
          return {
            status: 206,
            etag: '"v1"',
            contentRange: "bytes 3-5/6",
            contentLength: "3",
            body: (async function* () {
              yield Buffer.from("def")
            })(),
            close: async () => {},
          }
        },
      },
      store,
      { locator, maxBytes: 1024 },
    )
    expect(result).toEqual({ size: 6, sha256: digest("abcdef"), resumedBytes: 3 })
    expect(await readFile(store.path, "utf8")).toBe("abcdef")
    expect(store.completed).toMatchObject({ offset: 6, sha256: digest("abcdef"), locator })
    expect(await new NativeRecordingPartialStore(folder, locator, settings).load(locator)).toEqual(store.completed)
  })

  it("retains an interrupted checkpoint and truncates only the unacknowledged trailing bytes", async () => {
    const folder = await root()
    const store = new NativeRecordingPartialStore(folder, locator, settings)
    await prefix(store)
    await appendFile(store.path, "uncommitted")
    const partial = await store.load(locator)
    expect(partial?.offset).toBe(3)
    const writer = await store.open(locator, { resume: partial ?? undefined, validator: '"v1"', total: 6 })
    try {
      expect(await readFile(store.path, "utf8")).toBe("abc")
      await writer.write(Buffer.from("def"))
      expect(await writer.finish()).toEqual({ size: 6, sha256: digest("abcdef") })
    } finally {
      await writer.close()
    }
  })

  it("retains a real transfer checkpoint after source interruption and closes the failed transfer", async () => {
    const folder = await root()
    const store = new NativeRecordingPartialStore(folder, locator, settings)
    let closed = 0
    await expect(
      transferRecording(
        {
          open: async () => ({
            status: 200,
            etag: '"v1"',
            contentRange: null,
            contentLength: "6",
            body: (async function* () {
              yield Buffer.from("abc")
              throw new Error("example interrupted source")
            })(),
            close: async () => {
              closed++
            },
          }),
        },
        store,
        { locator, maxBytes: 1024 },
      ),
    ).rejects.toThrow("interrupted source")
    expect(closed).toBe(1)
    expect(store.completed).toBeNull()
    expect(await new NativeRecordingPartialStore(folder, locator, settings).load(locator)).toMatchObject({
      offset: 3,
      sha256: digest("abc"),
    })
  })

  it("snapshots locators and writer options before asynchronous filesystem access", async () => {
    const folder = await root()
    const input = { ...locator }
    const options = { ...settings }
    const store = new NativeRecordingPartialStore(folder, input, options)
    input.account = "bob"
    options.prefix = ".other-partial-"
    const openOptions = { validator: '"v1"', total: 6 }
    const pending = store.open(locator, openOptions)
    openOptions.validator = '"changed"'
    openOptions.total = 999
    const writer = await pending
    try {
      await writer.write(Buffer.from("abcdef"))
      await writer.finish()
    } finally {
      await writer.close()
    }
    expect(store.completed).toMatchObject({ locator, validator: '"v1"', total: 6 })
    await expect(store.load(input)).rejects.toThrow("scope")
  })

  it("isolates accounts and ephemeral attempts and creates no ephemeral checkpoint", async () => {
    const folder = await root()
    const a = new NativeRecordingPartialStore(folder, locator, settings)
    await prefix(a)
    const b = new NativeRecordingPartialStore(folder, { ...locator, account: "bob" }, settings)
    expect(await b.load({ ...locator, account: "bob" })).toBeNull()
    const e1 = new NativeRecordingPartialStore(folder, locator, { ...settings, persistent: false })
    const e2 = new NativeRecordingPartialStore(folder, locator, { ...settings, persistent: false })
    expect(new Set([a.path, b.path, e1.path, e2.path]).size).toBe(4)
    await prefix(e1)
    expect(await e1.load(locator)).toBeNull()
    await expect(readFile(metaPath(e1))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not checkpoint an unvalidated response and removes the previous metadata on restart", async () => {
    const folder = await root()
    const store = new NativeRecordingPartialStore(folder, locator, settings)
    await prefix(store)
    const writer = await store.open(locator, { validator: null, total: null })
    try {
      await writer.write(Buffer.from("new"))
      await writer.finish()
    } finally {
      await writer.close()
    }
    expect(store.completed).toBeNull()
    expect(await store.load(locator)).toBeNull()
    expect(await readFile(store.path, "utf8")).toBe("new")
  })

  for (const content of [
    "null",
    "[]",
    "{}",
    "not-json",
    "x".repeat(16385),
    JSON.stringify({ locator, offset: -1, sha256: digest("abc"), validator: '"v1"', total: 6 }),
    JSON.stringify({ locator, offset: 3, sha256: digest("abc"), validator: '"v1"', total: 6, extra: true }),
  ]) {
    it(`refuses malformed or oversized metadata (${content.length} bytes, ${content.slice(0, 10)})`, async () => {
      const store = new NativeRecordingPartialStore(await root(), locator, settings)
      await prefix(store)
      await writeFile(metaPath(store), content)
      await expect(store.load(locator)).rejects.toThrow("metadata is invalid")
      expect(await readFile(store.path, "utf8")).toBe("abc")
    })
  }

  it("rejects changed prefixes at load and again between load and append", async () => {
    const store = new NativeRecordingPartialStore(await root(), locator, settings)
    await prefix(store)
    const partial = await store.load(locator)
    await writeFile(store.path, "xyz")
    await expect(store.load(locator)).rejects.toThrow("checksum")
    await expect(store.open(locator, { resume: partial ?? undefined, validator: '"v1"', total: 6 })).rejects.toThrow(
      "before append",
    )
    expect(await readFile(store.path, "utf8")).toBe("xyz")
  })

  it("refuses append after a path replacement without touching the replacement", async () => {
    const store = new NativeRecordingPartialStore(await root(), locator, settings)
    const writer = await store.open(locator, { validator: '"v1"', total: 6 })
    await rename(store.path, `${store.path}.original`)
    await writeFile(store.path, "unrelated")
    try {
      await expect(writer.write(Buffer.from("abc"))).rejects.toThrow("before append")
      await expect(writer.finish()).rejects.toThrow("before append")
      expect(store.completed).toBeNull()
    } finally {
      await writer.close()
    }
    expect(await readFile(store.path, "utf8")).toBe("unrelated")
  })

  it("rejects symlink metadata and partials and safely replaces only a fresh partial name", async () => {
    if (process.platform === "win32") return
    const folder = await root()
    const store = new NativeRecordingPartialStore(folder, locator, settings)
    await prefix(store)
    const partial = await store.load(locator)
    await rename(store.path, `${store.path}.original`)
    await symlink(`${store.path}.original`, store.path)
    await expect(store.load(locator)).rejects.toThrow("symlink")
    await expect(store.open(locator, { resume: partial ?? undefined, validator: '"v1"', total: 6 })).rejects.toThrow(
      "symlink",
    )
    const writer = await store.open(locator, { validator: '"v1"', total: 3 })
    try {
      await writer.write(Buffer.from("new"))
      await writer.finish()
    } finally {
      await writer.close()
    }
    expect(await readFile(`${store.path}.original`, "utf8")).toBe("abc")
    await rename(metaPath(store), `${metaPath(store)}.original`)
    await symlink(`${metaPath(store)}.original`, metaPath(store))
    await expect(store.load(locator)).rejects.toThrow("symlink")
  })

  it("bounds writes and never returns a receipt after cancellation", async () => {
    const controller = new AbortController()
    const store = new NativeRecordingPartialStore(await root(), locator, {
      ...settings,
      signal: controller.signal,
      maxBytes: 3,
    })
    const writer = await store.open(locator, { validator: '"v1"', total: 3 })
    try {
      await expect(writer.write(Buffer.from("four"))).rejects.toThrow("byte limit")
      await writer.write(Buffer.from("abc"))
      await writer.checkpoint()
      controller.abort(new Error("example cancelled"))
      await expect(writer.finish()).rejects.toThrow("example cancelled")
      expect(store.completed).toBeNull()
    } finally {
      await writer.close()
    }
    const next = new NativeRecordingPartialStore(await root(), locator, { ...settings, signal: controller.signal })
    await expect(next.open(locator, { validator: null, total: null })).rejects.toThrow("example cancelled")
    expect(await readdir(join(next.path, ".."))).toEqual([])
  })

  it("validates native layout and input limits before any writes", async () => {
    const folder = await root()
    for (const options of [
      { ...settings, prefix: "../escape-" },
      { ...settings, maxBytes: 0 },
      { ...settings, persistent: "yes" },
    ])
      expect(() => new NativeRecordingPartialStore(folder, locator, options as typeof settings)).toThrow("options")
    expect(() => new NativeRecordingPartialStore(folder, { ...locator, assetId: "" }, settings)).toThrow("options")
    const store = new NativeRecordingPartialStore(folder, locator, settings)
    await expect(store.open({ ...locator, account: "bob" }, { validator: null, total: null })).rejects.toThrow("scope")
    await expect(
      store.open(locator, {
        resume: { locator: {} as RecordingAssetLocator, offset: 3, sha256: digest("abc"), validator: '"v1"', total: 6 },
        validator: '"v1"',
        total: 6,
      }),
    ).rejects.toThrow("scope")
    expect(await readdir(folder)).toEqual([])
  })
})
