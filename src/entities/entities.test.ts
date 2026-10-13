import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES, type EntityName, entityDefinitions } from "./index.js"

const at = "2026-10-13T10:00:00.000Z"
const message = {
  ref: "msg:telegram/1/2/3",
  id: "3",
  chatId: "2",
  chatTitle: "Synthetic chat",
  senderId: "9",
  senderName: "Synthetic sender",
  timestamp: at,
  editedAt: null,
  text: "synthetic text",
  excerpt: "synthetic",
  matchedIn: "text",
  score: 1.5,
  outgoing: false,
  attachments: [{ kind: "file", position: 0, name: "a.pdf", mime: "application/pdf", size: 10, text: "body" }],
  replyTo: null,
  forwardedFrom: null,
}
const author = { type: "person", id: "1", name: null }

const samples: Record<EntityName, unknown> = {
  message,
  "message.hit": {
    ref: message.ref,
    chatTitle: "Synthetic chat",
    timestamp: at,
    senderName: null,
    excerpt: "x",
    matchedIn: "file",
    score: 1,
  },
  "message.summary": { ref: message.ref, timestamp: at, senderName: null, text: "synthetic" },
  chat: {
    ref: "chat:telegram/1/2",
    id: "2",
    title: null,
    kind: "group",
    unreadCount: null,
    lastMessageAt: at,
    participantsCount: 3,
  },
  person: { ref: "person:1", name: "Synthetic" },
  identity: { ref: "contact:telegram/9", provider: "telegram", account: "1", id: "9", name: null, username: null },
  contact: {
    ref: "contact:telegram/9",
    id: "9",
    name: "Synthetic",
    username: null,
    description: null,
    lastMessagedAt: null,
  },
  account: { provider: "telegram", id: "1", name: null, username: null },
  note: {
    ref: "note:1",
    id: "1",
    source: "internal",
    folderId: null,
    path: null,
    title: "t",
    text: "x",
    createdAt: at,
    updatedAt: at,
  },
  document: { ref: "document:1", id: "1", title: "t", url: null, modifiedAt: at, storedAt: at },
  attachment: { kind: "photo", width: 10, height: 10 },
  task: { ref: "task:1", id: "1", title: null, kind: "question", state: "open", createdAt: at },
  fact: {
    ref: "fact:1",
    id: "1",
    kind: "decision",
    text: "x",
    status: "accepted",
    project: null,
    subject: null,
    occurredAt: null,
    supersedes: null,
    author,
    model: null,
    scope: null,
    source: "owner",
    evidence: [],
    createdAt: at,
    updatedAt: at,
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
    lastVerifiedAt: null,
    createdAt: at,
    updatedAt: at,
  },
  meeting: {
    ref: "meeting:zoom/1",
    id: "1",
    provider: "zoom",
    account: "a",
    title: null,
    url: null,
    startedAt: at,
    endedAt: null,
    durationMs: null,
    participantsCount: null,
    createdAt: at,
    updatedAt: at,
  },
  reference: "note:42",
}

/** The names each entity's fields had elsewhere, which a schema must refuse. */
const renamed: Partial<Record<EntityName, [from: string, to: string]>> = {
  message: ["ref", "locator"],
  "message.hit": ["timestamp", "sentAt"],
  chat: ["title", "chatTitle"],
  contact: ["description", "bio"],
  note: ["updatedAt", "modifiedAt"],
  document: ["mime", "mimeType"],
  attachment: ["size", "totalBytes"],
  task: ["state", "status"],
  fact: ["text", "statement"],
  memory: ["text", "body"],
  meeting: ["url", "joinUrl"],
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
    expect(v.is(ENTITIES.meeting, { ...(samples.meeting as object), startedAt: 1_760_000_000_000 })).toBe(false)
  })
})
