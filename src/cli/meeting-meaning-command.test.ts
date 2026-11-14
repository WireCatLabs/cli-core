import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterEach, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { searchMeetingHits } from "../services/meeting-hit-search.js"
import { meetingMeaning } from "../services/meeting-meaning.js"
import type { MeetingEmbedder } from "../services/meeting-model.js"
import { type MessageStore, openStore } from "../store/store.js"
import { outputFor } from "./context.js"
import { renderAnswer } from "./envelope.js"
import { addMeetingCombinedSearchCommand, addMeetingEmbeddingCommand } from "./meeting-meaning-command.js"
import { pagingOf } from "./paging.js"
import { run } from "./program.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

// Each axis is one invented topic; a text points along every topic one of its words belongs to.
const TOPICS = [
  ["price", "pricing", "cost", "costs", "discount", "invoice", "refund"],
  ["delivery", "courier", "parcel"],
]
const topics: MeetingEmbedder = {
  key: "local:topics:3",
  model: "topics",
  dims: 3,
  kind: "local",
  embed: async (texts) =>
    texts.map((text) => {
      const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
      const vector = new Float32Array(3)
      TOPICS.forEach((topic, axis) => {
        vector[axis] = words.filter((word) => topic.includes(word)).length
      })
      vector[2] = 0.1
      const length = Math.hypot(...vector)
      return vector.map((value) => value / length)
    }),
  close: async () => {},
}

const seed = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "pbx-test-meaning-")), "store.db") })
  stores.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "asterisk", account: "office" }, { name: "Office" })
  const ids: Record<string, number> = {}
  for (const [name, lines] of [
    ["money", ["The discount stays at ten percent.", "We send the invoice on Friday."]],
    ["parcel", ["The courier lost the parcel.", "Delivery moves to Tuesday."]],
  ] as const) {
    const input = sampleMeeting()
    delete input.meeting.series
    input.meeting = { ...input.meeting, accountId, externalId: name, title: `Call ${name}` }
    input.transcripts[0].contentHash = `hash-${name}`
    input.transcripts[0].rows = lines.map((text, position) => ({
      ...input.transcripts[0].rows[0],
      position,
      startMs: position * 1000,
      endMs: position * 1000 + 1000,
      text,
    })) as (typeof input.transcripts)[0]["rows"]
    input.chat = [] as unknown as typeof input.chat
    input.summaries = []
    ids[name] = (await store.meetings.saveMeeting(input)).meeting.id
  }
  return { store, accountId, ids }
}

const pbx = async (store: MessageStore, accountId: number, opened: string[], ...args: string[]) => {
  const app = { command: "pbx", appName: "pbx-cli", envPrefix: "PBX", description: "synthetic", version: "1.0.0" }
  const meaning = async () =>
    meetingMeaning(store, accountId, {
      load: async () => {
        const [model, combined, semantic] = await Promise.all([
          import("../services/meeting-model.js"),
          import("../services/meeting-combined.js"),
          import("../services/meeting-semantic.js"),
        ])
        return {
          ...model,
          ...combined,
          ...semantic,
          meetingEmbeddingModel: (choice) => {
            opened.push(String(choice))
            return { key: topics.key, model: topics.model, dims: topics.dims, kind: topics.kind }
          },
          openMeetingEmbedder: async (choice) => {
            opened.push(String(choice))
            return topics
          },
        }
      },
    })
  const definition = {
    app,
    commands: () => {
      const holder = new Command("pbx")
      holder.command("meetings").description("stored calls")
      const output = (body: Parameters<typeof renderAnswer>[2], command: Command) =>
        renderAnswer(command, outputFor(command), body)
      addMeetingCombinedSearchCommand(holder, {
        words: async () => (query, request) => searchMeetingHits(store, query, { ...request, accountId }),
        meaning,
        signal: () => undefined,
        pagingOf,
        output,
        examples: ['pbx office search meetings "what did they say about the price" --model e5-small --json'],
      })
      addMeetingEmbeddingCommand(holder, {
        meaning,
        defaultModel: () => "topics",
        signal: () => undefined,
        output,
        examples: ["pbx office meetings embed --yes --json"],
      })
      return [...holder.commands]
    },
  }
  const streams = captureStreams()
  const code = await run([...args, "--json", "--no-record"], definition, { streams, tty: false, env: {} })
  const out = streams.stdout.join("")
  return { code, answer: out === "" ? undefined : JSON.parse(out), stderr: streams.stderr.join("") }
}

it("builds the vectors with the local default model, then finds a call by meaning its words never say", async () => {
  const { store, accountId, ids } = await seed()
  const opened: string[] = []

  const preview = await pbx(store, accountId, opened, "meetings", "embed")
  expect(preview.stderr).toBe("")
  expect(preview.code).toBe(0)
  expect(preview.answer.item).toMatchObject({ applied: false, model: { kind: "local", model: "topics" } })
  const built = await pbx(store, accountId, opened, "meetings", "embed", "--yes")
  expect(built.answer.item).toMatchObject({ applied: true, model: { kind: "local", model: "topics" } })
  expect(opened.every((choice) => choice === "topics")).toBe(true)

  const found = await pbx(store, accountId, opened, "search", "meetings", "how much does it cost", "--model", "topics")
  expect(found.stderr).toBe("")
  expect(found.answer.items[0]).toMatchObject({
    meeting: `meeting:${accountId}/${ids.money}`,
    by: ["meaning"],
    untrusted: ["excerpt", "passage.first", "passage.last", "source.title"],
  })
})

it("searches words alone without --model, and never sends text to a remote service offline", async () => {
  const { store, accountId, ids } = await seed()

  const words = await pbx(store, accountId, [], "search", "meetings", "courier")
  expect(words.answer.items.map((hit: { meeting: string }) => hit.meeting)).toEqual([
    `meeting:${accountId}/${ids.parcel}`,
  ])

  const remote = await pbx(
    store,
    accountId,
    [],
    "--offline",
    "search",
    "meetings",
    "cost",
    "--model",
    "text-embedding-3-small",
    "--base-url",
    "https://api.example.com/v1",
    "--dims",
    "3",
  )
  expect(remote.code).not.toBe(0)
  expect(remote.stderr).toContain("remove --offline")
})
