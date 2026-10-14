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
    found_in: "both",
    discovery: { coverage: 0.5, matched_terms: ["a"], missing_terms: ["b"] },
    context: [{ ref: message.ref, timestamp: at, sender_name: null, text: "synthetic" }],
  },
  "message.summary": {
    ref: message.ref,
    chat_id: "7",
    chat_title: null,
    timestamp: at,
    sender_name: null,
    outgoing: false,
    text: "synthetic",
    attachments: [],
  },
  message_link: { ref: message.ref, url: null, access: "unavailable", reason: "offline" },
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
  "note.hit": {
    ref: "note:1",
    source: "file",
    folder_id: "f",
    path: "a.md",
    title: "t",
    updated_at: at,
    excerpt: "x",
    found_by: ["words", "meaning"],
    links: [{ to: "person:1", target_text: "Synthetic", kind: "mention", anchor: null }],
  },
  hit: {
    kind: "note",
    ref: "note:1",
    provider: "notes",
    account: "internal",
    title: "t",
    timestamp: at,
    excerpt: "x",
    found_by: ["words"],
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
  model: {
    id: "e5-small",
    kind: "text",
    title: "multilingual-e5-small",
    languages: "100 languages",
    licence: "MIT",
    size_bytes: 120_000_000,
    downloaded: false,
    default: true,
    path: "/home/someone/.local/share/WireCat/models/text/e5-small",
  },
  saved_search: {
    id: "3",
    name: "invoices",
    command: "search",
    params: { text: "invoice chat:7", newest: true },
    language: "lucene",
    version: 1,
    fields_version: 4,
    created_at: at,
    last_run_at: null,
    runs: 0,
  },
  job: {
    id: "a1b2c3",
    chat: "Work",
    state: "partial",
    pid: 4242,
    started_at: at,
    finished_at: at,
    fetched: 120,
    limit: 500,
    complete: false,
    issue: { code: "rate_limited", message: "wait 30 s" },
  },
  agenda: {
    at,
    account: "chat:500",
    stored_at: null,
    stale: true,
    tasks: [
      {
        id: "t1",
        key: "INBOX-1",
        title: "reply to Ana",
        kind: "question",
        source: "msg:chat/500/7/1",
        due_at: null,
        next_check_at: null,
        created_at: at,
        reasons: ["unplanned"],
      },
    ],
    owed: [
      {
        chat: "chat:chat/500/7",
        title: "Work",
        kind: "group",
        last_message: null,
        last_message_at: at,
        last_from_owner: null,
        open_tasks: ["t1"],
      },
    ],
    waiting: [],
    unsynced: [],
  },
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
  chat_event: {
    chat_id: "2",
    time: at,
    type: "join",
    message_id: "5",
    by: { id: "9", name: null },
    people: [{ id: "9", name: "Synthetic" }],
  },
  invite_link: { link: "https://example.test/join/x", approval: false, expires_at: null, max_uses: null },
  join_request: { person_id: "9", name: "Synthetic", username: null, requested_at: at },
  member: { id: "9", name: "Synthetic", username: null, role: "member", score: 2, reasons: ["no_photo"] },
  poll_vote: { person_id: "9", name: null, username: null, answers: ["0"], voted_at: at },
  topic: {
    id: "3",
    title: "Synthetic topic",
    closed: false,
    pinned: false,
    unread_count: 0,
    last_message_at: null,
    created_at: at,
  },
  folder: { id: "2", title: "Synthetic folder", chat_ids: ["7"], include: ["groups"] },
  message_counts: { by: "chat", total: 3, rows: [{ key: "7", ref: "chat:chat/500/7", name: "Book club", count: 3 }] },
  ranking: {
    target: "messages",
    measure: "reactions",
    order: "descending",
    preset: null,
    weights: null,
    min_messages: 1,
    message_kind: "all",
    total: 2,
    population: 2,
    eligible: 1,
    excluded: { minimum: 0, missing: 1, unknown_sender: 0, unknown_kind: 0 },
    maxima: { reactions: 3 },
    counter_freshness: "unknown",
    rows: [
      {
        rank: 1,
        ref: message.ref,
        id: "3",
        chat_ref: "chat:telegram/1/2",
        name: null,
        kind: "posts",
        value: 3,
        components: { reactions: 3 },
        messages: 1,
        known_reactions: 1,
        unknown_reactions: 0,
        score: null,
        quality: { reactions: "known", graph: "not_used", counter_freshness: "unknown" },
        counters: [
          { counter: "views", value: null, observed_at: null, source: null, age_ms: null, freshness: "unknown" },
        ],
        selection: { version: 1 },
      },
    ],
  },
  admin_report: {
    report: "responses",
    cutoff: at,
    total: 1,
    summary: {
      questions: 2,
      answered: 1,
      no_observed_answer: 1,
      excluded_future: 0,
      unknown_join: 0,
      missing_views: 0,
    },
    quality: {
      graph: { unknown_links: 0, unknown_authors: 0, missing_parents: 0, cycles: 0, complete: true },
      archives: [{ chat_ref: "chat:telegram/1/2", state: "complete", fetched_at: null }],
      archives_total: 1,
      membership: "not_used",
      counter_freshness: "unknown",
      answerer_roles: "user_selected_identities",
    },
    rows: [
      {
        ref: "contact:telegram/9",
        id: "9",
        status: "observed",
        identity_known: true,
        questions: 2,
        answered: 1,
        median_ms: 60000,
        p90_ms: null,
        selection: { kind: "admin-statistics" },
      },
    ],
  },
  retention: {
    chat_ref: "chat:telegram/1/2",
    cutoff: at,
    since: at,
    until: at,
    checkpoints_ms: [86400000],
    within_ms: 604800000,
    by: "week",
    timezone: "UTC",
    total: 1,
    unknown_join: 0,
    eligible_stays: 1,
    quality: {
      membership: "observed_checkpoints",
      tolerance_ms: 86400000,
      archive: { state: "unknown", up_to_date: null, gaps: false, reaches_start: false, fetched_at: null },
      continuous_survival: false,
      group_silent_rate: null,
    },
    rows: [
      {
        cohort: "2026-10-12",
        stays: 1,
        checkpoints: [
          { age_ms: 86400000, eligible: 1, observable: 1, present: 1, absent: 0, unknown: 0, pending: 0, rate: 1 },
        ],
        activity: { observed: 1, no_observed: 0, pending: 0, archive_covered: 0 },
        early_departure: { observed: 0, not_observed: 1, unknown: 0, pending: 0 },
        selection: { kind: "retention" },
      },
    ],
  },
  evidence: {
    message: { ref: message.ref, chat_title: null, timestamp: at, sender_name: null, text: "synthetic" },
    contribution: 3,
  },
  counters: {
    cutoff: at,
    max_age_ms: 86400000,
    selection: { kind: "counter-targets", version: 1, locators: [message.ref] },
    rows: [{ ref: message.ref, counters: [] }],
  },
  counter_refresh: {
    dry_run: true,
    targets: [message.ref],
    counters: ["views"],
    supported: ["views"],
    unsupported: [],
    max_messages: 1,
    time_ms: 30000,
  },
  official_stats: {
    chat_id: "2",
    title: "Synthetic channel",
    kind: "channel",
    since: at,
    until: at,
    totals: { followers: { current: 10, previous: 8 } },
    notifications: { enabled: 1, total: 10 },
    recent_posts: [{ kind: "message", id: "5", views: 3, forwards: 0, reactions: 1 }],
    graphs: { growth: { error: "not given" } },
  },
  chart: {
    version: 1,
    kind: "bar",
    title: "Messages",
    x: { type: "day", values: ["2026-10-13"] },
    series: [{ name: "messages", values: [3] }],
    unit: "messages",
    timezone: "UTC",
    partial: false,
    reasons: [],
  },
}

/** The names each entity's fields had elsewhere, which a schema must refuse. */
const renamed: Partial<Record<EntityName, [from: string, to: string]>> = {
  message: ["ref", "locator"],
  message_link: ["ref", "locator"],
  "message.hit": ["timestamp", "sent_at"],
  chat: ["title", "chat_title"],
  contact: ["description", "bio"],
  note: ["updated_at", "modified_at"],
  "note.hit": ["excerpt", "line"],
  hit: ["excerpt", "text"],
  document: ["mime", "mime_type"],
  attachment: ["size", "total_bytes"],
  task: ["state", "status"],
  fact: ["text", "statement"],
  memory: ["text", "body"],
  meeting: ["url", "join_url"],
  chat_event: ["time", "timestamp"],
  invite_link: ["expires_at", "expire_time"],
  join_request: ["requested_at", "requestedAt"],
  poll_vote: ["voted_at", "votedAt"],
  topic: ["unread_count", "unreadCount"],
  folder: ["chat_ids", "chatIds"],
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

  it.each((Object.keys(ENTITIES) as EntityName[]).filter((name) => "entries" in ENTITIES[name]))(
    "give %s query fields a list can register",
    (name) => {
      const fields = queryFieldsOf(ENTITIES[name] as v.GenericSchema, { exclude: ["provider_metadata"] })
      expect(fields.length).toBeGreaterThan(0)
      expect(() => defineQuery({ entity: name, backend: "sql", fields })).not.toThrow()
    },
  )
})
