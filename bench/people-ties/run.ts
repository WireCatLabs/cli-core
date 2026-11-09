import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { openCache } from "../../dist/store/open.js"
import { shownReasons } from "../../dist/store/sqlite/person-ties.js"
import { openStore } from "../../dist/store/store.js"

// Whether `people list` can tell real people from background ones on every read, or needs them stored.
// Run: pnpm build && node bench/people-ties/run.ts. A synthetic store; no real data.
const IDENTITIES = Number(process.env.TIES_IDENTITIES ?? 51_000)
const DIALOGS = 3_000
const SMALL_GROUPS = 300
const UNKNOWN_SIZE_GROUPS = 100
const LARGE_GROUPS = 1_600
const INCOMING_MAIL = 30_000
const OUTGOING_MAIL = 2_000
const MEETINGS = 400
const BOOK = 1_500
const CRM_RECORDS = 300
const MERGES = 1_000
const TASKS = 200
const RUNS = 7
const NOW = Date.parse("2026-11-01T12:00:00Z")

let seed = 42
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}
const pick = (n: number) => 1 + Math.floor(random() * n)

// TIES_STORE reuses a seeded store, so a second measurement does not pay for the seeding again.
const path = process.env.TIES_STORE ?? join(mkdtempSync(join(tmpdir(), "people-ties-")), "wirecat.db")
const seeded = existsSync(path)
const env = { ...process.env, MESSAGING_STORE: path }
await (await openStore({ env })).close()

const db = await openCache(path)
const began = performance.now()
const store = await openStore({ env })
const seedStore = async () => {
  db.exec("BEGIN")
  const tg = Number(
    db
      .prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('telegram', '1', ?, ?) RETURNING id")
      .get(NOW, NOW)?.id,
  )
  const mail = Number(
    db
      .prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('email', 'me@example.test', ?, ?) RETURNING id")
      .get(NOW, NOW)?.id,
  )
  const identity = db.prepare(
    "INSERT INTO identities (provider, external_id, name, username, created_at, updated_at) VALUES ('telegram', ?, ?, ?, ?, ?) RETURNING id",
  )
  const person = db.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id")
  const link = db.prepare(
    "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) VALUES (?, ?, 'initial', 1, ?, 'ingest', ?)",
  )
  const seen = db.prepare(
    "INSERT INTO account_identities (account_id, identity_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
  const FIRST = ["Ivan", "Maria", "Olga", "Pedro", "Lucia", "Anna", "Sergey", "Elena", "Jorge", "Rin"]
  const LAST = ["Petrov", "Garcia", "Ivanova", "Lopez", "Smirnov", "Martin", "Kuznetsova", "Sanchez"]
  for (let n = 1; n <= IDENTITIES; n++) {
    const name = n % 97 === 0 ? "!" : `${FIRST[n % FIRST.length]} ${LAST[n % LAST.length]} ${n}`
    const id = Number(identity.get(String(n), name, n % 3 === 0 ? `user${n}` : null, NOW, NOW)?.id)
    const owner = Number(person.get(name, NOW, NOW)?.id)
    link.run(id, owner, NOW, NOW)
    seen.run(tg, id, NOW, NOW)
  }
  const ownerIdentity = 1
  db.prepare("UPDATE persons SET owner = 1 WHERE id = (SELECT person_id FROM identity_links WHERE identity_id = ?)").run(
    ownerIdentity,
  )

  const chat = db.prepare(
    "INSERT INTO chats (account_id, external_id, kind, participants_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
  )
  const member = db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, identity_id, created_at) VALUES (?, ?, ?)")
  const members = (chatId: number, count: number) => {
    member.run(chatId, ownerIdentity, NOW)
    for (let m = 0; m < count; m++) member.run(chatId, pick(IDENTITIES), NOW)
  }
  for (let n = 0; n < DIALOGS; n++) {
    const id = Number(chat.get(tg, `d${n}`, "dialog", 2, NOW, NOW)?.id)
    members(id, 1)
  }
  for (let n = 0; n < SMALL_GROUPS; n++) {
    const size = 3 + (n % 12)
    const id = Number(chat.get(tg, `s${n}`, "group", size, NOW, NOW)?.id)
    members(id, size - 1)
  }
  for (let n = 0; n < UNKNOWN_SIZE_GROUPS; n++) {
    const id = Number(chat.get(tg, `u${n}`, "group", null, NOW, NOW)?.id)
    members(id, 5)
  }
  for (let n = 0; n < LARGE_GROUPS; n++) {
    const size = 50 + Math.floor(random() * 5_000)
    const id = Number(chat.get(tg, `l${n}`, n % 10 === 0 ? "channel" : "group", size, NOW, NOW)?.id)
    members(id, Math.min(size, 30 + Math.floor(random() * 270)))
  }

  const thread = db.prepare(
    "INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
  )
  const email = db.prepare(
    "INSERT INTO emails (account_id, email_thread_id, external_id, from_identity_id, outgoing, body_text, sent_at, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
  )
  const recipient = db.prepare(
    "INSERT INTO email_recipients (email_id, identity_id, address, role, position, created_at, updated_at) VALUES (?, ?, ?, 'to', ?, ?, ?)",
  )
  const body = "Synthetic body text. ".repeat(100)
  for (let n = 0; n < INCOMING_MAIL + OUTGOING_MAIL; n++) {
    const outgoing = n >= INCOMING_MAIL
    const threadId = Number(thread.get(mail, `t${n}`, NOW, NOW)?.id)
    const sender = outgoing ? ownerIdentity : 40_000 + (n % 3_000)
    const id = Number(email.get(mail, threadId, `m${n}`, sender, outgoing ? 1 : 0, body, NOW - n, NOW, NOW)?.id)
    const to = outgoing ? [pick(IDENTITIES), pick(IDENTITIES)] : [ownerIdentity]
    to.forEach((who, at) => recipient.run(id, who, `p${who}@example.test`, at, NOW, NOW))
  }

  const meeting = db.prepare(
    "INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
  )
  const participant = db.prepare(
    "INSERT OR IGNORE INTO meeting_participants (meeting_id, identity_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
  for (let n = 0; n < MEETINGS; n++) {
    const id = Number(meeting.get(mail, `meet${n}`, NOW, NOW)?.id)
    for (let p = 0; p < 4; p++) participant.run(id, pick(IDENTITIES), NOW, NOW)
  }
  db.prepare(
    `UPDATE account_identities SET address_book = 1 WHERE account_id = ? AND identity_id IN (SELECT id FROM identities ORDER BY random() LIMIT ${BOOK})`,
  ).run(tg)
  const record = db.prepare(
    "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, entity_type, entity_id, created_at, updated_at) " +
      "VALUES (?, 'person', ?, '{}', ?, 'b', 'person', (SELECT person_id FROM identity_links WHERE identity_id = ?), ?, ?)",
  )
  for (let n = 0; n < CRM_RECORDS; n++) record.run(mail, `r${n}`, `f${n}`, pick(IDENTITIES), NOW, NOW)
  db.exec("COMMIT")
  for (let n = 0; n < MERGES; n++)
    await store.people.linkIdentities(
      { provider: "telegram", id: String(2 * n + 2) },
      { provider: "telegram", id: String(2 * n + 3) },
      { method: "manual", by: "owner" },
    )
  await store.knowledge.addProject({ name: "Harbour", key: "HRB", type: "work" })
  for (let n = 0; n < TASKS; n++) {
    const task = await store.tasks.create({ project: "HRB", title: `T${n}`, type: "chore" }, "owner")
    await store.tasks.assign(task.id, { to: `person:${10 + n * 37}`, role: "assignee" }, "owner")
  }
  for (let n = 0; n < 20; n++) await store.people.add({ name: `Hand Added ${n}` })
}
if (!seeded) await seedStore()
const seededMs = performance.now() - began

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
const time = async (work: () => unknown): Promise<number> => {
  await work()
  const runs: number[] = []
  for (let n = 0; n < RUNS; n++) {
    const start = performance.now()
    await work()
    runs.push(performance.now() - start)
  }
  return Math.round(median(runs) * 10) / 10
}

const first = await store.people.list({ limit: 50 })
const read = {
  firstPage: await time(() => store.people.list({ limit: 50 })),
  pageTwenty: await time(() => store.people.list({ limit: 50, offset: 950 })),
  byName: await time(() => store.people.list({ limit: 50, sort: "name" })),
  all: await time(() => store.people.list({ limit: 50, all: true })),
  query: await time(() => store.people.list({ limit: 50, query: "Garcia 12" })),
  similarLong: await time(() => store.people.similar("ivan petrov")),
  similarShort: await time(() => store.people.similar("iv")),
  scanFull: await time(() => store.people.scanMatches({ full: true })),
}

// The other way: the shown people kept in a table, refreshed after each sync.
const stored = {
  refresh: await time(() => {
    const reasons = shownReasons(db)
    db.exec("BEGIN")
    db.exec("DROP TABLE IF EXISTS temp.person_ties")
    db.exec("CREATE TEMP TABLE person_ties (person INTEGER PRIMARY KEY, ties TEXT NOT NULL)")
    const row = db.prepare("INSERT INTO temp.person_ties (person, ties) VALUES (?, ?)")
    for (const [person, ties] of reasons) row.run(person, ties.join(","))
    db.exec("COMMIT")
  }),
  firstPage: await time(() => {
    db.prepare(
      "SELECT count(*), sum(p.id NOT IN (SELECT person FROM temp.person_ties)) FROM persons p WHERE p.owner = 1 OR " +
        "EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = p.id)",
    ).get()
    db.prepare(
      "SELECT p.id, p.name FROM persons p WHERE p.id IN (SELECT person FROM temp.person_ties) " +
        "ORDER BY p.owner DESC, p.name COLLATE NOCASE, p.id LIMIT 51",
    ).all()
  }),
}
const reasonsAlone = await time(() => shownReasons(db))

const counts = db
  .prepare(
    "SELECT (SELECT count(*) FROM identities) AS identities, (SELECT count(*) FROM persons) AS persons, " +
      "(SELECT count(*) FROM chat_members) AS member_rows, (SELECT count(*) FROM emails) AS emails, (SELECT count(*) FROM chats) AS chats",
  )
  .get()
console.log(
  JSON.stringify(
    {
      shape: {
        ...counts,
        dialogs: DIALOGS,
        smallGroups: SMALL_GROUPS,
        unknownSizeGroups: UNKNOWN_SIZE_GROUPS,
        largeGroupsAndChannels: LARGE_GROUPS,
        outgoingMail: OUTGOING_MAIL,
        meetings: MEETINGS,
        addressBook: BOOK,
        crmRecords: CRM_RECORDS,
        merges: MERGES,
        tasks: TASKS,
      },
      seededMs: Math.round(seededMs),
      shownTotal: first.total,
      hidden: first.hidden,
      medianMs: { read, stored, reasonsAlone },
    },
    null,
    2,
  ),
)
await store.close()
