import assert from "node:assert/strict"
import { CliError } from "@wirecat/cli-base"
import { STATE_TYPES, type TrackerKind, type TrackerRecords } from "../../domain/tracker.js"
import type { ContractCase } from "../../meetings/index.js"
import type { TrackerCallContext, TrackerPage, TrackerSource } from "../source.js"

/** Faults a case injects; each is opt-in, and a case whose hook is absent passes without running. */
export interface TrackerSourceFaults {
  /** A source over the same tracker whose own clock runs `ms` ahead of the tracker's, behind when negative. */
  skewed?(ms: number): TrackerSource | Promise<TrackerSource>
  /** Changes one row on the tracker's side, for the next `changes()` to list. */
  change?(): { kind: TrackerKind; id: string } | Promise<{ kind: TrackerKind; id: string }>
  /** Archives one row on the tracker's side: it stays, listed with `archivedAt`. */
  archive?(): { kind: TrackerKind; id: string } | Promise<{ kind: TrackerKind; id: string }>
  /** Deletes one row on the tracker's side outright. */
  remove?(): { kind: TrackerKind; id: string } | Promise<{ kind: TrackerKind; id: string }>
}

/** One adapter over recorded or faked answers, fresh for each case. Every kind its traits name lists at least one row. */
export interface TrackerSourceFixture {
  source: TrackerSource
  /** The ids of every row of each kind, each changed before the overlap: a full list gives back each of them. */
  held?: Partial<Record<TrackerKind, readonly string[]>>
  /** A cursor the tracker refuses; absent skips that case. */
  deadCursor?: { kind: TrackerKind; cursor: string }
  faults?: TrackerSourceFaults
}

/** Within any change feed's overlap: a computer's clock that is off by more is broken, not skewed. */
const SKEW_MS = 10 * 60_000
const MAX_PAGES = 1_000
const DAY = /^\d{4}-\d{2}-\d{2}$/

const idsOf = (items: readonly unknown[]) => items.map((item) => (item as { externalId: string }).externalId)

/** Every page of one kind from `cursor`, checking each page is new and the last one gives a cursor. */
const listAll = async <K extends TrackerKind>(source: TrackerSource, kind: K, cursor: string | null) => {
  const items: TrackerRecords[K][] = []
  const pages = new Set<string>()
  let page: string | undefined
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const answer = await source.changes(kind, cursor, page)
    assert.ok(!("reset" in answer), `${kind}: a full list is never a dead cursor`)
    const listed = answer as TrackerPage<TrackerRecords[K]>
    assert.ok(Array.isArray(listed.items), `${kind}: a page has items`)
    items.push(...listed.items)
    assert.equal(listed.hasMore, listed.nextCursor !== undefined, `${kind}: a next cursor exactly when there is more`)
    if (!listed.hasMore) {
      assert.ok(listed.cursor === null || typeof listed.cursor === "string", `${kind}: the last page gives a cursor`)
      return { items, cursor: listed.cursor ?? null }
    }
    const next = listed.nextCursor as string
    assert.ok(!pages.has(next), `${kind}: the same page twice`)
    pages.add(next)
    page = next
  }
  throw new assert.AssertionError({ message: `${kind}: more than ${MAX_PAGES} pages` })
}

const allIds = async (source: TrackerSource, kind: TrackerKind) => {
  const listed = new Set<string>()
  let page: string | undefined
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const answer = await source.ids(kind, page)
    for (const id of answer.items) listed.add(id)
    if (!answer.hasMore) return listed
    assert.ok(answer.nextCursor !== undefined && answer.nextCursor !== page, `${kind}: ids() gives a new page`)
    page = answer.nextCursor
  }
  throw new assert.AssertionError({ message: `${kind}: more than ${MAX_PAGES} pages of ids` })
}

const optionalText = (value: unknown) => value === undefined || value === null || typeof value === "string"
const optionalTime = (value: unknown) =>
  value === undefined || value === null || (typeof value === "number" && Number.isSafeInteger(value))

/** The shape every record of the kind keeps, in the tracker domain's fields. */
const checkShape = (kind: TrackerKind, record: Record<string, unknown>) => {
  const at = `${kind} ${String(record.externalId)}`
  assert.ok(typeof record.externalId === "string" && record.externalId.trim(), `${kind}: a record has an id`)
  for (const field of ["createdAt", "updatedAt", "archivedAt", "completedAt", "canceledAt"])
    assert.ok(optionalTime(record[field]), `${at}: ${field} is epoch ms or null`)
  const named = kind === "issue" ? "title" : kind === "comment" ? "body" : "name"
  assert.ok(typeof record[named] === "string", `${at} has its ${named}`)
  if (kind === "state")
    assert.ok((STATE_TYPES as readonly string[]).includes(String(record.type)), `${at}: type is one of ${STATE_TYPES}`)
  if (kind === "comment") assert.ok(typeof record.issue === "string", `${at} names its issue`)
  for (const field of ["team", "state", "project", "assignee", "creator", "lead", "author", "parent", "key", "email"])
    assert.ok(optionalText(record[field]), `${at}: ${field} is an id or text, or null`)
  for (const field of ["labels", "teams"])
    if (record[field] !== undefined)
      assert.ok(
        Array.isArray(record[field]) && (record[field] as unknown[]).every((one) => typeof one === "string"),
        `${at}: ${field} is a list of ids`,
      )
  for (const field of ["dueDate", "targetDate"])
    if (record[field] !== undefined && record[field] !== null)
      assert.match(String(record[field]), DAY, `${at}: ${field} is YYYY-MM-DD`)
  if (record.priority !== undefined && record.priority !== null)
    assert.ok(Number.isFinite(record.priority), `${at}: priority is a number`)
}

/** What every tracker adapter answers, whatever the tracker: run each case in the adapter's tests. */
export const trackerSourceContract = (
  make: () => TrackerSourceFixture | Promise<TrackerSourceFixture>,
): ContractCase[] => [
  {
    name: "changes: a full list pages to its end, each record in the tracker domain's shape",
    async run() {
      const { source } = await make()
      assert.ok(source.traits.kinds.length > 0, "the tracker names its kinds")
      const listed = new Map<TrackerKind, Set<string>>()
      for (const kind of source.traits.kinds) {
        const { items } = await listAll(source, kind, null)
        assert.ok(items.length > 0, `${kind}: the fixture lists at least one`)
        for (const item of items) checkShape(kind, item as unknown as Record<string, unknown>)
        const ids = idsOf(items)
        assert.equal(new Set(ids).size, ids.length, `${kind}: no row twice in one full list`)
        listed.set(kind, new Set(ids))
      }
      // An issue's state and team, when both kinds are read, are rows the copy will hold.
      for (const issue of listed.has("issue") ? (await listAll(source, "issue", null)).items : [])
        for (const [field, kind] of [
          ["state", "state"],
          ["team", "team"],
        ] as const) {
          const id = issue[field]
          if (typeof id === "string" && listed.has(kind))
            assert.ok(listed.get(kind)?.has(id), `issue ${issue.externalId}: its ${field} ${id} is listed`)
        }
    },
  },
  {
    name: "changes: a full list gives every row the fixture holds, none lost between the tracker's pages",
    async run() {
      const { source, held } = await make()
      if (!held) return
      for (const kind of source.traits.kinds) {
        const ids: readonly string[] | undefined = held[kind]
        if (!ids) continue
        assert.deepEqual(idsOf((await listAll(source, kind, null)).items).sort(), [...ids].sort(), `${kind}: every row`)
      }
    },
  },
  {
    name: "changes: the cursor a full list gave reads again without failing",
    async run() {
      const { source } = await make()
      for (const kind of source.traits.kinds) {
        const { cursor } = await listAll(source, kind, null)
        if (cursor !== null) await listAll(source, kind, cursor)
      }
    },
  },
  {
    name: "ids: a list of every id holds every row a full list gave",
    async run() {
      const { source } = await make()
      for (const kind of source.traits.kinds) {
        const listed = await allIds(source, kind)
        for (const id of idsOf((await listAll(source, kind, null)).items))
          assert.ok(listed.has(id), `${kind} ${id} is missing from ids()`)
      }
    },
  },
  {
    name: "self: names the signed-in user as an id among the tracker's users, the id an issue's assignee holds",
    async run() {
      const { source, held } = await make()
      if (!source.self) return
      const self = await source.self()
      assert.ok(typeof self === "string" && self.trim(), "self() answers an id")
      if (!source.traits.kinds.includes("user")) return
      const users = held?.user ?? idsOf((await listAll(source, "user", null)).items)
      assert.ok(users.includes(self), `self() answers ${self}, which no user of the tracker holds`)
    },
  },
  {
    name: "changes: a dead cursor answers reset",
    async run() {
      const { source, deadCursor } = await make()
      if (!deadCursor) return
      const answer = await source.changes(deadCursor.kind, deadCursor.cursor)
      assert.ok("reset" in answer, `${deadCursor.kind}: a cursor the tracker refuses answers reset`)
    },
  },
  {
    name: "faults: a clock off by ten minutes either way loses no change",
    async run() {
      for (const ms of [SKEW_MS, -SKEW_MS]) {
        const { faults, held } = await make()
        if (!faults?.skewed || !faults.change) return
        const source = await faults.skewed(ms)
        const cursors = new Map<TrackerKind, string | null>()
        for (const kind of source.traits.kinds) cursors.set(kind, (await listAll(source, kind, null)).cursor)
        const { kind, id } = await faults.change()
        const cursor = cursors.get(kind) ?? null
        assert.ok(cursor !== null, `${kind}: a full list gives a cursor for the change to be read after`)
        const { items } = await listAll(source, kind, cursor)
        assert.ok(idsOf(items).includes(id), `${kind} ${id} is in the changes with the clock ${ms / 60_000} min off`)
        for (const one of held?.[kind]?.filter((other) => other !== id) ?? [])
          assert.ok(!idsOf(items).includes(one), `${kind} ${one} did not change, yet a read of changes lists it`)
      }
    },
  },
  {
    name: "faults: an archived row is still listed, in changes and ids, with its archive time",
    async run() {
      const { source, faults } = await make()
      if (!faults?.archive) return
      const cursors = new Map<TrackerKind, string | null>()
      for (const kind of source.traits.kinds) cursors.set(kind, (await listAll(source, kind, null)).cursor)
      const { kind, id } = await faults.archive()
      const { items } = await listAll(source, kind, cursors.get(kind) ?? null)
      const found = items.find((one) => one.externalId === id)
      assert.ok(found, `${kind} ${id}: an archived row is in the changes`)
      assert.ok(typeof found.archivedAt === "number", `${kind} ${id} carries archivedAt`)
      assert.ok((await allIds(source, kind)).has(id), `${kind} ${id}: an archived row is still in ids()`)
    },
  },
  {
    name: "faults: a row deleted outright leaves ids()",
    async run() {
      const { source, faults } = await make()
      if (!faults?.remove) return
      const { kind, id } = await faults.remove()
      assert.ok(!(await allIds(source, kind)).has(id), `${kind} ${id}: a deleted row is not in ids()`)
    },
  },
  {
    name: "faults: a full list cut after its first page goes on from that page in a new run, nothing lost or repeated",
    async run() {
      const { source, faults } = await make()
      if (!faults) return
      let cut = false
      for (const kind of source.traits.kinds) {
        const whole = idsOf((await listAll(source, kind, null)).items)
        const first = (await source.changes(kind, null)) as TrackerPage<unknown>
        if (!first.hasMore) continue
        cut = true
        const { source: resumed } = await make()
        const rest: unknown[] = []
        let page = first.nextCursor
        for (let read = 0; page !== undefined && read < MAX_PAGES; read += 1) {
          const answer = (await resumed.changes(kind, null, page)) as TrackerPage<unknown>
          rest.push(...answer.items)
          page = answer.nextCursor
        }
        const joined = [...idsOf(first.items), ...idsOf(rest)]
        assert.equal(new Set(joined).size, joined.length, `${kind}: no row twice across the cut`)
        assert.deepEqual(joined.sort(), whole.sort(), `${kind}: the cut list adds up to the whole one`)
      }
      assert.ok(cut, "the fixture holds more than one page of some kind, so a list can be cut")
    },
  },
  {
    name: "faults: a call that pages inside stops when the run's budget is spent, and says so",
    async run() {
      const { source, faults } = await make()
      if (!faults) return
      const spent = new CliError("provider_error", "the run's budget is spent", { reason: "sync.partial" })
      for (const kind of source.traits.kinds) {
        let asked = false
        const context: TrackerCallContext = {
          spend: () => {
            asked = true
            throw spent
          },
          gap: () => {},
        }
        const ended = await source.changes(kind, null, undefined, context).then(
          () => undefined,
          (error: unknown) => error,
        )
        if (asked) assert.equal(ended, spent, `${kind}: a spent budget ends the call with its own error`)
        else assert.equal(ended, undefined, `${kind}: a call that asks for no more requests is not stopped`)
      }
    },
  },
]
