import { access, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { acquireLock } from "../../files/index.js"
import { NativeRecordingPublication } from "../../persistence/native/index.js"
import type { Download } from "../../ports/messenger.js"
import { archiveMedia, checkMediaArchive, type MediaArchivePorts } from "../../services/media-archive.js"
import { mediaManifestName, readMediaManifests } from "../../services/media-archive-manifest.js"
import { moveMediaArchive } from "../../services/media-archive-move.js"

const faults = vi.hoisted(() => ({ receiptPath: "" }))
vi.mock("../../files/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../files/index.js")>()
  return {
    ...original,
    writeFileAtomic: async (...args: Parameters<typeof original.writeFileAtomic>) => {
      await original.writeFileAtomic(...args)
      if (args[0] === faults.receiptPath) throw new Error("synthetic crash after relocation record")
    },
  }
})
afterEach(() => {
  faults.receiptPath = ""
  vi.restoreAllMocks()
})
const account = { provider: "example", account: "AliceExample" }
const chat: Chat = {
  id: "example-chat",
  title: "Example group",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
}
const message = (id: string, kind = "photo", timestamp = "2026-10-01T00:00:00.000Z", mime?: string): Message => ({
  id,
  chatId: chat.id,
  timestamp,
  senderId: "BobExample",
  senderName: "Bob Example",
  text: "",
  outgoing: false,
  attachments: [{ kind, ...(mime ? { mime } : {}) }],
  editedAt: null,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const fixture = async (messages = [message("old")]) => {
  const root = await mkdtemp(join(tmpdir(), "media-rotation-"))
  const source = join(root, "current"),
    destination = join(root, "older")
  const download = vi.fn(
    async (_chat: string, id: string): Promise<Download> => ({
      skipped: [],
      files: [
        {
          kind: messages.find((one) => one.id === id)?.attachments[0]?.kind ?? "photo",
          position: 0,
          bytes: async function* () {
            yield Buffer.from(`example ${id}`)
          },
        },
      ],
    }),
  )
  const ports: MediaArchivePorts = {
    chats: {
      account: async () => account,
      list: async () => ({ items: [chat], hasMore: false }),
      show: async () => ({ ...chat, members: [] }),
    },
    messages: { list: async () => ({ items: messages, hasMore: false }), download },
  }
  const run = () => archiveMedia(ports, { directory: source, pauseMs: 0 })
  await run()
  const rotate = (extra = {}) =>
    moveMediaArchive({ directory: source, archiveDirectory: destination, beforeTime: "2026-10-10T00:00:00Z", ...extra })
  return { root, source, destination, download, run, rotate }
}
const firstEntry = async (directory: string) => {
  const entry = (await readMediaManifests(directory))[0]
  if (!entry) throw new Error("missing archive entry")
  return entry
}
describe("image rotation between verified archives", () => {
  it("moves images by message date, keeps non-images and boundary dates, and remembers relocated copies", async () => {
    const f = await fixture([
      message("old"),
      message("image-document", "file", undefined, "image/png"),
      message("boundary", "photo", "2026-10-10T00:00:00.000Z"),
      message("voice", "voice"),
    ])
    expect(await f.rotate()).toMatchObject({ selected: 2, moved: 2, undated: 0, complete: true })
    const old = (await readMediaManifests(f.source)).find((one) => one.message === "old")
    if (!old) throw new Error("missing old image")
    expect(old.relocatedTo).toBe(await realpath(f.destination))
    await expect(access(join(f.source, old.path))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(f.destination, old.path), "utf8")).toBe("example old")
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true, checked: 4 })
    expect(await checkMediaArchive(f.destination)).toMatchObject({ valid: true, checked: 2 })
    expect(await f.run()).toMatchObject({ saved: 0, existing: 4 })
    expect(f.download).toHaveBeenCalledTimes(4)
    expect(await f.rotate()).toMatchObject({ moved: 0, alreadyArchived: 2 })
  })
  it("previews without creating the destination or changing source bytes and manifests", async () => {
    const f = await fixture()
    const entry = await firstEntry(f.source)
    const before = await readFile(join(f.source, mediaManifestName(entry)), "utf8")
    expect(await f.rotate({ dryRun: true })).toMatchObject({ selected: 1, moved: 0, dryRun: true })
    await expect(access(f.destination)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(f.source, entry.path), "utf8")).toBe("example old")
    expect(await readFile(join(f.source, mediaManifestName(entry)), "utf8")).toBe(before)
  })
  it("follows successive rotations, including offline checks from the first directory", async () => {
    const f = await fixture()
    await f.rotate()
    const oldest = join(f.root, "oldest")
    expect(await f.rotate({ directory: f.destination, archiveDirectory: oldest })).toMatchObject({ moved: 1 })
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true })
    expect(await checkMediaArchive(f.destination)).toMatchObject({ valid: true })
    expect(await f.run()).toMatchObject({ saved: 0, existing: 1 })
    expect(f.download).toHaveBeenCalledTimes(1)
    const entry = await firstEntry(oldest)
    await writeFile(join(oldest, entry.path), "corrupted")
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: false })
    await expect(f.run()).rejects.toThrow("checksum mismatch")
    expect(f.download).toHaveBeenCalledTimes(1)
  })
  it("keeps the source through a cut publication, and recovers the destination before removing it", async () => {
    const f = await fixture()
    const entry = await firstEntry(f.source)
    vi.spyOn(NativeRecordingPublication.prototype, "publish").mockRejectedValueOnce(
      new Error("synthetic publication cut"),
    )
    await expect(f.rotate()).rejects.toThrow("synthetic publication cut")
    expect(await readFile(join(f.source, entry.path), "utf8")).toBe("example old")
    expect((await firstEntry(f.source)).relocatedTo).toBeUndefined()
    expect(await f.rotate()).toMatchObject({ moved: 1 })
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true })
    expect(await checkMediaArchive(f.destination)).toMatchObject({ valid: true })
  })
  it("recovers a crash after publishing the source receipt without downloading again", async () => {
    const f = await fixture()
    const entry = await firstEntry(f.source)
    faults.receiptPath = join(f.source, mediaManifestName(entry))
    await expect(f.rotate()).rejects.toThrow("synthetic crash after relocation record")
    expect(await readFile(join(f.source, entry.path), "utf8")).toBe("example old")
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true })
    faults.receiptPath = ""
    expect(await f.run()).toMatchObject({ saved: 0, existing: 1 })
    expect(await f.rotate()).toMatchObject({ moved: 0, alreadyArchived: 1 })
    await expect(access(join(f.source, entry.path))).rejects.toMatchObject({ code: "ENOENT" })
    expect(f.download).toHaveBeenCalledTimes(1)
  })
  it("refuses changed redundant local bytes after a crash, preserving both copies", async () => {
    const f = await fixture()
    const entry = await firstEntry(f.source)
    faults.receiptPath = join(f.source, mediaManifestName(entry))
    await expect(f.rotate()).rejects.toThrow("synthetic crash")
    faults.receiptPath = ""
    await writeFile(join(f.source, entry.path), "local change")
    await expect(f.rotate()).rejects.toThrow("local image changed")
    expect(await readFile(join(f.source, entry.path), "utf8")).toBe("local change")
    expect(await readFile(join(f.destination, entry.path), "utf8")).toBe("example old")
  })
  it("locks linked archives as well as source and destination, including aliases", async () => {
    const f = await fixture()
    await f.rotate()
    const alias = join(f.root, "alias")
    await symlink(f.destination, alias)
    const lock = await acquireLock(join(alias, ".media-writers"))
    try {
      await expect(checkMediaArchive(f.source)).rejects.toThrow("locked")
      await expect(f.run()).rejects.toThrow("locked")
      await expect(f.rotate({ archiveDirectory: alias })).rejects.toThrow("locked")
    } finally {
      await lock.release()
    }
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true })
  })
  it("preserves undated legacy images and reports an incomplete selection", async () => {
    const f = await fixture()
    const entry = await firstEntry(f.source)
    const { messageTime: _time, ...legacy } = entry
    await writeFile(join(f.source, mediaManifestName(entry)), JSON.stringify(legacy))
    expect(await f.rotate()).toMatchObject({ moved: 0, undated: 1, complete: false })
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true })
    expect(await f.run()).toMatchObject({ existing: 1, saved: 0 })
  })
  it("rejects corrupt destinations, same-directory aliases, invalid cutoffs and cancellation before removing bytes", async () => {
    const f = await fixture()
    const alias = join(f.root, "alias")
    await symlink(f.source, alias)
    await expect(f.rotate({ archiveDirectory: alias })).rejects.toThrow("different archive")
    await expect(f.rotate({ beforeTime: "yesterday" })).rejects.toThrow("--before-time")
    await expect(f.rotate({ beforeTime: "2026-02-30T00:00:00Z" })).rejects.toThrow("invalid calendar")
    const cancelled = AbortSignal.abort(new Error("synthetic cancellation"))
    await expect(f.rotate({ signal: cancelled })).rejects.toThrow("synthetic cancellation")
    await f.rotate()
    const entry = await firstEntry(f.destination)
    await writeFile(join(f.destination, entry.path), "corruption")
    await expect(f.rotate()).rejects.toThrow("checksum mismatch")
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: false })
  })
  it("refuses relocation cycles and a destination whose existing copy points back to the source", async () => {
    const f = await fixture()
    await f.rotate()
    await expect(f.rotate({ directory: f.destination, archiveDirectory: f.source })).rejects.toThrow(
      "already relocated",
    )
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true })
    const entry = await firstEntry(f.destination)
    await writeFile(join(f.destination, mediaManifestName(entry)), JSON.stringify({ ...entry, relocatedTo: f.source }))
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: false })
    await expect(f.run()).rejects.toThrow("checksum mismatch")
  })
  it("preserves foreign destination bytes and independently valid but conflicting metadata", async () => {
    const f = await fixture()
    const entry = await firstEntry(f.source)
    await mkdir(f.destination)
    await writeFile(join(f.destination, entry.path), "foreign bytes")
    await expect(f.rotate()).rejects.toThrow("without a verified manifest")
    expect(await readFile(join(f.destination, entry.path), "utf8")).toBe("foreign bytes")
    expect(await readFile(join(f.source, entry.path), "utf8")).toBe("example old")
    await writeFile(join(f.destination, entry.path), "example old")
    await writeFile(join(f.destination, mediaManifestName(entry)), JSON.stringify({ ...entry, kind: "image" }))
    expect(await checkMediaArchive(f.destination)).toMatchObject({ valid: true })
    await expect(f.rotate()).rejects.toThrow("different copy")
    expect((await firstEntry(f.source)).relocatedTo).toBeUndefined()
  })
  it("reports offline cold storage as missing without downloading copies again", async () => {
    const f = await fixture()
    await f.rotate()
    const offline = join(f.root, "offline")
    await rename(f.destination, offline)
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: false })
    await expect(f.run()).rejects.toThrow("checksum mismatch")
    expect(f.download).toHaveBeenCalledTimes(1)
    await rename(offline, f.destination)
    expect(await checkMediaArchive(f.source)).toMatchObject({ valid: true })
  })
})
