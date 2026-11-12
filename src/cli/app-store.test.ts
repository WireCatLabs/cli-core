import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { providers } from "../domain/providers.js"
import { openAppStore } from "./app-store.js"

const app = { command: "crm", version: "1.0.0" }
const provider = { name: "test-crm", kind: "crm", aliases: [], command: "crm" } as const

it("opens the shared store with the CLI's provider written, and a read-only open writes nothing", async () => {
  const env = { MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "app-store-")), "wirecat.db") }
  await expect(openAppStore(env, { app, provider, readOnly: true })).rejects.toThrow()
  const store = await openAppStore(env, { app, provider })
  expect(providers().map(({ name }) => name)).toContain("test-crm")
  await store.close()
  const read = await openAppStore(env, { app, provider, readOnly: true })
  await read.close()
})
