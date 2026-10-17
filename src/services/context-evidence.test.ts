import { expect, it, vi } from "vitest"
import {
  type ContextEvidencePage,
  type ContextEvidenceRequest,
  type ContextSource,
  contextCursorScope,
} from "../context/evidence.js"
import { contextReadBudget } from "../context/read-budget.js"
import { formatLocator } from "../domain/locator.js"
import { createContextEvidenceReader } from "./context-evidence.js"

const source: ContextSource = { kind: "message", accountId: 1, provider: "sample-messages", account: "alpha" }
const request: ContextEvidenceRequest = { source, query: "launch", after: 100, before: 200, maxReadBytes: 100 }
const page = (req: ContextEvidenceRequest): ContextEvidencePage => ({
  source: req.source,
  items: [
    {
      ref: formatLocator({ provider: req.source.provider, account: req.source.account, chat: "room", message: "1" }),
      provider: req.source.provider,
      account: req.source.account,
      text: "launch",
      title: null,
      url: null,
      at: 100,
      updatedAt: 0,
      revision: null,
      timeKind: "sent",
    },
  ],
  readBytes: Buffer.byteLength(`${req.source.provider}${req.source.account}launchsentroom1`),
  next: null,
  coverage: {
    available: true,
    index: "ready",
    hasMore: false,
    hasUndated: false,
    completeness: "unknown",
    matching: "literal-words",
    consistency: "snapshot-per-page",
  },
})
const present = <T>(value: T | undefined) => {
  if (value === undefined) throw new Error("Missing fixture promise")
  return value
}

it("reserves aggregate capacity before concurrent source reads", async () => {
  const pending: (() => void)[] = []
  const read = vi.fn(
    (req: ContextEvidenceRequest) =>
      new Promise<ContextEvidencePage>((resolve) => pending.push(() => resolve(page(req)))),
  )
  const reader = createContextEvidenceReader({ read }, [source], { maxTotalReadBytes: 200 })
  const first = reader.read(request),
    second = reader.read(request)
  await expect(reader.read(request)).rejects.toMatchObject({
    code: "validation_error",
    details: { reason: "context.read-budget" },
  })
  expect(read).toHaveBeenCalledTimes(2)
  expect(reader.usage()).toMatchObject({ reads: 2, reservedBytes: 200, chargedBytes: 0, remainingBytes: 0 })
  for (const resolve of pending) resolve()
  await Promise.all([first, second])
  const actual = page(request).readBytes * 2
  expect(reader.usage()).toEqual({ reads: 2, reservedBytes: 0, chargedBytes: actual, remainingBytes: 200 - actual })
})

it("charges failed reads conservatively and clamps retries to the remaining allowance", async () => {
  const read = vi.fn(async (_req: ContextEvidenceRequest): Promise<ContextEvidencePage> => {
    throw new Error("Synthetic unavailable source")
  })
  const reader = createContextEvidenceReader({ read }, [source], { maxTotalReadBytes: 100 })
  await expect(reader.read({ ...request, maxReadBytes: 60 })).rejects.toThrow(/Synthetic/)
  await expect(reader.read({ ...request, maxReadBytes: 60 })).rejects.toThrow(/Synthetic/)
  expect(read.mock.calls.map(([req]) => req.maxReadBytes)).toEqual([60, 40])
  await expect(reader.read(request)).rejects.toMatchObject({ details: { reason: "context.read-budget" } })
  expect(read).toHaveBeenCalledTimes(2)
  expect(reader.usage()).toMatchObject({ chargedBytes: 100, reservedBytes: 0, remainingBytes: 0 })
})

it("does not refund a cancelled read whose adapter already ran", async () => {
  const controller = new AbortController()
  const reader = createContextEvidenceReader(
    {
      read: async (req) => {
        controller.abort()
        return page(req)
      },
    },
    [source],
    { maxTotalReadBytes: 100 },
  )
  await expect(reader.read({ ...request, signal: controller.signal })).rejects.toThrow()
  expect(reader.usage()).toMatchObject({ chargedBytes: 100, reservedBytes: 0, reads: 1 })
})

it("releases unused successful capacity and prevents unbounded empty paging", async () => {
  const read = vi.fn(async (req: ContextEvidenceRequest) => ({
    ...page(req),
    items: [],
    readBytes: 0,
    next: { at: 150, id: 1, scope: contextCursorScope(req) },
    coverage: { ...page(req).coverage, hasMore: true },
  }))
  const reader = createContextEvidenceReader({ read }, [source], { maxTotalReadBytes: 100, maxReads: 1 })
  const first = await reader.read(request)
  expect(first.items).toEqual([])
  expect(reader.usage()).toMatchObject({ chargedBytes: 0, reservedBytes: 0, remainingBytes: 100 })
  await expect(reader.read({ ...request, cursor: first.next ?? undefined })).rejects.toMatchObject({
    details: { reason: "context.read-budget" },
  })
  expect(read).toHaveBeenCalledTimes(1)
})

it("rejects unsupported selectors and invalid limits without source reads or reservations", async () => {
  const read = vi.fn(async (req: ContextEvidenceRequest) => page(req))
  expect(() => createContextEvidenceReader({ read }, [{ ...source, chatIds: ["room"] } as ContextSource])).toThrow(
    /source.chatIds/,
  )
  expect(() =>
    createContextEvidenceReader(
      { read },
      Array.from({ length: 9 }, () => source),
    ),
  ).toThrow(/allowed/)
  for (const limits of [{ maxReads: 0 }, { maxReads: 25 }, { maxTotalReadBytes: 4194305 }, { other: 1 }])
    expect(() => createContextEvidenceReader({ read }, [source], limits)).toThrow()
  const reader = createContextEvidenceReader({ read }, [source])
  for (const patch of [
    { source: { ...source, folderIds: ["1"] } },
    { chatIds: ["room"] },
    { maxReadBytes: 262145 },
    { after: 200, before: 200 },
    { after: 0, before: 91 * 86400000 },
    { cursor: { at: 200, id: 1, scope: contextCursorScope(request) } },
  ])
    await expect(reader.read({ ...request, ...patch } as ContextEvidenceRequest)).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(reader.read({ ...request, signal: AbortSignal.abort() })).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
  expect(reader.usage().reads).toBe(0)
})

it("independently validates returned dates, provenance, counts and charged bytes", async () => {
  const base = page(request)
  const bad: ContextEvidencePage[] = [
    { ...base, source: { ...source, account: "other" } },
    { ...base, items: base.items.map((item) => ({ ...item, at: request.before })) },
    { ...base, items: base.items.map((item) => ({ ...item, ref: "msg:sample-messages/other/room/1" })) },
    { ...base, readBytes: 101 },
    { ...base, readBytes: 0 },
    { ...base, readBytes: NaN },
    { ...base, items: Array.from({ length: 21 }, () => present(base.items[0])) },
    { ...base, coverage: { ...base.coverage, available: false } },
    { ...base, next: { at: 150, id: 1, scope: "foreign" }, coverage: { ...base.coverage, hasMore: true } },
    { ...base, next: false } as unknown as ContextEvidencePage,
  ]
  for (const response of bad) {
    const reader = createContextEvidenceReader({ read: async () => response }, [source])
    await expect(reader.read(request)).rejects.toMatchObject({ code: "invalid_response" })
    expect(reader.usage()).toMatchObject({ reservedBytes: 0, chargedBytes: 100 })
  }
})

it("freezes the request identity before dispatching an adapter", async () => {
  const reader = createContextEvidenceReader(
    {
      read: async (req) => {
        expect(Object.isFrozen(req)).toBe(true)
        expect(Object.isFrozen(req.source)).toBe(true)
        return page(req)
      },
    },
    [source],
  )
  expect((await reader.read(request)).items).toHaveLength(1)
})

it("guards reservation settlement and returns independent usage snapshots", () => {
  for (const limits of [null, [], { maxTotalReadBytes: NaN }])
    expect(() => contextReadBudget(limits as never)).toThrow()
  const budget = contextReadBudget({ maxTotalReadBytes: 100, maxReads: 2 })
  expect(() => budget.reserve(NaN)).toThrow()
  const reservation = budget.reserve(100)
  expect(() => reservation.complete(101)).toThrow()
  reservation.fail()
  expect(() => reservation.fail()).toThrow(/already settled/)
  const usage = budget.usage()
  usage.chargedBytes = 0
  expect(budget.usage().chargedBytes).toBe(100)
})
