import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import type { MessageStore } from "../store/store.js"
import { onlineDeps, type ServiceDeps, storeIfOpen } from "./deps.js"

const store = { forAccount: () => ({}) } as unknown as MessageStore
const account = { provider: "max", account: "1" }

const deps = (parts: Partial<Pick<ServiceDeps, "store" | "account">>): ServiceDeps =>
  ({ store: async () => store, account: async () => account, ...parts }) as ServiceDeps

const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })

describe("storeIfOpen", () => {
  it.each([
    [
      "an online session has no store",
      onlineDeps({ provider: "max" } as Messenger, { self: () => "1" } as unknown as MessengerAdapter, {} as SendGuard),
    ],
    ["the store is busy", deps({ store: () => Promise.reject(busy) })],
    [
      "the account is not recorded yet",
      deps({ account: () => Promise.reject(new CliError("not_found", "nothing recorded")) }),
    ],
  ])("gives nothing when %s", async (_, given) => {
    expect(await storeIfOpen(given)).toBeUndefined()
  })

  it("rethrows a store that is broken", async () => {
    const corrupt = Object.assign(new Error("file is not a database"), { code: "ERR_SQLITE_ERROR", errcode: 26 })
    await expect(storeIfOpen(deps({ store: () => Promise.reject(corrupt) }))).rejects.toBe(corrupt)
  })

  it("rethrows a failure it does not expect from the account", async () => {
    const failure = new Error("boom")
    await expect(storeIfOpen(deps({ account: () => Promise.reject(failure) }))).rejects.toBe(failure)
  })
})
