import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "transcripts-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

describe("transcripts", () => {
  it("**keep what a voice message said, by chat and message, per account** — even before the message is stored", async () => {
    const store = await openStore({ path: fresh() })
    await store.messages.keepTranscript(OWNER, "-1", "42", "first try", "gigaam-v3")
    await store.messages.keepTranscript(OWNER, "-1", "42", "heard again", "telegram")
    await store.messages.keepTranscript(OWNER, "-1", "43", "   ", "telegram")

    expect(await store.messages.transcript(OWNER, "-1", "42")).toEqual({ text: "heard again", source: "telegram" })
    expect(await store.messages.transcript(OWNER, "-1", "43")).toBeUndefined()
    expect(await store.messages.transcript(OTHER, "-1", "42")).toBeUndefined()
    expect(await store.messages.transcript(OWNER, "-404", "42")).toBeUndefined()
    await store.close()
  })
})
