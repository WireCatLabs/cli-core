import { describe, expect, it } from "vitest"
import { DEFAULT_RESOURCE_LIMITS, mapUploads, resolveResourceLimits } from "./resource-limits.js"

describe("resource limits", () => {
  it("uses generous defaults with flag, environment, profile precedence", () => {
    const defaults = (key: string, value: number) => ({ value: key === "maxUploadBytes" ? 12 : value, from: "profile" })
    const limits = resolveResourceLimits(
      { maxUploadBytes: "30" },
      { MAX_MAX_UPLOAD_BYTES: "20", MAX_UPLOAD_CONCURRENCY: "8" },
      "MAX",
      defaults,
    )
    expect(limits.values.maxUploadBytes).toBe(30)
    expect(limits.values.uploadConcurrency).toBe(8)
    expect(limits.values.maxOutputBytes).toBe(64 * 1024 * 1024)
    expect(DEFAULT_RESOURCE_LIMITS.maxUploadTotalBytes).toBe(0)
    expect(limits.sources.maxUploadBytes).toBe("flag")
    expect(limits.sources.uploadConcurrency).toBe("MAX_UPLOAD_CONCURRENCY")
  })
  it("refuses invalid counts and zero concurrency", () => {
    const defaults = (_key: string, value: number) => ({ value, from: "default" })
    for (const value of ["-1", "1.5", "NaN", "9007199254740992"])
      expect(() => resolveResourceLimits({ maxUploadBytes: value }, {}, "MAX", defaults)).toThrow()
    expect(() => resolveResourceLimits({ uploadConcurrency: 0 }, {}, "MAX", defaults)).toThrow()
  })
})

it("limits active uploads and preserves input order", async () => {
  let active = 0
  let peak = 0
  const result = await mapUploads([1, 2, 3, 4, 5], 2, async (file) => {
    active++
    peak = Math.max(peak, active)
    await Promise.resolve()
    active--
    return file * 2
  })
  expect(peak).toBe(2)
  expect(result).toEqual([2, 4, 6, 8, 10])
})

it("waits for active uploads after failure and starts no further ones", async () => {
  const started: number[] = []
  const failure = new Error("upload refused")
  const result = mapUploads([1, 2, 3, 4], 2, async (file) => {
    started.push(file)
    if (file === 1) throw failure
    await Promise.resolve()
    return file
  })
  await expect(result).rejects.toBe(failure)
  expect(started).toEqual([1, 2])
})
