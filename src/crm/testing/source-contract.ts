import assert from "node:assert/strict"
import { CliError } from "@wirecat/cli-base"
import { type CrmItem, type CrmKind, type CrmPerson, isItemKind } from "../../domain/crm.js"
import { DEAL_KINDS, type DealKind, STAGE_OUTCOMES } from "../../domain/deals.js"
import type { ContractCase } from "../../meetings/index.js"
import type { CrmCallContext, CrmLiveKind, CrmPage, CrmSource } from "../source.js"

/** Faults a case injects; each is opt-in, and a case whose hook is absent passes without running. */
export interface CrmSourceFaults {
  /** Makes one contact or company answer HTTP `status` from now on, as the CRM would, and names it. */
  deny?(status: 403 | 404): { kind: CrmLiveKind; id: string } | Promise<{ kind: CrmLiveKind; id: string }>
  /** A source over the same CRM whose own clock runs `ms` ahead of the CRM's, behind when negative. */
  skewed?(ms: number): CrmSource | Promise<CrmSource>
  /** Changes one row on the CRM's side, for the next `changes()` to list. */
  change?(): { kind: CrmKind; id: string } | Promise<{ kind: CrmKind; id: string }>
  /** A source for a second profile signed in with the same token. */
  sameToken?(): CrmSource | Promise<CrmSource>
}

/**
 * One adapter over recorded or faked responses, fresh for each case. Every kind its traits name must list at least
 * one row, so the checks have something to look at.
 */
export interface CrmSourceFixture {
  source: CrmSource
  /**
   * The ids of every contact and company the fixture holds, required when the source has `list`: a live list must give
   * back each of them.
   */
  live?: Partial<Record<"person" | "organization", readonly string[]>>
  /**
   * The ids of every row of each kind the fixture holds, each changed before the change feed's overlap: a full list
   * must give back each of them, and a read of changes after `change()` must leave the untouched ones out.
   */
  held?: Partial<Record<CrmKind, readonly string[]>>
  /** A cursor the CRM refuses; absent skips that case. */
  deadCursor?: { kind: CrmKind; cursor: string }
  /** Faults for the opt-in fault cases; given, the cases that need no hook run too. */
  faults?: CrmSourceFaults
}

/** Within any change feed's overlap: a computer's clock that is off by more is broken, not skewed. */
const SKEW_MS = 10 * 60_000

const idsOf = (items: readonly unknown[]) => items.map((item) => (item as { externalId: string }).externalId)

const MAX_PAGES = 1_000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL = /^\d{1,16}(\.\d{1,6})?$/

/** Every page of one kind from `cursor`, checking each page is new and the last one gives a cursor. */
const listAll = async (source: CrmSource, kind: CrmKind, cursor: string | null) => {
  const items: unknown[] = []
  const pages = new Set<string>()
  let page: string | undefined
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const answer = await source.changes(kind, cursor, page)
    assert.ok(!("reset" in answer), `${kind}: a full list is never a dead cursor`)
    const listed = answer as CrmPage<unknown>
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

/** What every CRM adapter answers, whatever the CRM: run each case in the adapter's tests. */
export const crmSourceContract = (make: () => CrmSourceFixture | Promise<CrmSourceFixture>): ContractCase[] => {
  const cases: ContractCase[] = [
    {
      name: "self: a source that names its own user gives it as a user id, and every deal and lead an assignee",
      async run() {
        const { source } = await make()
        if (!source.self) return
        assert.match(String(await source.self()), /^\d{1,20}$/, "self() answers a numeric user id")
        for (const kind of DEAL_KINDS.filter((one) => source.traits.kinds.includes(one)))
          for (const item of (await listAll(source, kind, null)).items as CrmItem[])
            assert.ok(item.assignee, `${kind} ${item.externalId} has an assignee: mine would keep it as nobody's`)
      },
    },
    {
      name: "pipelines: unique ids in each kind, stages with a known outcome and unique ids",
      async run() {
        const { source } = await make()
        for (const kind of DEAL_KINDS.filter((one) => source.traits.kinds.includes(one))) {
          const seen = new Set<string>()
          const pipelines = await source.pipelines(kind)
          assert.ok(pipelines.length > 0, `${kind}: at least one pipeline`)
          for (const pipeline of pipelines) {
            assert.ok(!seen.has(pipeline.externalId), `pipeline ${pipeline.externalId} is listed twice`)
            seen.add(pipeline.externalId)
            assert.ok(pipeline.name.trim(), `pipeline ${pipeline.externalId} has a name`)
            assert.ok(pipeline.stages.length > 0, `pipeline ${pipeline.externalId} has stages`)
            const stages = new Set(pipeline.stages.map(({ externalId }) => externalId))
            assert.equal(stages.size, pipeline.stages.length, `pipeline ${pipeline.externalId}: stage ids are unique`)
            for (const stage of pipeline.stages) {
              assert.ok(
                (STAGE_OUTCOMES as readonly string[]).includes(stage.outcome),
                `stage ${stage.externalId}'s outcome`,
              )
              assert.ok(Number.isFinite(stage.position), `stage ${stage.externalId}'s position is a number`)
            }
          }
        }
      },
    },
    {
      name: "fields: unique codes in each kind, a type, yes-or-no flags, and a list field's options with unique ids",
      async run() {
        const { source } = await make()
        if (!source.fields) return
        for (const kind of source.traits.kinds) {
          const fields = await source.fields(kind)
          assert.ok(Array.isArray(fields), `${kind}: fields() answers a list`)
          const codes = new Set<string>()
          for (const field of fields) {
            assert.ok(typeof field.code === "string" && field.code.trim(), `${kind}: a field has a code`)
            assert.ok(!codes.has(field.code), `${kind} field ${field.code} is listed twice`)
            codes.add(field.code)
            assert.ok(field.label === null || typeof field.label === "string", `${field.code}: a label or null`)
            assert.ok(typeof field.type === "string" && field.type.trim(), `${field.code} has a type`)
            assert.equal(typeof field.multiple, "boolean", `${field.code}: multiple is true or false`)
            assert.equal(typeof field.filterable, "boolean", `${field.code}: filterable is true or false`)
            if (field.options === undefined) continue
            const ids = new Set(field.options.map(({ id }) => id))
            assert.equal(ids.size, field.options.length, `${field.code}: option ids are unique`)
            for (const option of field.options)
              assert.ok(typeof option.id === "string" && typeof option.label === "string", `${field.code}'s options`)
          }
        }
      },
    },
    {
      name: "changes: a full list pages to its end, every item stands in a listed stage, fields in the neutral shape",
      async run() {
        const { source } = await make()
        const stages = new Map<DealKind, Set<string>>()
        for (const kind of DEAL_KINDS.filter((one) => source.traits.kinds.includes(one)))
          stages.set(
            kind,
            new Set(
              (await source.pipelines(kind)).flatMap((pipeline) =>
                pipeline.stages.map((stage) => `${pipeline.externalId}\u0000${stage.externalId}`),
              ),
            ),
          )
        for (const kind of source.traits.kinds) {
          const { items } = await listAll(source, kind, null)
          assert.ok(items.length > 0, `${kind}: the fixture lists at least one`)
          const ids = new Set<string>()
          for (const raw of items) {
            const item = raw as { externalId?: unknown }
            assert.equal(typeof item.externalId, "string", `${kind}: externalId is a string`)
            assert.ok(!ids.has(item.externalId as string), `${kind} ${item.externalId} is listed twice`)
            ids.add(item.externalId as string)
            if (!isItemKind(kind)) continue
            const one = raw as CrmItem
            assert.ok(typeof one.title === "string", `${kind} ${one.externalId} has a title`)
            assert.ok(
              stages.get(kind)?.has(`${one.pipeline}\u0000${one.stage}`),
              `${kind} ${one.externalId} stands in stage ${one.stage} of pipeline ${one.pipeline}, which is listed`,
            )
            assert.equal(
              one.amount == null,
              one.currency == null,
              `${kind} ${one.externalId}: an amount with its currency`,
            )
            if (one.amount != null)
              assert.match(String(one.amount), DECIMAL, `${kind} ${one.externalId}: a decimal string`)
            for (const day of [one.closeDate, one.closedDate])
              if (day != null) assert.match(day, DAY, `${kind} ${one.externalId}: days are YYYY-MM-DD`)
            for (const at of [one.createdAt, one.updatedAt])
              if (at != null) assert.ok(Number.isFinite(at) && at > 0, `${kind} ${one.externalId}: times are epoch ms`)
          }
        }
      },
    },
    {
      name: "changes: a full list gives every row the fixture holds, none lost between the CRM's pages",
      async run() {
        const { source, held } = await make()
        if (!held) return
        for (const kind of source.traits.kinds) {
          const ids: readonly string[] | undefined = held[kind]
          if (!ids) continue
          assert.deepEqual(
            idsOf((await listAll(source, kind, null)).items).sort(),
            [...ids].sort(),
            `${kind}: every row the fixture holds is listed`,
          )
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
        if (source.traits.removedInChanges && !source.ids) return
        assert.ok(source.ids, "a CRM that does not name deletions in changes() lists every id")
        const ids = source.ids as NonNullable<CrmSource["ids"]>
        for (const kind of source.traits.kinds.filter((one) => one !== "person")) {
          const { items } = await listAll(source, kind, null)
          const listed = new Set<string>()
          let page: string | undefined
          for (let read = 0; read < MAX_PAGES; read += 1) {
            const answer = await ids.call(source, kind, page)
            for (const id of answer.items) listed.add(id)
            if (!answer.hasMore) break
            page = answer.nextCursor
          }
          for (const item of items as { externalId: string }[])
            assert.ok(listed.has(item.externalId), `${kind} ${item.externalId} is missing from ids()`)
        }
      },
    },
  ]
  cases.push({
    name: "list and get: live pages of contacts and companies, each row once, has_more on every page but the last",
    async run() {
      const { source, live } = await make()
      if (!source.list) return
      const list = source.list.bind(source)
      for (const kind of (["person", "organization"] as const).filter((one) => source.traits.kinds.includes(one))) {
        const whole = await list(kind, { conditions: [], limit: 250 })
        assert.ok(whole.items.length > 0, `${kind}: the fixture lists at least one live`)
        const seeded = live?.[kind]
        assert.ok(seeded, `${kind}: a fixture whose source has list names every record it holds in live`)
        assert.deepEqual(
          whole.items.map(({ externalId }) => externalId).sort(),
          [...seeded].sort(),
          `${kind}: every record the fixture holds is listed, none lost between the CRM's pages`,
        )
        for (const item of whole.items) {
          const record = item as CrmPerson
          const contacts = [record.email, record.phone, ...(record.emails ?? []), ...(record.phones ?? [])]
          const metadata = JSON.stringify(record.metadata ?? {})
          for (const one of contacts.filter((text): text is string => !!text))
            assert.ok(
              !metadata.includes(one),
              `${kind} ${record.externalId}: provider_metadata repeats a phone or e-mail, which the foreign rule ` +
                "strips only from emails and phones",
            )
        }
        const seen: string[] = []
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const answer = await list(kind, { conditions: [], limit: 1, page })
          assert.ok(answer.items.length <= 1, `${kind}: a page holds at most its limit`)
          seen.push(...answer.items.map(({ externalId }) => externalId))
          if (!answer.hasMore) break
          assert.equal(answer.items.length, 1, `${kind}: a page with more after it is full`)
        }
        assert.deepEqual(
          seen,
          whole.items.map(({ externalId }) => externalId),
          `${kind}: pages add up to the list`,
        )
        if (!source.get) continue
        const first = whole.items[0] as { externalId: string }
        assert.equal((await source.get(kind, first.externalId))?.externalId, first.externalId, `${kind}: get by id`)
        assert.equal(await source.get(kind, "contract-missing-0"), null, `${kind}: no such id is null, not a throw`)
      }
    },
  })
  return [
    ...cases,
    ...faultCases(make),
    {
      name: "changes: a dead cursor answers reset",
      async run() {
        const { source, deadCursor } = await make()
        if (!deadCursor) return
        assert.deepEqual(await source.changes(deadCursor.kind, deadCursor.cursor), { reset: true })
      },
    },
  ]
}

const faultCases = (make: () => CrmSourceFixture | Promise<CrmSourceFixture>): ContractCase[] => [
  ...([403, 404] as const).map((status) => ({
    name: `faults: a contact or company that answers ${status} is null from get, not a failure`,
    async run() {
      const { source, faults } = await make()
      if (!faults?.deny || !source.get) return
      const { kind, id } = await faults.deny(status)
      assert.equal(await source.get(kind, id), null, `get(${kind}, ${id}) after a ${status}`)
    },
  })),
  {
    name: "faults: a clock off by ten minutes either way loses no change",
    async run() {
      const first = await make()
      if (!first.faults?.skewed || !first.faults.change) return
      for (const ms of [SKEW_MS, -SKEW_MS]) {
        const { faults, held } = ms === SKEW_MS ? first : await make()
        const source = (await faults?.skewed?.(ms)) as CrmSource
        const read = await Promise.all(
          source.traits.kinds.map(async (kind) => [kind, await listAll(source, kind, null)] as const),
        )
        const { kind, id } = await (faults as Required<CrmSourceFaults>).change()
        const cursor = read.find(([one]) => one === kind)?.[1].cursor ?? null
        assert.ok(cursor !== null, `${kind}: a full list gives a cursor for the change to be read after`)
        const { items } = await listAll(source, kind, cursor)
        assert.ok(
          idsOf(items).includes(id),
          `${kind} ${id} is in the changes with this computer's clock ${ms / 60_000} min off`,
        )
        const untouched = held?.[kind]?.filter((one) => one !== id) ?? []
        for (const one of untouched)
          assert.ok(!idsOf(items).includes(one), `${kind} ${one} did not change, yet a read of changes lists it`)
      }
    },
  },
  {
    name: "faults: a second profile on the same token is the same user and lists the same rows",
    async run() {
      const { source, faults } = await make()
      const other = await faults?.sameToken?.()
      if (!other) return
      if (source.self) assert.equal(await other.self?.(), await source.self(), "both profiles name one user")
      for (const kind of source.traits.kinds)
        assert.deepEqual(
          idsOf((await listAll(other, kind, null)).items).sort(),
          idsOf((await listAll(source, kind, null)).items).sort(),
          `${kind}: both profiles list the same rows`,
        )
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
        const first = (await source.changes(kind, null)) as CrmPage<unknown>
        if (!first.hasMore) continue
        cut = true
        const { source: resumed } = await make()
        const rest: unknown[] = []
        let page = first.nextCursor
        for (let read = 0; page !== undefined && read < MAX_PAGES; read += 1) {
          const answer = (await resumed.changes(kind, null, page)) as CrmPage<unknown>
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
    // A source that never pages inside one call never asks, and passes: the deadline itself is the engine's to keep.
    name: "faults: a call that pages inside stops when the run's budget is spent, and says so",
    async run() {
      const { source, faults } = await make()
      if (!faults) return
      const spent = new CliError("provider_error", "the run's budget is spent", { reason: "sync.partial" })
      let asked = false
      const context: CrmCallContext = {
        spend: () => {
          asked = true
          throw spent
        },
        gap: () => {},
      }
      for (const kind of source.traits.kinds) {
        asked = false
        const ended = await source.changes(kind, null, undefined, context).then(
          () => undefined,
          (error: unknown) => error,
        )
        if (asked) assert.equal(ended, spent, `${kind}: a spent budget ends the call with its own error, not swallowed`)
        else assert.equal(ended, undefined, `${kind}: a call that asks for no more requests is not stopped`)
      }
    },
  },
]
