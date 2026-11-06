import assert from "node:assert/strict"
import { type CrmItem, type CrmKind, isItemKind } from "../../domain/crm.js"
import { DEAL_KINDS, type DealKind, STAGE_OUTCOMES } from "../../domain/deals.js"
import type { ContractCase } from "../../meetings/index.js"
import type { CrmPage, CrmSource } from "../source.js"

/**
 * One adapter over recorded or faked responses, fresh for each case. Every kind its traits name must list at least
 * one row, so the checks have something to look at.
 */
export interface CrmSourceFixture {
  source: CrmSource
  /** A cursor the CRM refuses; absent skips that case. */
  deadCursor?: { kind: CrmKind; cursor: string }
}

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
    if (listed.nextPage === undefined) {
      assert.ok(listed.cursor === null || typeof listed.cursor === "string", `${kind}: the last page gives a cursor`)
      return { items, cursor: listed.cursor ?? null }
    }
    assert.ok(!pages.has(listed.nextPage), `${kind}: the same page twice`)
    pages.add(listed.nextPage)
    page = listed.nextPage
  }
  throw new assert.AssertionError({ message: `${kind}: more than ${MAX_PAGES} pages` })
}

/** What every CRM adapter answers, whatever the CRM: run each case in the adapter's tests. */
export const crmSourceContract = (make: () => CrmSourceFixture | Promise<CrmSourceFixture>): ContractCase[] => {
  const cases: ContractCase[] = [
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
            for (const id of answer.ids) listed.add(id)
            if (answer.nextPage === undefined) break
            page = answer.nextPage
          }
          for (const item of items as { externalId: string }[])
            assert.ok(listed.has(item.externalId), `${kind} ${item.externalId} is missing from ids()`)
        }
      },
    },
  ]
  return [
    ...cases,
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
