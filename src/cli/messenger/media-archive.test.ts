import { mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { acquireLock } from "../../files/index.js"
import { NativeRecordingPublication } from "../../persistence/native/index.js"
import type { Download, RemoteFile } from "../../ports/messenger.js"
import { archiveMedia, checkMediaArchive, type MediaArchivePorts } from "../../services/media-archive.js"
import { mediaKey, readMediaManifests } from "../../services/media-archive-manifest.js"

const account = { provider: "example", account: "AliceExample" }
const chat: Chat = {
  id: "example-chat",
  title: "Example group",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
}
const message = (id = "1", chatId = chat.id): Message => ({
  id,
  chatId,
  timestamp: "2026-10-01T12:00:00.000Z",
  senderId: "BobExample",
  senderName: "Bob Example",
  text: "",
  outgoing: false,
  attachments: [{ kind: "file", providerRef: { mediaKey: "SYNTHETIC-SECRET" } }],
  editedAt: null,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const remote = (body = "example bytes", cut = false): RemoteFile => ({
  kind: "file",
  position: 0,
  size: Buffer.byteLength(body),
  name: "../../SYNTHETIC-SECRET.txt",
  providerRef: { directPath: "SYNTHETIC-SECRET" },
  bytes: async function* () {
    yield Buffer.from(body.slice(0, 3))
    if (cut) throw new Error("synthetic cut")
    yield Buffer.from(body.slice(3))
  },
})
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "media-archive-"))
  const download = vi.fn(async (): Promise<Download> => ({ files: [remote()], skipped: [] }))
  const list = vi.fn(async (_chat: string, _window: { limit: number; before?: string }) => ({
    items: [message()],
    hasMore: false,
  }))
  const ports: MediaArchivePorts = {
    chats: {
      account: async () => account,
      list: async () => ({ items: [chat], hasMore: false }),
      show: async () => ({ ...chat, members: [] }),
    },
    messages: { download, list },
  }
  const run = (options = {}) => archiveMedia(ports, { directory, pauseMs: 0, ...options })
  return { directory, ports, download, list, run }
}
describe("independent media archive", () => {
  it("recovers a completed publication before and after its final link without downloading again", async () => {
    for (const linked of [false, true]) {
      const f = await fixture()
      const original = NativeRecordingPublication.prototype.publish
      const spy = vi.spyOn(NativeRecordingPublication.prototype, "publish")
      if (linked)
        spy.mockImplementationOnce(function (this: NativeRecordingPublication<unknown>, partial, expected) {
          return original.call(this, partial, expected, async () => {
            throw new Error("synthetic commit crash")
          })
        })
      else spy.mockRejectedValueOnce(new Error("synthetic publication crash"))
      try {
        await expect(f.run()).rejects.toThrow("synthetic")
      } finally {
        spy.mockRestore()
      }
      expect(await f.run()).toMatchObject({ saved: 1 })
      expect(f.download).toHaveBeenCalledTimes(1)
      expect(await checkMediaArchive(f.directory)).toMatchObject({ valid: true, checked: 1 })
    }
  })
  it("names by account, chat, message and attachment; stores no provider references or sender names", async () => {
    const f = await fixture()
    expect(await f.run()).toMatchObject({ saved: 1, existing: 0, chats: 1, complete: true })
    const entries = await readMediaManifests(f.directory)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (!entry) throw new Error("missing archive entry")
    expect(entry.path).toBe(`${mediaKey({ ...account, chat: chat.id, message: "1", position: 0 })}.bin`)
    for (const name of await readdir(f.directory)) {
      expect(await readFile(join(f.directory, name), "utf8")).not.toContain("SYNTHETIC-SECRET")
    }
    expect(await checkMediaArchive(f.directory)).toMatchObject({ valid: true, checked: 1 })
    expect(await f.run()).toMatchObject({ saved: 0, existing: 1 })
    expect(f.download).toHaveBeenCalledTimes(1)
    f.ports.chats.account = async () => ({ ...account, account: "OtherExample" })
    expect(await f.run()).toMatchObject({ saved: 1 })
    expect(await checkMediaArchive(f.directory)).toMatchObject({ valid: true, checked: 2 })
  })
  it("retains completed files across cuts, restarts unvalidated byte streams, and never appends changed media", async () => {
    const f = await fixture()
    f.list.mockResolvedValue({ items: [message("1"), message("2")], hasMore: false })
    f.download
      .mockResolvedValueOnce({ files: [remote("first")], skipped: [] })
      .mockResolvedValueOnce({ files: [remote("original content", true)], skipped: [] })
    await expect(f.run()).rejects.toThrow("synthetic cut")
    expect(await checkMediaArchive(f.directory)).toMatchObject({ valid: true, checked: 1 })
    f.download.mockResolvedValue({ files: [remote("replacement content")], skipped: [] })
    expect(await f.run()).toMatchObject({ saved: 1, existing: 1 })
    const entries = await readMediaManifests(f.directory)
    const second = entries.find((one) => one.message === "2")
    if (!second) throw new Error("missing second entry")
    expect(await readFile(join(f.directory, second.path), "utf8")).toBe("replacement content")
    expect(f.download).toHaveBeenCalledTimes(3)
  })
  it("rehashes same-size changes on check and refuses reruns before downloading or overwriting", async () => {
    const f = await fixture()
    await f.run()
    const [entry] = await readMediaManifests(f.directory)
    if (!entry) throw new Error("missing entry")
    await writeFile(join(f.directory, entry.path), "EXAMPLE BYTES")
    expect(await checkMediaArchive(f.directory)).toMatchObject({ valid: false, files: [{ valid: false }] })
    await expect(f.run()).rejects.toThrow("choose a new destination")
    expect(f.download).toHaveBeenCalledTimes(1)
    expect(await readFile(join(f.directory, entry.path), "utf8")).toBe("EXAMPLE BYTES")
  })
  it("refuses a second writer, including through a directory alias", async () => {
    const f = await fixture()
    const alias = `${f.directory}-alias`
    await symlink(f.directory, alias)
    const lease = await acquireLock(join(f.directory, ".media-writers"))
    try {
      await expect(f.run()).rejects.toThrow("locked")
      await expect(f.run({ directory: alias })).rejects.toThrow("locked")
      await expect(checkMediaArchive(alias)).rejects.toThrow("locked")
      expect(f.download).not.toHaveBeenCalled()
    } finally {
      await lease.release()
    }
    expect(await f.run()).toMatchObject({ saved: 1 })
  })
  it("does not let an unmanifested file or symlink become an existing archive copy", async () => {
    const f = await fixture()
    const path = join(f.directory, `${mediaKey({ ...account, chat: chat.id, message: "1", position: 0 })}.bin`)
    const outside = join(f.directory, "outside")
    await writeFile(outside, "keep me")
    await symlink(outside, path)
    await expect(f.run()).rejects.toThrow("without a verified manifest")
    expect(await readFile(outside, "utf8")).toBe("keep me")
    expect(f.download).not.toHaveBeenCalled()
  })
  it("keeps archived files after source messages disappear", async () => {
    const f = await fixture()
    await f.run()
    f.list.mockResolvedValue({ items: [], hasMore: false })
    await f.run()
    expect(await checkMediaArchive(f.directory)).toMatchObject({ valid: true, checked: 1 })
  })
  it("checks scope, selects chats, includes the since boundary and pages chats and history", async () => {
    const f = await fixture()
    const old = { ...message("0"), timestamp: "2026-09-01T00:00:00.000Z" }
    f.list
      .mockResolvedValueOnce({ items: [message("3")], hasMore: true })
      .mockResolvedValueOnce({ items: [old, message("1")], hasMore: true })
    expect(await f.run({ chats: [chat.id, chat.id], sinceTime: message().timestamp })).toMatchObject({
      chats: 1,
      saved: 2,
    })
    expect(f.list.mock.calls[1]).toEqual([chat.id, { limit: 100, before: "3" }])
    await expect(f.run({ sinceTime: "yesterday" })).rejects.toThrow("ISO timestamp")
  })
  it("fails rather than claiming a saturated time boundary is complete", async () => {
    const f = await fixture()
    f.list.mockResolvedValue({ items: [message()], hasMore: true })
    await expect(f.run({ orderByTime: true })).rejects.toThrow("pagination did not advance")
    expect(f.list.mock.calls[1]).toEqual([chat.id, { limit: 100, before: "2026-10-01T12:00:00.001Z" }])
  })
  it("refuses ambiguous or missing files and truncated downloads", async () => {
    const f = await fixture()
    f.download.mockResolvedValue({ files: [], skipped: ["file"] })
    await expect(f.run()).rejects.toThrow("identifiable attachment")
    f.download.mockResolvedValue({ files: [{ ...remote("short"), size: 100 }], skipped: [] })
    await expect(f.run()).rejects.toThrow("different size")
    expect(await readMediaManifests(f.directory)).toEqual([])
  })
  it("cancels before writing, and refuses manifests with paths or extra secret fields", async () => {
    const f = await fixture()
    const stop = new AbortController()
    stop.abort(new Error("synthetic cancellation"))
    await expect(f.run({ signal: stop.signal })).rejects.toThrow("synthetic cancellation")
    await f.run()
    const name = (await readdir(f.directory)).find((one) => one.startsWith(".media-archive-"))
    if (!name) throw new Error("missing manifest")
    const entry = JSON.parse(await readFile(join(f.directory, name), "utf8"))
    await writeFile(join(f.directory, name), JSON.stringify({ ...entry, path: "../escape", mediaKey: "secret" }))
    await expect(checkMediaArchive(f.directory)).rejects.toThrow("invalid media archive manifest")
  })
})
