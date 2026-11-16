import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { provide } from "../context.js"
import type { Body } from "../envelope.js"
import { addDocumentSyncCommands, type DocumentSyncAnswer } from "./sync.js"

const syncWith = async (answer: DocumentSyncAnswer) => {
  const program = new Command("host").option("--json").exitOverride()
  provide(program, { streams: captureStreams(), env: {}, tty: false })
  const bodies: Body[] = []
  addDocumentSyncCommands(program, {
    words: { app: "box", remote: "box", provider: "Box", source: "box" },
    output: (body) => bodies.push(body),
    diagnostic: () => {},
    profile: () => "personal",
    maxEntries: 100,
    sync: async () => answer,
    status: () => ({}),
  })
  await program.parseAsync(["sync", "--embed"], { from: "user" })
  return bodies[0] as Body & { next?: { step: string; safe_to_auto_execute: boolean }[] }
}

const done = { errors: [], pending: 0, complete: true, saved: 1 }
const enrichment = (enriched: number) => ({
  model: "tiny",
  embedded: 1,
  left: false,
  enrichment: { status: "stopped", reason_id: "enrichment.deadline", enriched, failed: 0, left: 5 },
})

describe("sync --embed", () => {
  it("asks for a longer run, not run unasked, when enrichment never had the time to send a batch", async () => {
    const body = await syncWith({ ...done, embeddings: enrichment(0) })
    expect(body.next).toEqual([expect.objectContaining({ step: "sync.longer", safe_to_auto_execute: false })])
  })

  it("adds no such step when enrichment moved, or the CLI skipped the embed", async () => {
    expect((await syncWith({ ...done, embeddings: enrichment(3) })).next ?? []).toEqual([])
    expect((await syncWith({ ...done, embeddings: { skipped: "deadline" } })).next ?? []).toEqual([])
  })
})
