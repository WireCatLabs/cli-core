import { CliError } from "@wirecat/cli-base"
import { expect, it, vi } from "vitest"
import type {
  RecordingArchiveResult,
  RecordingAsset,
  RecordingCatalog,
  RecordingOccurrence,
} from "./recording-source.js"
import {
  parseRecordingSyncCheckpoint,
  type RecordingSyncCheckpointStore,
  RecordingSyncError,
  type RecordingSyncOptions,
  recordingAssetFingerprint,
  recordingWindows,
  syncRecordingArchive,
} from "./recording-sync.js"
import { recordingSyncCheckpointStoreContract } from "./testing/recording-sync-contract.js"
import { memoryRecordingSyncCheckpointStore } from "./testing/recording-sync-memory.js"

const file = (change: Partial<RecordingAsset> = {}): RecordingAsset => ({
  id: "file-AliceExample",
  type: "video",
  format: "MP4",
  size: 5,
  status: "completed",
  available: true,
  startedAt: null,
  endedAt: null,
  ...change,
})
const occurrence = (externalId = "opaque:AliceExample/+?", files = [file()]): RecordingOccurrence => ({
  id: "AliceExample",
  externalId,
  title: "Alice Example planning",
  startedAt: null,
  assets: files,
})
const report = (item: RecordingOccurrence): RecordingArchiveResult => ({
  externalId: item.externalId,
  manifestPath: "AliceExample/manifest.json",
  downloaded: item.assets
    .filter((asset) => asset.available && asset.id !== null)
    .map((asset) => ({
      id: asset.id as string,
      path: "AliceExample/video.mp4",
      size: asset.size ?? 5,
      remoteSize: asset.size,
      sha256: "a".repeat(64),
      type: asset.type,
      format: asset.format,
      startedAt: asset.startedAt,
      endedAt: asset.endedAt,
    })),
  skipped: [],
  unavailable: item.assets.filter((asset) => !asset.available),
})
const collect = async (items: AsyncIterable<unknown>) => {
  const result: unknown[] = []
  for await (const item of items) result.push(item)
  return result
}
const options = (
  store = memoryRecordingSyncCheckpointStore(),
  change: Partial<RecordingSyncOptions> = {},
): RecordingSyncOptions => ({
  scope: { provider: "example", account: "AliceExample" },
  from: "2026-01-01",
  to: "2026-02-28",
  recheckFrom: "2026-01-01",
  archive: async (item) => report(item),
  now: () => 1000,
  checkpoint: { store, jobId: "AliceExample-backup", configKey: "configuration-v1" },
  ...change,
})
const source = (
  list: RecordingCatalog["list"] = async () => ({ items: [occurrence()], nextCursor: null }),
): RecordingCatalog => ({ provider: "example", list })
const read = async (store: RecordingSyncCheckpointStore) => {
  const lease = await store.acquire("AliceExample-backup")
  try {
    return await store.read("AliceExample-backup", lease.token)
  } finally {
    await lease.release()
  }
}

it("runs the same workflow over two providers with incompatible opaque occurrence ids", async () => {
  for (const [provider, externalId] of [
    ["provider-a", "opaque/+?=AliceExample"],
    ["provider-b", "urn:meeting:BobSample:session#1"],
  ]) {
    const store = memoryRecordingSyncCheckpointStore()
    const catalog = {
      provider: provider as string,
      list: async () => ({ items: [occurrence(externalId)], nextCursor: null }),
    }
    const archive = vi.fn(async (item: RecordingOccurrence) => report(item))
    const opts = options(store, { scope: { provider: provider as string, account: "AliceExample" }, archive })
    expect(await collect(syncRecordingArchive(catalog, opts))).toHaveLength(1)
    expect(await collect(syncRecordingArchive(catalog, opts))).toEqual([])
    expect(archive).toHaveBeenCalledTimes(1)
    const checkpoint = await read(store)
    expect(checkpoint?.entries[0]?.externalId).toBe(externalId)
    expect(JSON.stringify(checkpoint)).not.toMatch(/cursor|url|token|title|uuid/)
  }
})
it("refetches active windows without persisting cursors and checkpoints before delivery", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  const requested: (string | undefined)[] = []
  const catalog = source(async ({ cursor }) => {
    requested.push(cursor)
    return { items: [occurrence(cursor ? "BobSample" : "AliceExample")], nextCursor: cursor ? null : "opaque-page" }
  })
  const opts = options(store, { to: "2026-01-31" })
  const run = syncRecordingArchive(catalog, opts)
  expect((await run.next()).value).toMatchObject({ availability: "unknown", checkpointRevision: 2 })
  await expect(store.acquire("AliceExample-backup")).rejects.toMatchObject({ code: "configuration_error" })
  await run.return()
  expect((await read(store))?.windows).toEqual([])
  expect(await collect(syncRecordingArchive(catalog, opts))).toHaveLength(1)
  expect(requested).toEqual([undefined, undefined, "opaque-page"])
  expect((await read(store))?.entries).toHaveLength(2)
})
it("retries unavailable assets without blocking later months and discovers changed and late assets", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  let ready = false
  const catalog = source(async ({ from }) => ({
    items: [
      occurrence(from, [file(from.startsWith("2026-01") && !ready ? { available: false, status: "processing" } : {})]),
    ],
    nextCursor: null,
  }))
  const archive = vi.fn(async (item: RecordingOccurrence) => report(item))
  const opts = options(store, { archive })
  expect(await collect(syncRecordingArchive(catalog, opts))).toHaveLength(2)
  ready = true
  expect(await collect(syncRecordingArchive(catalog, { ...opts, from: "2026-03-01", to: "2026-03-31" }))).toHaveLength(
    2,
  )
  expect((await read(store))?.entries).toHaveLength(3)
  const changed = source(async () => ({ items: [occurrence("2026-01-01", [file({ size: 6 })])], nextCursor: null }))
  expect(await collect(syncRecordingArchive(changed, { ...opts, recheckFrom: "2026-01-01" }))).toHaveLength(1)
  const late = source(async () => ({ items: [occurrence("late-BobSample")], nextCursor: null }))
  expect(await collect(syncRecordingArchive(late, { ...opts, recheckFrom: "2026-01-01" }))).toHaveLength(1)
  expect(archive).toHaveBeenCalledTimes(6)
})
it("preserves completed late acknowledgements through cancellation and releases leases", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  const controller = new AbortController()
  const opts = options(store, {
    signal: controller.signal,
    archive: async (item) => {
      controller.abort()
      return report(item)
    },
  })
  const run = syncRecordingArchive(source(), opts)
  expect((await run.next()).value).toMatchObject({ checkpointRevision: 2 })
  await expect(run.next()).rejects.toMatchObject({ code: "cancelled" })
  expect((await read(store))?.entries[0]?.acknowledged).toHaveLength(1)
  expect(await collect(syncRecordingArchive(source(), { ...opts, signal: undefined }))).toEqual([])
})
it("does not acknowledge failed archive or checkpoint writes and replays safely", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  const broken: RecordingSyncCheckpointStore = {
    ...store,
    save: async () => {
      throw new Error("Example checkpoint failure")
    },
  }
  await expect(collect(syncRecordingArchive(source(), options(broken)))).rejects.toThrow("Example checkpoint failure")
  expect(await read(store)).toBeNull()
  await expect(
    collect(
      syncRecordingArchive(
        source(),
        options(store, {
          archive: async () => {
            throw new Error("Example download failure")
          },
        }),
      ),
    ),
  ).rejects.toThrow("Example download failure")
  expect((await read(store))?.pendingWindows).toEqual([{ from: "2026-01-01", to: "2026-01-31" }])
  expect(await collect(syncRecordingArchive(source(), options(store)))).toHaveLength(1)
})
it("rejects cross-account/config checkpoints and CAS or foreign lease writes", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  await collect(syncRecordingArchive(source(), options(store)))
  for (const change of [
    { scope: { provider: "example", account: "BobSample" } },
    { checkpoint: { store, jobId: "AliceExample-backup", configKey: "changed" } },
  ])
    await expect(collect(syncRecordingArchive(source(), options(store, change)))).rejects.toMatchObject({
      code: "configuration_error",
    })
  const lease = await store.acquire("AliceExample-backup")
  const current = await store.read("AliceExample-backup", lease.token)
  if (!current) throw new Error("missing synthetic checkpoint")
  await expect(store.read("AliceExample-backup", "foreign")).rejects.toMatchObject({ code: "configuration_error" })
  await expect(store.save("AliceExample-backup", lease.token, null, current)).rejects.toMatchObject({
    code: "configuration_error",
  })
  await expect(store.save("AliceExample-backup", lease.token, current.revision, current)).rejects.toMatchObject({
    code: "configuration_error",
  })
  await lease.release()
  await expect(lease.release()).rejects.toMatchObject({ code: "configuration_error" })
})
it("validates dates, scopes, bounds and clock before I/O", async () => {
  const catalog = source(vi.fn(async () => ({ items: [], nextCursor: null })))
  for (const change of [
    { from: "bad" },
    { from: "2026-02-30" },
    { to: "2025-01-01" },
    { to: "2036-01-02" },
    { scope: { provider: "other", account: "AliceExample" } },
    { scope: { provider: "example", account: " " } },
    { maxPages: 0 },
    { maxEntries: 10001 },
    { now: () => -1 },
    { recheckFrom: "bad" },
    { checkpoint: { store: memoryRecordingSyncCheckpointStore(), jobId: "", configKey: "v1" } },
  ])
    await expect(collect(syncRecordingArchive(catalog, options(undefined, change)))).rejects.toBeInstanceOf(
      RecordingSyncError,
    )
  expect(catalog.list).not.toHaveBeenCalled()
  expect(recordingWindows("2024-02-29", "2034-02-28")).toHaveLength(121)
  expect(recordingWindows("2026-12-31", "2027-01-01")).toEqual([
    { from: "2026-12-31", to: "2026-12-31" },
    { from: "2027-01-01", to: "2027-01-01" },
  ])
  expect(recordingWindows("0001-01-01", "0011-01-01")).toHaveLength(121)
})
it("limits pagination and occurrence history, rejects cursor loops and conflicting duplicates", async () => {
  for (const [catalog, change, match] of [
    [source(async () => ({ items: [], nextCursor: "repeated" })), {}, /repeated/],
    [source(async () => ({ items: [], nextCursor: "another" })), { maxPages: 1 }, /page limit/],
    [
      source(async ({ cursor }) => ({
        items: [occurrence("same", [file({ size: cursor ? 6 : 5 })])],
        nextCursor: cursor ? null : "next",
      })),
      {},
      /conflicting/,
    ],
    [
      source(async () => ({ items: [occurrence("AliceExample"), occurrence("BobSample")], nextCursor: null })),
      { maxEntries: 1 },
      /occurrence limit/,
    ],
  ] as const)
    await expect(collect(syncRecordingArchive(catalog, options(undefined, change)))).rejects.toThrow(match)
})
it("does not advance on missing acknowledgements and reports honest unknown availability", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  let calls = 0
  const opts = options(store, {
    archive: async (item) => {
      calls++
      return { ...report(item), downloaded: [] }
    },
  })
  await collect(syncRecordingArchive(source(), opts))
  await collect(syncRecordingArchive(source(), opts))
  expect(calls).toBe(2)
  expect((await read(store))?.entries[0]?.acknowledged).toEqual([])
  await expect(
    collect(syncRecordingArchive(source(), options(undefined, { archive: async () => report(occurrence("wrong")) }))),
  ).rejects.toThrow(/acknowledgement/)
})
it("parses only a bounded v1 metadata schema and rejects malformed acknowledgements", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  await collect(syncRecordingArchive(source(), options(store)))
  const valid = await read(store)
  if (!valid?.entries[0]) throw new Error("missing synthetic checkpoint")
  const entry = valid.entries[0]
  expect(parseRecordingSyncCheckpoint({ ...valid, signedUrl: "should never survive" })).toEqual(valid)
  for (const value of [
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, entries: Array(10001).fill(valid?.entries[0]) },
    { ...valid, windows: [...valid.windows, valid.windows[0]] },
    { ...valid, entries: [entry, entry] },
    { ...valid, entries: [{ ...entry, acknowledged: ["wrong"] }] },
    {
      ...valid,
      entries: [
        {
          ...entry,
          acknowledged: [entry.acknowledged[0], entry.acknowledged[0]],
        },
      ],
    },
    { ...valid, windows: [{ from: "2026-02-01", to: "2026-01-01" }] },
    { ...valid, windows: [{ from: "2026-01-01", to: "2026-02-28" }] },
  ])
    expect(() => parseRecordingSyncCheckpoint(value)).toThrow()
  expect(() => parseRecordingSyncCheckpoint(valid, 0)).toThrow()
  for (const change of [
    { id: 3 },
    { type: "" },
    { available: "yes" },
    { size: -1 },
    { startedAt: "invalid" },
    { id: null, available: true },
  ])
    expect(() => recordingAssetFingerprint(file(change as Partial<RecordingAsset>))).toThrow()
})
it("cancels before discovery or archive and handles ephemeral empty catalogs", async () => {
  const controller = new AbortController()
  controller.abort()
  const list = vi.fn(async () => ({ items: [], nextCursor: null }))
  await expect(
    collect(syncRecordingArchive(source(list), options(undefined, { signal: controller.signal }))),
  ).rejects.toMatchObject({ code: "cancelled" })
  expect(list).not.toHaveBeenCalled()
  const late = new AbortController()
  await expect(
    collect(
      syncRecordingArchive(
        source(async () => {
          late.abort()
          return { items: [occurrence()], nextCursor: null }
        }),
        options(undefined, { signal: late.signal }),
      ),
    ),
  ).rejects.toMatchObject({ code: "cancelled" })
  expect(await collect(syncRecordingArchive(source(list), options(undefined, { checkpoint: undefined })))).toEqual([])
})
it("rejects malformed provider pages and occurrence metadata before archiving", async () => {
  const archive = vi.fn(async (item: RecordingOccurrence) => report(item))
  for (const page of [
    { items: null, nextCursor: null },
    { items: Array(1001).fill(occurrence()), nextCursor: null },
    { items: [], nextCursor: 3 },
    { items: [{ ...occurrence(), id: "" }], nextCursor: null },
    { items: [{ ...occurrence(), assets: null }], nextCursor: null },
    { items: [{ ...occurrence(), assets: Array(1001).fill(file()) }], nextCursor: null },
    { items: [{ ...occurrence(), assets: [file(), file()] }], nextCursor: null },
  ])
    await expect(
      collect(
        syncRecordingArchive(
          source(async () => page as unknown as Awaited<ReturnType<RecordingCatalog["list"]>>),
          options(undefined, { archive }),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" })
  expect(archive).not.toHaveBeenCalled()
  expect(
    await collect(
      syncRecordingArchive(
        source(async () => ({
          items: [
            occurrence("BobSample", [
              file({
                id: null,
                available: false,
                size: null,
                startedAt: "2026-01-01T00:00:00Z",
                endedAt: "2026-01-01T00:10:00Z",
              }),
            ]),
          ],
          nextCursor: null,
        })),
        options(undefined, { checkpoint: undefined }),
      ),
    ),
  ).toHaveLength(1)
})
it("rejects bounded checkpoint fields and raw metadata byte excess", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  await collect(syncRecordingArchive(source(), options(store)))
  const valid = await read(store)
  if (!valid?.entries[0]) throw new Error("missing synthetic checkpoint")
  const entry = valid.entries[0]
  for (const change of [
    { externalId: "" },
    { acknowledged: null },
    { acknowledged: Array(1001).fill("x") },
    { acknowledged: ["x".repeat(65537)] },
    { acknowledged: [3] },
  ])
    expect(() => parseRecordingSyncCheckpoint({ ...valid, entries: [{ ...entry, ...change }] })).toThrow(/entry/)
  const large = Array.from({ length: 300 }, (_, i) => file({ id: `${i}-${"x".repeat(4000)}` }))
  expect(() =>
    parseRecordingSyncCheckpoint({ ...valid, entries: [{ ...entry, assets: large, acknowledged: [] }] }),
  ).toThrow(/byte limit/)
  const modest = Array.from({ length: 200 }, (_, i) => file({ id: `${i}-${"x".repeat(4000)}` }))
  expect(() =>
    parseRecordingSyncCheckpoint({
      ...valid,
      entries: Array.from({ length: 11 }, (_, i) => ({
        ...entry,
        externalId: String(i),
        assets: modest,
        acknowledged: [],
      })),
    }),
  ).toThrow(/checkpoint exceeds its byte limit/)
})
it("retains failed discovery windows across changed scheduled ranges and catches entry capacity", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  await expect(
    collect(
      syncRecordingArchive(
        source(async () => {
          throw new Error("Example discovery failed")
        }),
        options(store, { to: "2026-01-31" }),
      ),
    ),
  ).rejects.toThrow("Example discovery failed")
  expect((await read(store))?.pendingWindows).toEqual([{ from: "2026-01-01", to: "2026-01-31" }])
  const windows: string[] = []
  await collect(
    syncRecordingArchive(
      source(async ({ from }) => {
        windows.push(from)
        return { items: [], nextCursor: null }
      }),
      options(store, { from: "2026-03-01", to: "2026-03-31" }),
    ),
  )
  expect(windows).toEqual(["2026-01-01", "2026-03-01"])
  await collect(syncRecordingArchive(source(), options(store)))
  await expect(
    collect(
      syncRecordingArchive(
        source(async () => ({ items: [occurrence("new-BobSample")], nextCursor: null })),
        options(store, { from: "2026-04-01", to: "2026-04-30", maxEntries: 1 }),
      ),
    ),
  ).rejects.toThrow(/checkpoint entry limit/)
})
it("bounds retained window metadata and total serialized checkpoints", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  await collect(syncRecordingArchive(source(), options(store)))
  const current = await read(store)
  if (!current) throw new Error("missing synthetic checkpoint")
  const lease = await store.acquire("AliceExample-backup")
  const windows = Array.from({ length: 1000 }, (_, i) => {
    const month = `${1900 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`
    return { from: month, to: month }
  })
  await store.save("AliceExample-backup", lease.token, current.revision, {
    ...current,
    windows,
    revision: current.revision + 1,
  })
  await lease.release()
  await collect(
    syncRecordingArchive(
      source(async () => ({ items: [], nextCursor: null })),
      options(store),
    ),
  )
  expect((await read(store))?.windows).toHaveLength(2)
  const largeSource = source(async () => ({
    items: [
      occurrence(
        "AliceExample",
        Array.from({ length: 200 }, (_, i) => file({ id: `${i}-${"x".repeat(4000)}` })),
      ),
    ],
    nextCursor: null,
  }))
  const largeStore = memoryRecordingSyncCheckpointStore()
  for (let i = 0; i < 6; i++) {
    const nextSource = {
      ...largeSource,
      list: async () => ({
        items: [
          occurrence(
            String(i),
            Array.from({ length: 200 }, (_, j) => file({ id: `${j}-${"x".repeat(4000)}` })),
          ),
        ],
        nextCursor: null,
      }),
    }
    const run = collect(syncRecordingArchive(nextSource, options(largeStore, { recheckFrom: "2026-01-01" })))
    if (i < 5) await run
    else await expect(run).rejects.toThrow(/metadata limit/)
  }
})
it("validates clock configuration and cancellation while acquiring a lease", async () => {
  for (const change of [{ archive: null }, { now: null }])
    await expect(
      collect(syncRecordingArchive(source(), options(undefined, change as unknown as Partial<RecordingSyncOptions>))),
    ).rejects.toThrow(/configuration/)
  const store = memoryRecordingSyncCheckpointStore()
  const controller = new AbortController()
  const interrupted = {
    ...store,
    acquire: async (jobId: string) => {
      const lease = await store.acquire(jobId)
      controller.abort()
      return lease
    },
  }
  await expect(
    collect(syncRecordingArchive(source(), options(interrupted, { signal: controller.signal }))),
  ).rejects.toMatchObject({ code: "cancelled" })
  const lease = await store.acquire("AliceExample-backup")
  await lease.release()
})
it("resumes a failed lookback scan even if its discovery window was previously completed", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  const opts = options(store, { to: "2026-01-31" })
  await collect(syncRecordingArchive(source(), opts))
  await expect(
    collect(
      syncRecordingArchive(
        source(async () => {
          throw new Error("Example lookback failed")
        }),
        { ...opts, recheckFrom: "2026-01-01" },
      ),
    ),
  ).rejects.toThrow("Example lookback failed")
  expect((await read(store))?.pendingWindows).toHaveLength(1)
  await collect(syncRecordingArchive(source(), opts))
  expect((await read(store))?.pendingWindows).toEqual([])
})
it("bounds cumulative discovery metadata independently of checkpoint metadata", async () => {
  let sequence = 0
  const title = "x".repeat(4096)
  const catalog = source(async () => ({
    items: Array.from({ length: 1000 }, () => ({ ...occurrence(String(sequence++), []), title })),
    nextCursor: String(sequence),
  }))
  await expect(collect(syncRecordingArchive(catalog, options(undefined, { checkpoint: undefined })))).rejects.toThrow(
    /occurrence metadata exceeds its byte limit/,
  )
})
it("compacts extending same-month windows and drops old successful metadata without losing backlog", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  let ready = false
  const archive = vi.fn(async (item: RecordingOccurrence) => report(item))
  const catalog = source(async ({ from }) => ({
    items: [
      occurrence(from, [file(from.startsWith("2026-01") && !ready ? { available: false, status: "processing" } : {})]),
    ],
    nextCursor: null,
  }))
  const opts = options(store, { recheckFrom: undefined, to: "2026-01-15", archive })
  await collect(syncRecordingArchive(catalog, opts))
  await collect(syncRecordingArchive(catalog, { ...opts, to: "2026-01-20" }))
  expect((await read(store))?.windows).toEqual([{ from: "2026-01-01", to: "2026-01-20" }])
  await collect(syncRecordingArchive(catalog, { ...opts, to: "2026-02-15" }))
  await collect(syncRecordingArchive(catalog, { ...opts, to: "2026-02-20" }))
  const february = await read(store)
  expect(february?.windows).toEqual([
    { from: "2026-01-01", to: "2026-01-31" },
    { from: "2026-02-01", to: "2026-02-20" },
  ])
  expect(february?.entries.map((entry) => entry.externalId).sort()).toEqual(["2026-01-01", "2026-02-01"])
  await collect(syncRecordingArchive(catalog, { ...opts, from: "2026-03-01", to: "2026-03-20" }))
  expect((await read(store))?.windows).toEqual([{ from: "2026-03-01", to: "2026-03-20" }])
  expect((await read(store))?.entries.map((entry) => entry.externalId).sort()).toEqual(["2026-01-01", "2026-03-01"])
  ready = true
  await collect(syncRecordingArchive(catalog, { ...opts, from: "2026-04-01", to: "2026-04-20" }))
  expect((await read(store))?.entries.map((entry) => entry.externalId).sort()).toEqual(["2026-04-01"])
})
it("never merges discovery gaps and retains successful metadata overlapping pending work", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  const opts = options(store, { to: "2026-01-15", recheckFrom: undefined })
  await collect(syncRecordingArchive(source(), opts))
  const current = await read(store)
  if (!current?.entries[0]) throw new Error("missing synthetic checkpoint")
  const lease = await store.acquire("AliceExample-backup")
  await store.save("AliceExample-backup", lease.token, current.revision, {
    ...current,
    revision: current.revision + 1,
    pendingWindows: [],
    windows: [
      { from: "2026-01-01", to: "2026-01-15" },
      { from: "2026-01-20", to: "2026-01-31" },
    ],
  })
  await lease.release()
  const list = vi.fn(async () => ({ items: [], nextCursor: null }))
  await collect(syncRecordingArchive(source(list), { ...opts, from: "2026-01-16", to: "2026-01-18" }))
  expect(list).toHaveBeenCalledOnce()
  expect((await read(store))?.windows).toEqual([
    { from: "2026-01-16", to: "2026-01-18" },
    { from: "2026-01-20", to: "2026-01-31" },
  ])
  const again = await store.acquire("AliceExample-backup")
  const state = await store.read("AliceExample-backup", again.token)
  if (!state) throw new Error("missing synthetic checkpoint")
  await store.save("AliceExample-backup", again.token, state.revision, {
    ...state,
    revision: state.revision + 1,
    entries: [{ ...current.entries[0], window: { from: "2026-01-25", to: "2026-01-31" } }],
    pendingWindows: [{ from: "2026-01-20", to: "2026-01-31" }],
  })
  await again.release()
  const stopped = source(async ({ from }) => {
    if (from === "2026-01-20") throw new Error("Example interrupted backlog")
    return { items: [], nextCursor: null }
  })
  await expect(
    collect(
      syncRecordingArchive(stopped, { ...opts, from: "2026-01-19", to: "2026-01-19", recheckFrom: "2026-02-01" }),
    ),
  ).rejects.toThrow("Example interrupted backlog")
  expect((await read(store))?.entries[0]?.externalId).toBe(current.entries[0].externalId)
})

for (const contract of recordingSyncCheckpointStoreContract(() => {
  const store = memoryRecordingSyncCheckpointStore()
  return { store, reopen: async () => store }
}))
  it(contract.name, contract.run)

it("refuses exhausted revision counters before checkpoint writes", async () => {
  const seeded = memoryRecordingSyncCheckpointStore()
  await collect(syncRecordingArchive(source(), options(seeded)))
  const current = await read(seeded)
  if (!current) throw new Error("missing synthetic checkpoint")
  const save = vi.fn(async () => undefined)
  const store = { ...seeded, read: async () => ({ ...current, revision: Number.MAX_SAFE_INTEGER }), save }
  await expect(
    collect(syncRecordingArchive(source(), options(store, { from: "2026-03-01", to: "2026-03-31" }))),
  ).rejects.toThrow(/metadata limit/)
  expect(save).not.toHaveBeenCalled()
})

it("uses the shared CLI error identity and closed standard error taxonomy", () => {
  const error = new RecordingSyncError("configuration_error", "Example lease conflict")
  expect(error).toBeInstanceOf(CliError)
  expect(error.code).toBe("configuration_error")
  expect(error.name).toBe("RecordingSyncError")
})

it("keeps scope validation shared and acknowledgment metadata detached from callback mutations", async () => {
  const list = vi.fn(async () => ({ items: [occurrence()], nextCursor: null }))
  for (const scope of [
    { provider: "example", account: "AliceExample\nBobSample" },
    { provider: "example", account: "x".repeat(1001) },
  ])
    await expect(collect(syncRecordingArchive(source(list), options(undefined, { scope })))).rejects.toMatchObject({
      code: "validation_error",
    })
  expect(list).not.toHaveBeenCalled()
  const store = memoryRecordingSyncCheckpointStore()
  const opts = options(store, {
    to: "2026-01-31",
    archive: async (item) => {
      const asset = item.assets[0]
      if (!asset) throw new Error("missing synthetic asset")
      asset.size = 999
      return report(item)
    },
  })
  await collect(syncRecordingArchive(source(), opts))
  const current = await read(store)
  expect(current?.entries[0]?.assets[0]?.size).toBe(5)
  expect(current?.entries[0]?.acknowledged).toEqual([])
  expect(
    await collect(syncRecordingArchive(source(), { ...opts, archive: async (item) => report(item) })),
  ).toHaveLength(1)
})
it("refuses to acknowledge an archived length that contradicts its known remote length", async () => {
  const store = memoryRecordingSyncCheckpointStore()
  await collect(
    syncRecordingArchive(
      source(),
      options(store, {
        to: "2026-01-31",
        archive: async (item) => {
          const result = report(item)
          const file = result.downloaded[0]
          if (!file) throw new Error("missing synthetic archived file")
          file.size = 10
          return result
        },
      }),
    ),
  )
  expect((await read(store))?.entries[0]?.acknowledged).toEqual([])
  expect(await collect(syncRecordingArchive(source(), options(store, { to: "2026-01-31" })))).toHaveLength(1)
  const unknown = source(async () => ({ items: [occurrence("BobSample", [file({ size: null })])], nextCursor: null }))
  expect(await collect(syncRecordingArchive(unknown, options(undefined, { to: "2026-01-31" })))).toHaveLength(1)
})
it("portable two-provider workflows retain pending revisions and isolate checkpoints across provider namespaces", async () => {
  const sharedStore = memoryRecordingSyncCheckpointStore()
  for (const [provider, id, cursor] of [
    ["camera-example", "opaque/AliceExample+1", "camera-page"],
    ["assistant-example", "urn:BobSample:session#1", "assistant-token"],
  ]) {
    if (!provider || !id || !cursor) throw new Error("missing synthetic provider")
    let phase = 0
    const calls: string[] = []
    const catalog: RecordingCatalog = {
      provider,
      list: async (options) => {
        calls.push(`${options.account}:${options.cursor ?? "first"}`)
        return {
          items: [
            occurrence(id, [
              file(phase === 0 ? { available: false, status: "processing" } : { size: phase === 1 ? 5 : 6 }),
            ]),
          ],
          nextCursor: options.cursor ? null : cursor,
        }
      },
    }
    const opts = options(sharedStore, {
      scope: { provider, account: "AliceExample" },
      to: "2026-01-31",
      checkpoint: { store: sharedStore, jobId: provider, configKey: "portable-test" },
    })
    expect(await collect(syncRecordingArchive(catalog, opts))).toHaveLength(1)
    phase = 1
    expect(await collect(syncRecordingArchive(catalog, opts))).toHaveLength(1)
    expect(await collect(syncRecordingArchive(catalog, opts))).toEqual([])
    phase = 2
    expect(await collect(syncRecordingArchive(catalog, opts))).toHaveLength(1)
    const lease = await sharedStore.acquire(provider)
    const current = await sharedStore.read(provider, lease.token)
    await lease.release()
    expect(current?.entries[0]?.assets[0]?.size).toBe(6)
    expect(current?.entries[0]?.acknowledged).toHaveLength(1)
    expect(JSON.stringify(current)).not.toContain(cursor)
    expect(calls.every((call) => call.startsWith("AliceExample:"))).toBe(true)
    const otherProvider = { ...catalog, provider: "other-example" }
    await expect(
      collect(
        syncRecordingArchive(otherProvider, { ...opts, scope: { provider: "other-example", account: "AliceExample" } }),
      ),
    ).rejects.toMatchObject({ code: "configuration_error" })
  }
})
