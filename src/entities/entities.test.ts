import { defineQuery, queryFieldsOf } from "@wirecat/cli-base/query"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES, type EntityName, entityDefinitions } from "./index.js"

const at = "2026-10-13T10:00:00.000Z"
const message = {
  ref: "msg:telegram/1/2/3",
  id: "3",
  chat_id: "2",
  chat_title: "Synthetic chat",
  sender_id: "9",
  sender_name: "Synthetic sender",
  timestamp: at,
  edited_at: null,
  text: "synthetic text",
  excerpt: "synthetic",
  matched_in: "text",
  score: 1.5,
  outgoing: false,
  attachments: [{ kind: "file", position: 0, name: "a.pdf", mime: "application/pdf", size: 10, text: "body" }],
  reply_to: null,
  forwarded_from: null,
}
const author = { type: "person", id: "1", name: null }

const samples: Record<EntityName, unknown> = {
  message,
  "message.hit": {
    ref: message.ref,
    chat_title: "Synthetic chat",
    timestamp: at,
    sender_name: null,
    excerpt: "x",
    matched_in: "file",
    score: 1,
  },
  "message.summary": { ref: message.ref, timestamp: at, sender_name: null, text: "synthetic" },
  chat: {
    ref: "chat:telegram/1/2",
    id: "2",
    title: null,
    kind: "group",
    unread_count: null,
    last_message_at: at,
    participants_count: 3,
  },
  person: { ref: "person:1", name: "Synthetic" },
  identity: { ref: "contact:telegram/9", provider: "telegram", account: "1", id: "9", name: null, username: null },
  contact: {
    ref: "contact:telegram/9",
    id: "9",
    name: "Synthetic",
    username: null,
    description: null,
    last_messaged_at: null,
  },
  account: { provider: "telegram", id: "1", name: null, username: null },
  note: {
    ref: "note:1",
    id: "1",
    source: "internal",
    folder_id: null,
    path: null,
    title: "t",
    text: "x",
    created_at: at,
    updated_at: at,
  },
  document: { ref: "document:1", id: "1", title: "t", url: null, source_modified_at: at, stored_at: at },
  attachment: { kind: "photo", width: 10, height: 10 },
  task: { ref: "task:1", id: "1", title: null, kind: "question", state: "open", created_at: at },
  fact: {
    ref: "fact:1",
    id: "1",
    kind: "decision",
    text: "x",
    status: "accepted",
    project: null,
    subject: null,
    occurred_at: null,
    supersedes: null,
    author,
    model: null,
    scope: null,
    origin: "owner",
    evidence: [],
    created_at: at,
    updated_at: at,
  },
  memory: {
    ref: "memory:1",
    id: "1",
    kind: "summary",
    text: "x",
    subject: null,
    author,
    model: null,
    confidence: null,
    status: "proposed",
    scope: "work",
    supersedes: null,
    evidence: ["msg:telegram/1/2/3"],
    last_verified_at: null,
    created_at: at,
    updated_at: at,
  },
  meeting: {
    ref: "meeting:zoom/1",
    id: "1",
    provider: "zoom",
    account: "a",
    title: null,
    url: null,
    started_at: at,
    ended_at: null,
    duration_ms: null,
    participants_count: null,
    created_at: at,
    updated_at: at,
  },
  reference: "note:42",
  conversation: {
    id: "1",
    chat: "chat:chat/500/7",
    first_message: "msg:chat/500/7/101",
    started_at: at,
    ended_at: at,
    messages_count: 3,
    senders_count: 2,
    built_at: at,
    rules_version: 1,
  },
  tagging: {
    tag: "work",
    type: "chat",
    target: "chat:chat/500/7",
    name: "Book club",
    sources: ["manual"],
    created_at: at,
  },
}

/** The names each entity's fields had elsewhere, which a schema must refuse. */
const renamed: Partial<Record<EntityName, [from: string, to: string]>> = {
  message: ["ref", "locator"],
  "message.hit": ["timestamp", "sent_at"],
  chat: ["title", "chat_title"],
  contact: ["description", "bio"],
  note: ["updated_at", "modified_at"],
  document: ["mime", "mime_type"],
  attachment: ["size", "total_bytes"],
  task: ["state", "status"],
  fact: ["text", "statement"],
  memory: ["text", "body"],
  meeting: ["url", "join_url"],
}

const rename = (sample: unknown, [from, to]: [string, string]) => {
  const { [from]: value, ...rest } = sample as Record<string, unknown>
  return { ...rest, [to]: value ?? "x" }
}

describe.each(Object.keys(ENTITIES) as EntityName[])("the %s entity", (name) => {
  const schema = ENTITIES[name] as v.GenericSchema

  it("accepts a synthetic sample", () => {
    const parsed = v.safeParse(schema, samples[name])
    expect(parsed.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`)).toBeUndefined()
  })

  it("refuses a field under another name", () => {
    const names = renamed[name]
    if (names) expect(v.is(schema, rename(samples[name], names))).toBe(false)
    else if (name === "reference") expect(v.is(schema, "note 42")).toBe(false)
    else expect(v.is(schema, { ...(samples[name] as object), unexpected: true })).toBe(false)
  })
})

describe("entity definitions", () => {
  it("carry every entity as JSON Schema with no network reference", () => {
    const definitions = entityDefinitions()
    expect(Object.keys(definitions)).toEqual(Object.keys(ENTITIES))
    expect(JSON.stringify(definitions)).not.toMatch(/"\$ref":"https?:/)
  })

  it("keep times as ISO strings", () => {
    expect(v.is(ENTITIES.meeting, { ...(samples.meeting as object), started_at: 1_760_000_000_000 })).toBe(false)
  })
})

const keysOf = (schema: unknown, path = ""): string[] => {
  if (Array.isArray(schema)) return schema.flatMap((one) => keysOf(one, path))
  if (schema === null || typeof schema !== "object") return []
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "properties" && value && typeof value === "object"
      ? Object.entries(value).flatMap(([name, inner]) => [`${path}${name}`, ...keysOf(inner, `${path}${name}.`)])
      : keysOf(value, path),
  )
}

describe("entity keys", () => {
  it("are snake_case in every entity, nested ones too", () => {
    const keys = keysOf(entityDefinitions())
    expect(keys.length).toBeGreaterThan(100)
    expect(keys.filter((key) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(key.split(".").at(-1) ?? ""))).toEqual([])
  })

  it.each((Object.keys(ENTITIES) as EntityName[]).filter((name) => name !== "reference"))(
    "give %s query fields a list can register",
    (name) => {
      const fields = queryFieldsOf(ENTITIES[name] as v.GenericSchema, { exclude: ["provider_metadata"] })
      expect(fields.length).toBeGreaterThan(0)
      expect(() => defineQuery({ entity: name, backend: "sql", fields })).not.toThrow()
    },
  )
})
