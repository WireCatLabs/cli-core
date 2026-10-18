import { expect, it } from "vitest"
import { createTagRedirectIndex, type TagRedirectSnapshot } from "./tag-redirects.js"

const snapshot = (): TagRedirectSnapshot => ({
  complete: true,
  tags: ["10", "2", "1", "3", "4"].map((id) => ({ id, kind: "tag" })),
  redirects: [
    { sourceId: "1", survivorId: "2" },
    { sourceId: "2", survivorId: "10" },
    { sourceId: "3", survivorId: "10" },
  ],
})
const unsafe = (value: unknown) => createTagRedirectIndex(value as TagRedirectSnapshot)
const validation = expect.objectContaining({ code: "validation_error" })

it("resolves retained tag IDs deterministically without collapsing provenance-bearing members", () => {
  const input = snapshot()
  const index = createTagRedirectIndex(input)
  expect(index.resolve("1")).toEqual({
    requestedId: "1",
    canonicalId: "10",
    path: ["1", "2", "10"],
    memberIds: ["1", "2", "3", "10"],
  })
  expect(index.resolve("10")).toEqual({
    requestedId: "10",
    canonicalId: "10",
    path: ["10"],
    memberIds: ["1", "2", "3", "10"],
  })
  expect(index.resolve("4")).toEqual({ requestedId: "4", canonicalId: "4", path: ["4"], memberIds: ["4"] })
  const reversed = createTagRedirectIndex({
    ...input,
    tags: [...input.tags].reverse(),
    redirects: [...input.redirects].reverse(),
  })
  expect(reversed.resolve("1")).toEqual(index.resolve("1"))
})

it("captures the snapshot and returns independent result arrays", () => {
  const input = snapshot()
  const index = createTagRedirectIndex(input)
  ;(input.tags as { id: string; kind: "tag" }[]).splice(0)
  ;(input.redirects as { sourceId: string; survivorId: string }[]).splice(0)
  index.resolve("1").path.splice(0)
  index.resolve("1").memberIds.push("900")
  expect(index.resolve("1").path).toEqual(["1", "2", "10"])
  expect(index.resolve("1").memberIds).toEqual(["1", "2", "3", "10"])
})

it.each([
  null,
  [],
  { ...snapshot(), extra: true },
  { ...snapshot(), complete: false },
  { ...snapshot(), tags: null },
  { ...snapshot(), redirects: {} },
  { ...snapshot(), tags: [{ id: "1", kind: "topic" }] },
  { ...snapshot(), tags: [{ id: "1", kind: "project" }] },
  { ...snapshot(), tags: [{ id: "1", kind: "tag", evidence: "no text" }] },
  { ...snapshot(), tags: [{ id: "01", kind: "tag" }] },
  { ...snapshot(), tags: [{ id: "9007199254740992", kind: "tag" }] },
  { ...snapshot(), tags: [{ id: "1".repeat(100), kind: "tag" }] },
  { ...snapshot(), tags: [...snapshot().tags, { id: "1", kind: "tag" }] },
  { ...snapshot(), redirects: [null] },
  { ...snapshot(), redirects: [{ sourceId: "1", survivorId: "10", extra: true }] },
  { ...snapshot(), redirects: [{ sourceId: "1", survivorId: "99" }] },
  { ...snapshot(), redirects: [{ sourceId: "0", survivorId: "10" }] },
  { ...snapshot(), redirects: [...snapshot().redirects, { sourceId: "1", survivorId: "10" }] },
  { ...snapshot(), redirects: [...snapshot().redirects, { sourceId: "1", survivorId: "2" }] },
  { ...snapshot(), redirects: [{ sourceId: "4", survivorId: "4" }] },
  { ...snapshot(), redirects: [...snapshot().redirects, { sourceId: "10", survivorId: "1" }] },
])("refuses an incomplete or invalid graph before returning an index: %j", (input) => {
  expect(() => unsafe(input)).toThrow(validation)
})

it("validates disconnected components and names unknown fields", () => {
  expect(() => unsafe({ ...snapshot(), extra: true })).toThrow("extra")
  expect(() => createTagRedirectIndex({ ...snapshot(), redirects: [{ sourceId: "4", survivorId: "4" }] })).toThrow(
    "cycle",
  )
  const index = createTagRedirectIndex(snapshot())
  expect(() => index.resolve("99")).toThrow(expect.objectContaining({ code: "not_found" }))
  expect(() => index.resolve("-1")).toThrow(validation)
  expect(() => index.resolve(1 as unknown as string)).toThrow(validation)
})

const chain = (hops: number): TagRedirectSnapshot => ({
  complete: true,
  tags: Array.from({ length: hops + 1 }, (_, i) => ({ id: String(i + 1), kind: "tag" })),
  redirects: Array.from({ length: hops }, (_, i) => ({ sourceId: String(i + 1), survivorId: String(i + 2) })),
})

it("accepts 16 hops but refuses 17 and row budgets before traversing", () => {
  expect(createTagRedirectIndex(chain(16)).resolve("1").path).toHaveLength(17)
  expect(() => createTagRedirectIndex(chain(17))).toThrow("16 hops")
  expect(() => createTagRedirectIndex(chain(4096))).toThrow("4096 rows")
  expect(() =>
    createTagRedirectIndex({ ...chain(0), redirects: Array(4097).fill({ sourceId: "1", survivorId: "1" }) }),
  ).toThrow("4096 rows")
  expect(() =>
    createTagRedirectIndex({ ...chain(0), redirects: [{ sourceId: "1", survivorId: "9007199254740992" }] }),
  ).toThrow("survivorId")
  expect(() => createTagRedirectIndex({ ...chain(0), redirects: [{ sourceId: "2", survivorId: "1" }] })).toThrow(
    "unavailable",
  )
})

it("accepts an empty complete graph without inventing tags", () => {
  expect(() => createTagRedirectIndex({ complete: true, tags: [], redirects: [] }).resolve("1")).toThrow(
    expect.objectContaining({ code: "not_found" }),
  )
})
