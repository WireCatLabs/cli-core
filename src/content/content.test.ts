import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openStore } from "../store/store.js"
import type { MessageStore } from "../store/store.js"
import {
  contentSourceContract,
  contentSyncContract,
  contentWriteContract,
  exampleContentRows,
  fakeContentSource,
} from "./testing/index.js"

const ACCOUNT = { provider: "fake-blog", account: "blog.example.com" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const freshStore = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "content-")), "wirecat.db") })
  opened.push(store)
  return store
}

describe("contentSourceContract over the fake blog", () => {
  for (const { name, run } of contentSourceContract(() => {
    const source = fakeContentSource({ rows: exampleContentRows(), metrics: { "10": { views: 3 } } })
    return {
      source,
      held: { author: ["1", "2"], term: ["tag-7", "cat-1"], post: ["10", "11", "12"] },
      deadCursor: { kind: "post", cursor: "not a time" },
      faults: {
        skewed: (ms) => source.skewed(ms),
        change: () => {
          source.touch("post", "11")
          return { kind: "post", id: "11" }
        },
        trash: () => {
          source.trashed("11")
          return "11"
        },
        remove: () => {
          source.remove("post", "12")
          return { kind: "post", id: "12" }
        },
      },
    }
  }))
    it(name, run)
})

describe("contentSyncContract over a fresh store", () => {
  for (const { name, run } of contentSyncContract(async () => ({ store: await freshStore(), account: ACCOUNT })))
    it(name, run)
})

describe("contentWriteContract over the fake blog", () => {
  for (const { name, run } of contentWriteContract(() => {
    const source = fakeContentSource({ rows: exampleContentRows() })
    return {
      writer: source.writer,
      loseNextAnswer: () => source.loseNextAnswer(),
      requests: () => source.requests.length,
      changeElsewhere: (id) => source.touch("post", id),
    }
  }))
    it(name, run)
})

it("keeps the store free of posts until a sync", async () => {
  expect(await (await freshStore()).content.count(ACCOUNT, "post")).toBe(0)
})
