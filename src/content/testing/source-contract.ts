import assert from "node:assert/strict"
import { CliError } from "@wirecat/cli-base"
import {
  CHANNEL_KINDS,
  type ContentKind,
  type ContentRecords,
  POST_STATUSES,
  TERM_KINDS,
} from "../../domain/content.js"
import type { ContractCase } from "../../meetings/index.js"
import type { ContentCallContext, ContentPage, ContentSource } from "../source.js"

/** Faults a case injects; each is opt-in, and a case whose hook is absent passes without running. */
export interface ContentSourceFaults {
  skewed?(ms: number): ContentSource | Promise<ContentSource>
  /** Changes one row on the source's side, for the next `changes()` to list. */
  change?(): { kind: ContentKind; id: string } | Promise<{ kind: ContentKind; id: string }>
  /** Moves one post to the source's trash: it still exists. */
  trash?(): string | Promise<string>
  /** Deletes one row for good. */
  remove?(): { kind: ContentKind; id: string } | Promise<{ kind: ContentKind; id: string }>
}

/** One adapter over recorded or faked answers, fresh for each case. Every kind its traits name lists at least one row. */
export interface ContentSourceFixture {
  source: ContentSource
  /** The ids of every row of each kind, each changed before the overlap. */
  held?: Partial<Record<ContentKind, readonly string[]>>
  deadCursor?: { kind: ContentKind; cursor: string }
  faults?: ContentSourceFaults
}

const SKEW_MS = 10 * 60_000
const MAX_PAGES = 1_000

const idsOf = (items: readonly unknown[]) => items.map((item) => (item as { externalId: string }).externalId)

const listAll = async <K extends ContentKind>(source: ContentSource, kind: K, cursor: string | null) => {
  const items: ContentRecords[K][] = []
  const pages = new Set<string>()
  let page: string | undefined
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const answer = await source.changes(kind, cursor, page)
    assert.ok(!("reset" in answer), `${kind}: a full list is never a dead cursor`)
    const listed = answer as ContentPage<ContentRecords[K]>
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

const allIds = async (source: ContentSource, kind: ContentKind) => {
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
const idList = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every((one) => typeof one === "string"))

/** The shape every record of the kind keeps, in the content domain's fields. */
const checkShape = (kind: ContentKind, record: Record<string, unknown>) => {
  const at = `${kind} ${String(record.externalId)}`
  assert.ok(typeof record.externalId === "string" && record.externalId.trim(), `${kind}: a record has an id`)
  for (const field of ["createdAt", "updatedAt", "publishedAt", "scheduledFor"])
    assert.ok(optionalTime(record[field]), `${at}: ${field} is epoch ms or null`)
  if (kind === "author") {
    assert.ok(typeof record.name === "string", `${at} has its name`)
    assert.ok(optionalText(record.email), `${at}: email is text or null`)
  }
  if (kind === "term") {
    assert.ok(typeof record.name === "string", `${at} has its name`)
    assert.ok((TERM_KINDS as readonly unknown[]).includes(record.kind), `${at}: kind is one of ${TERM_KINDS}`)
  }
  if (kind === "post") {
    assert.ok((POST_STATUSES as readonly unknown[]).includes(record.status), `${at}: status is one of ${POST_STATUSES}`)
    for (const field of ["title", "body", "excerpt", "url", "slug", "channel", "version", "parent"])
      assert.ok(optionalText(record[field]), `${at}: ${field} is text or null`)
    assert.ok(idList(record.authors) && idList(record.terms), `${at}: authors and terms are lists of ids`)
    if (record.status === "scheduled")
      assert.ok(typeof record.scheduledFor === "number", `${at}: a scheduled post says when it goes out`)
  }
}

/** What every content adapter answers, whatever the source: run each case in the adapter's tests. */
export const contentSourceContract = (
  make: () => ContentSourceFixture | Promise<ContentSourceFixture>,
): ContractCase[] => [
  {
    name: "channels: the sign-in names where it publishes, each with its kind, network and name",
    async run() {
      const { source } = await make()
      const channels = await source.channels()
      assert.ok(channels.length > 0, "at least one channel")
      for (const one of channels) {
        assert.ok(typeof one.externalId === "string" && one.externalId, "a channel has an id")
        assert.ok((CHANNEL_KINDS as readonly unknown[]).includes(one.kind), `channel ${one.externalId}: its kind`)
        assert.ok(typeof one.network === "string" && typeof one.name === "string", `channel ${one.externalId}`)
      }
    },
  },
  {
    name: "changes: a full list pages to its end, each record in the content domain's shape",
    async run() {
      const { source } = await make()
      assert.ok(source.traits.kinds.length > 0, "the source names its kinds")
      for (const kind of source.traits.kinds) {
        const { items } = await listAll(source, kind, null)
        assert.ok(items.length > 0, `${kind}: the fixture lists at least one`)
        for (const item of items) checkShape(kind, item as unknown as Record<string, unknown>)
        const ids = idsOf(items)
        assert.equal(new Set(ids).size, ids.length, `${kind}: no row twice in one full list`)
      }
    },
  },
  {
    name: "changes: a full list gives every row the fixture holds, none lost between the source's pages",
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
    name: "get: a post a list gave reads by its id, the same post",
    async run() {
      const { source } = await make()
      if (!source.traits.kinds.includes("post")) return
      const [first] = (await listAll(source, "post", null)).items
      assert.ok(first, "the fixture lists a post")
      const found = await source.get("post", first.externalId)
      assert.equal(found?.externalId, first.externalId)
      assert.equal(found?.status, first.status)
    },
  },
  {
    name: "changes: a dead cursor answers reset",
    async run() {
      const { source, deadCursor } = await make()
      if (!deadCursor) return
      const answer = await source.changes(deadCursor.kind, deadCursor.cursor)
      assert.ok("reset" in answer, `${deadCursor.kind}: a cursor the source refuses answers reset`)
    },
  },
  {
    name: "faults: a clock off by ten minutes either way loses no change",
    async run() {
      for (const ms of [SKEW_MS, -SKEW_MS]) {
        const { faults, held } = await make()
        if (!faults?.skewed || !faults.change) return
        const source = await faults.skewed(ms)
        const cursors = new Map<ContentKind, string | null>()
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
    name: "faults: a trashed post is still listed, in changes and ids, with the status trashed",
    async run() {
      const { source, faults } = await make()
      if (!faults?.trash) return
      const { cursor } = await listAll(source, "post", null)
      const id = await faults.trash()
      const found = (await listAll(source, "post", cursor)).items.find((one) => one.externalId === id)
      assert.ok(found, `post ${id}: a trashed post is in the changes`)
      assert.equal(found.status, "trashed", `post ${id}: trash is a status`)
      assert.ok((await allIds(source, "post")).has(id), `post ${id}: a trashed post is still in ids()`)
    },
  },
  {
    name: "faults: a row deleted for good leaves ids(), and get answers none",
    async run() {
      const { source, faults } = await make()
      if (!faults?.remove) return
      const { kind, id } = await faults.remove()
      assert.ok(!(await allIds(source, kind)).has(id), `${kind} ${id}: a deleted row is not in ids()`)
      assert.equal(await source.get(kind, id), null, `${kind} ${id}: get answers null`)
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
        const first = (await source.changes(kind, null)) as ContentPage<unknown>
        if (!first.hasMore) continue
        cut = true
        const { source: resumed } = await make()
        const rest: unknown[] = []
        let page = first.nextCursor
        for (let read = 0; page !== undefined && read < MAX_PAGES; read += 1) {
          const answer = (await resumed.changes(kind, null, page)) as ContentPage<unknown>
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
        const context: ContentCallContext = {
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
  {
    name: "metrics: a source with numbers reads them per post; one without has none, and that is no error",
    async run() {
      const { source } = await make()
      if (!source.traits.metrics) {
        assert.deepEqual((await source.metrics?.([])) ?? [], [], "no metrics, no readings")
        return
      }
      assert.ok(source.metrics, "a source with metrics reads them")
      const posts = idsOf((await listAll(source, "post", null)).items)
      for (const one of await source.metrics(posts)) {
        assert.ok(posts.includes(one.post), `a reading names a listed post, not ${one.post}`)
        assert.ok(Number.isSafeInteger(one.at), "a reading has its time")
        for (const name of ["views", "reactions", "comments", "shares", "clicks"] as const)
          assert.ok(one[name] == null || Number.isFinite(one[name]), `${one.post}: ${name} is a number`)
      }
    },
  },
]
