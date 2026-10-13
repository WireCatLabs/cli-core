import { describe, expect, it, vi } from "vitest"
import type { MessageStore } from "../store/store.js"
import { accountStoreIfOpen, type ServiceDeps, storeIfOpen } from "./deps.js"

describe("optional store enrichment", () => {
  it("reports an unavailable store once across enrichment helpers without failing the provider result", async () => {
    const failure = new Error("store directory is unreadable")
    const diagnostic = vi.fn()
    const deps = {
      diagnostic,
      store: async () => {
        throw failure
      },
      account: async () => ({ provider: "test", account: "1" }),
    } as unknown as ServiceDeps
    expect(await storeIfOpen(deps)).toBeUndefined()
    expect(await accountStoreIfOpen(deps)).toBeUndefined()
    expect(await storeIfOpen(deps)).toBeUndefined()
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      code: "optional_store_unavailable",
      message: "local store enrichment unavailable: store directory is unreadable",
      error: failure,
    })
  })

  it("returns an available account-bound store without a diagnostic", async () => {
    const bound = { account: { provider: "test", account: "1" } }
    const diagnostic = vi.fn()
    const store = { forAccount: () => bound } as unknown as MessageStore
    const deps = {
      diagnostic,
      store: async () => store,
      account: async () => bound.account,
    } as unknown as ServiceDeps
    expect(await accountStoreIfOpen(deps)).toBe(bound)
    expect(await storeIfOpen(deps)).toEqual({ store, account: bound.account })
    expect(diagnostic).not.toHaveBeenCalled()
  })
})
