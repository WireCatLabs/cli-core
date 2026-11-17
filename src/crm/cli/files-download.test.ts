import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import { openCache } from "../../store/open.js"
import { crmSettingKey, saveCrmSetting } from "../../store/sqlite/crm-settings.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { syncCrm } from "../index.js"
import { exampleDeal, type FakeCrmFile, fakeCrmSource } from "../testing/index.js"
import { downloadCrmFile, FILES_ROUND, syncFiles } from "./files.js"
import type { CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const PORTAL = { provider: "example-crm", account: "portal" }
const NOW = Date.UTC(2026, 10, 16, 12)
const MB = 1024 * 1024
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const row = (localPath: string | null, id: string, text: string | null, size: number, at: number) => ({
  externalId: `deal:d9:record:${id}`,
  ownerKind: "deal",
  ownerId: "d9",
  ownerAssignee: null,
  source: "record",
  name: id,
  mime: null,
  size,
  externalCreatedAt: null,
  localPath,
  contentSha256: null,
  text,
  extraction: text === null ? "needs-agent" : "extracted",
  extractionError: null,
  downloadedBy: "7",
  downloadedAt: at,
})

const base = async (files: FakeCrmFile[] = []) => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-download-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  const source = fakeCrmSource({ self: "7", admin: false, files })
  source.put("deal", exampleDeal("d1", { assignee: "7", updatedAt: NOW }))
  const home = mkdtempSync(join(tmpdir(), "crm-download-home-"))
  const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CRM_STATE_DIR: home }
  const run: CrmRun = { profile: "work", user: "7", account: PORTAL, store, source: () => source, env }
  const database = await openCache(path)
  saveCrmSetting(database, crmSettingKey(PORTAL, "files.max_total_mb"), 100, NOW)
  database.close()
  await store.crmFiles.save(PORTAL, row(join(home, "x"), "seed", null, 0, 0))
  return { store, run, source, folder: join(home, "crm", "files", "example-crm-portal") }
}

const openable = (name: string, bytes: Uint8Array, size: number | null, before?: () => void) => ({
  id: "deal:d1:record:f1",
  name,
  size,
  mime: null,
  created: NOW,
  owner: { kind: "deal" as const, id: "d1" },
  source: "record" as const,
  open: async () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        before?.()
        controller.enqueue(bytes)
        controller.close()
      },
    }),
})

/** The store with its `storedBytes` calls counted, so a test can stop the run at the second, after the bytes are saved. */
const stoppingAt = (store: MessageStore, call: number, stop: () => void) => {
  const files = store.crmFiles
  let calls = 0
  return new Proxy(store, {
    get(target, key) {
      if (key !== "crmFiles") return Reflect.get(target, key)
      return {
        ...files,
        storedBytes: async (...args: Parameters<typeof files.storedBytes>) => {
          calls += 1
          if (calls === call) stop()
          return files.storedBytes(...args)
        },
      }
    },
  })
}

const options = async (store: MessageStore) => ({
  capBytes: 3 * MB,
  capMb: 3,
  flag: true,
  limits: await store.crmFiles.limits(PORTAL),
})

describe("files download, second review", () => {
  it("BUG-4.a: a file of unknown size that will not fit drops nothing and is refused", async () => {
    const { store, run, folder } = await base()
    await store.crmFiles.save(PORTAL, row(join(folder, "deal-d9", "scan"), "scan", null, 99 * MB, 1))
    await store.crmFiles.save(PORTAL, row(join(folder, "deal-d9", "old"), "old", "old words", MB / 2, 2))
    await expect(
      downloadCrmFile(
        { app: APP, run, now: () => NOW },
        openable("f1.txt", new Uint8Array(2 * MB), null),
        "7",
        await options(store),
      ),
    ).rejects.toMatchObject({ details: { reason: "crm.files-disk-full" } })
    expect((await store.crmFiles.get(PORTAL, "deal:d9:record:old"))?.localPath).not.toBeNull()
  })

  it("BUG-1.a: a stale row naming the same path neither takes the name nor deletes the new file", async () => {
    const { store, run, folder } = await base()
    const stale = join(folder, "deal-d1", "f1.txt")
    await store.crmFiles.save(PORTAL, row(stale, "ghost", "old words", 99 * MB, 1))
    const done = await downloadCrmFile(
      { app: APP, run, now: () => NOW },
      openable("f1.txt", new Uint8Array(2 * MB), 2 * MB),
      "7",
      await options(store),
    )
    expect(done.row.localPath).not.toBe(stale)
    expect(existsSync(String(done.row.localPath))).toBe(true)
  })

  it("RISK-1.b and BUG-5: a time limit while the text is read keeps no file, no row, and never says unreadable", async () => {
    const { store, run, folder } = await base()
    const controller = new AbortController()
    const docx = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])
    const outcome = await downloadCrmFile(
      {
        app: APP,
        run: { ...run, store: stoppingAt(store, 2, () => controller.abort()) },
        now: () => NOW,
        signal: controller.signal,
      },
      openable("a.docx", docx, docx.byteLength),
      "7",
      await options(store),
    ).then(
      () => "saved",
      (error: { code?: string; message: string }) => `threw ${error.code}`,
    )
    const left = existsSync(join(folder, "deal-d1")) ? readdirSync(join(folder, "deal-d1")) : []
    expect({ outcome, left, stored: await store.crmFiles.get(PORTAL, "deal:d1:record:f1") }).toEqual({
      outcome: "threw cancelled",
      left: [],
      stored: undefined,
    })
  })

  it("RISK-1.b: an earlier copy's row at the same path forgets the file a cut-off download removed", async () => {
    const { store, run } = await base()
    const first = await downloadCrmFile(
      { app: APP, run, now: () => NOW },
      openable("a.txt", new TextEncoder().encode("first"), 5),
      "7",
      await options(store),
    )
    const controller = new AbortController()
    await expect(
      downloadCrmFile(
        {
          app: APP,
          run: { ...run, store: stoppingAt(store, 2, () => controller.abort()) },
          now: () => NOW,
          signal: controller.signal,
        },
        openable("a.txt", new TextEncoder().encode("second"), 6),
        "7",
        await options(store),
      ),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(existsSync(String(first.row.localPath))).toBe(false)
    expect(await store.crmFiles.get(PORTAL, "deal:d1:record:f1")).toMatchObject({ localPath: null, text: "first" })
  })

  it("SEC-3: under --dir, a file that appears at the name during the download is never replaced", async () => {
    const { store, run } = await base()
    const dir = mkdtempSync(join(tmpdir(), "crm-download-own-"))
    const theirs = join(dir, "a.txt")
    await expect(
      downloadCrmFile(
        { app: APP, run, now: () => NOW },
        openable("a.txt", new TextEncoder().encode("from the CRM"), 12, () => writeFileSync(theirs, "the owner's")),
        "7",
        { ...(await options(store)), dir },
      ),
    ).rejects.toMatchObject({ code: "conflict", details: { reason: "crm.file-exists" } })
    expect(readFileSync(theirs, "utf8")).toBe("the owner's")
    expect(readdirSync(dir)).toEqual(["a.txt"])
  })

  it("DEBT-2: a name longer than 200 bytes is cut, its extension kept", async () => {
    const { store, run } = await base()
    const done = await downloadCrmFile(
      { app: APP, run, now: () => NOW },
      openable(`${"ж".repeat(300)}.pdf`, new TextEncoder().encode("x"), 1),
      "7",
      await options(store),
    )
    const name = String(done.row.localPath).split("/").at(-1) as string
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200)
    expect(name.endsWith("ж.pdf")).toBe(true)
  })
})

describe("files sync, second review", () => {
  it("RISK-1.b: a time limit while a file's text is read stops the run as deadline, not unavailable", async () => {
    const files = [
      { owner: { kind: "deal" as const, id: "d1" }, id: "f1", name: "a.txt", bytes: "kitchen", created: NOW },
    ]
    const { store, run } = await base(files)
    await syncCrm(run.source(), store, PORTAL)
    let stop = () => {}
    const report = await syncFiles(
      { app: APP, run: { ...run, store: stoppingAt(store, 2, () => stop()) }, now: () => NOW },
      () => false,
      () => {
        const controller = new AbortController()
        stop = () => controller.abort()
        return controller.signal
      },
    )
    expect(report).toMatchObject({ downloaded: [], stopped: "deadline", complete: false })
    expect(report.skipped).toEqual([expect.objectContaining({ id: "deal:d1:record:f1", reason: "deadline" })])
  })

  it("RISK-1.a: a file the CRM keeps refusing is given up after three runs, and the round closes", async () => {
    const files = [
      { owner: { kind: "deal" as const, id: "d1" }, id: "f1", name: "a.txt", bytes: "x", broken: true, created: NOW },
    ]
    const { store, run } = await base(files)
    const roundOpen = async () =>
      JSON.parse((await store.sync.syncState(PORTAL, FILES_ROUND))?.value ?? "{}").started !== null
    let clock = NOW
    const sync = () => {
      clock += 60_000
      return syncFiles({ app: APP, run, now: () => clock }, () => false)
    }
    await syncCrm(run.source(), store, PORTAL)
    for (const _ of [1, 2]) {
      expect((await sync()).skipped).toEqual([expect.objectContaining({ reason: "unavailable" })])
      expect(await roundOpen()).toBe(true)
    }
    expect((await sync()).skipped).toEqual([expect.objectContaining({ reason: "unavailable" })])
    expect(await roundOpen()).toBe(false)
    expect((await sync()).owners).toBe(0)
  })
})
