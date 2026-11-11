import assert from "node:assert/strict"
import { runBudget } from "../../background/budget.js"
import type { ContractCase } from "../../meetings/index.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import type { CrmSourceTraits } from "../source.js"
import { type CrmSyncOptions, syncCrm } from "../sync.js"
import {
  exampleDeal,
  exampleLead,
  exampleOrganization,
  examplePerson,
  type FakeCrmSource,
  fakeCrmSource,
  LEAD_PIPELINE,
  SALES_PIPELINE,
  SOURCE_FIELD,
} from "./source.js"

/** A fresh, empty store and the CRM account to sync into it. */
export interface CrmSyncFixture {
  store: MessageStore
  account: AccountKey
}

/** Both ways a CRM may report deletions: the engine must handle each. */
export const CRM_TRAIT_COMBINATIONS: readonly Pick<CrmSourceTraits, "removedInChanges">[] = [
  { removedInChanges: false },
  { removedInChanges: true },
]

const DAY = 86_400_000

interface Context extends CrmSyncFixture {
  source: FakeCrmSource
  sync: (options?: CrmSyncOptions) => ReturnType<typeof syncCrm>
  deals: () => Promise<string[]>
}

/** What the sync engine does over any store, whatever the CRM: core runs it, and a CLI may run it over its store. */
export const crmSyncContract = (make: () => CrmSyncFixture | Promise<CrmSyncFixture>): ContractCase[] =>
  CRM_TRAIT_COMBINATIONS.flatMap((traits) => {
    const label = traits.removedInChanges ? "(deletions in changes)" : "(deletions by id pass)"
    let now = Date.now()
    const test = (name: string, check: (context: Context) => Promise<void>): ContractCase => ({
      name: `${name} ${label}`,
      async run() {
        now = Date.now()
        const fixture = await make()
        const source = fakeCrmSource({ traits })
        const sync = (options: CrmSyncOptions = {}) =>
          syncCrm(source, fixture.store, fixture.account, { now, ...options })
        const deals = async () =>
          (await fixture.store.deals.list({ account: fixture.account, kind: "deal" })).items
            .map(({ externalId }) => externalId as string)
            .sort()
        await check({ ...fixture, source, sync, deals })
      },
    })
    const seeded = (source: FakeCrmSource, count = 3) => {
      for (let at = 1; at <= count; at += 1) source.put("deal", exampleDeal(`d${at}`))
    }
    return [
      test("copies every kind on the first run, and only what changed on the next", async ({
        source,
        sync,
        deals,
        store,
        account,
      }) => {
        source.put("organization", exampleOrganization("c1"))
        source.put("person", examplePerson("p1"))
        seeded(source)
        source.put("lead", exampleLead("l1"))
        const first = await sync()
        assert.equal(first.state, "complete")
        assert.deepEqual(await deals(), ["d1", "d2", "d3"])
        assert.equal((await store.deals.list({ account, kind: "lead" })).items.length, 1)
        assert.ok(first.synced.every(({ round }) => round === "full"))
        source.put("deal", exampleDeal("d2", { stage: "won", title: "Example deal won" }))
        const second = await sync()
        assert.deepEqual(
          second.synced.map(({ kind, round, saved }) => [kind, round, saved]),
          [
            ["organization", "changes", 0],
            ["person", "changes", 0],
            ["deal", "changes", 1],
            ["lead", "changes", 0],
          ],
        )
        const {
          items: [won],
        } = await store.deals.list({ account, status: "won" })
        assert.equal(won?.title, "Example deal won")
      }),
      test("marks deleted what the CRM deleted, after a complete list at the latest", async ({
        source,
        sync,
        deals,
      }) => {
        seeded(source)
        await sync()
        source.delete("deal", "d2")
        now += DAY
        const run = await sync()
        assert.deepEqual(await deals(), ["d1", "d3"])
        const deal = run.synced.find(({ kind }) => kind === "deal")
        assert.equal((deal?.removed ?? 0) + (deal?.unlisted ?? 0), 1)
      }),
      test("a list of ids the budget stops marks nothing, and the next run goes on from it", async ({
        source,
        sync,
        deals,
      }) => {
        if (traits.removedInChanges) return
        seeded(source, 5)
        await sync()
        source.delete("deal", "d1")
        now += DAY
        const stopped = await sync({ budget: runBudget({ requests: 11 }) })
        assert.equal(stopped.state, "partial")
        assert.equal(stopped.hint, "run sync again to continue")
        assert.deepEqual(await deals(), ["d1", "d2", "d3", "d4", "d5"])
        const finished = await sync()
        assert.equal(finished.state, "complete")
        assert.deepEqual(await deals(), ["d2", "d3", "d4", "d5"])
      }),
      test("a list that would mark most rows deleted is held as an issue until --rescan", async ({
        source,
        sync,
        deals,
      }) => {
        if (traits.removedInChanges) return
        seeded(source, 12)
        await sync()
        source.hideAll(true)
        now += DAY
        const held = await sync()
        assert.equal(held.synced.find(({ kind }) => kind === "deal")?.pass, "held")
        assert.ok(held.issues.some(({ reason }) => reason === "crm.unlisted-held"))
        assert.equal((await deals()).length, 12)
        await sync({ rescan: true })
        assert.deepEqual(await deals(), [])
      }),
      test("stores each kind's own fields, and marks deleted one the CRM no longer lists", async ({
        source,
        sync,
        store,
        account,
      }) => {
        const note = { code: "UF_NOTE", label: "Note", type: "string", multiple: true, filterable: false }
        source.setFields("person", [note])
        await sync()
        assert.deepEqual(await store.crm.fields(account, "deal"), [SOURCE_FIELD])
        assert.deepEqual(await store.crm.fields(account, "person"), [note])
        source.setFields("deal", [])
        await sync()
        assert.deepEqual(await store.crm.fields(account, "deal"), [])
        assert.deepEqual(await store.crm.fields(account, "person"), [note])
      }),
      test("a dead cursor starts a full round, marked reset", async ({ source, sync, deals }) => {
        seeded(source)
        await sync()
        source.put("deal", exampleDeal("d4"))
        source.expireCursors("deal")
        const run = await sync()
        const deal = run.synced.find(({ kind }) => kind === "deal")
        assert.equal(deal?.reset, true)
        assert.equal(deal?.round, "full")
        assert.deepEqual(await deals(), ["d1", "d2", "d3", "d4"])
      }),
      test("a run its budget stops saves its pages and the next goes on from the page it stopped at", async ({
        source,
        sync,
        deals,
      }) => {
        seeded(source, 9)
        const stopped = await sync({ budget: runBudget({ requests: 10 }) })
        assert.equal(stopped.state, "partial")
        assert.equal(stopped.stopped, "requests")
        const kept = (await deals()).length
        assert.ok(kept > 0 && kept < 9, `some pages kept, not all: ${kept}`)
        const finished = await sync()
        assert.equal(finished.state, "complete")
        assert.equal((await deals()).length, 9)
        assert.equal(
          finished.synced.find(({ kind }) => kind === "deal")?.saved,
          9 - kept,
          "it went on, not from the start",
        )
      }),
      test("an item in a stage made after the pipelines were read is kept once they are read again", async ({
        source,
        sync,
        deals,
      }) => {
        const changes = source.changes.bind(source)
        source.changes = async (kind, cursor, page) => {
          if (kind === "deal") {
            source.setPipelines("deal", [
              {
                ...SALES_PIPELINE,
                stages: [...SALES_PIPELINE.stages, { externalId: "late", name: "Late", position: 5, outcome: "open" }],
              },
            ])
            source.put("deal", exampleDeal("d1", { stage: "late" }))
          }
          return changes(kind, cursor, page)
        }
        const run = await sync()
        assert.deepEqual(await deals(), ["d1"])
        assert.deepEqual(run.issues, [])
      }),
      test("an item in a stage the CRM never lists is named as an issue, and the round goes on", async ({
        source,
        sync,
        deals,
      }) => {
        source.put("deal", exampleDeal("d1", { stage: "nowhere" }))
        source.put("deal", exampleDeal("d2"))
        const run = await sync()
        assert.deepEqual(await deals(), ["d2"])
        assert.deepEqual(
          run.issues.map(({ kind, reason, externalId }) => [kind, reason, externalId]),
          [["deal", "crm.stage-unknown", "d1"]],
        )
      }),
      test("a lead pipeline may share a deal pipeline's id", async ({ source, sync, deals }) => {
        source.setPipelines("lead", [{ ...LEAD_PIPELINE, externalId: SALES_PIPELINE.externalId }])
        source.put("deal", exampleDeal("d1"))
        source.put("lead", exampleLead("l1", { pipeline: SALES_PIPELINE.externalId }))
        const run = await sync()
        assert.deepEqual(await deals(), ["d1"])
        assert.deepEqual(run.issues, [])
      }),
      test("a contact joins a person by exact email, and a company never joins an organization by name", async ({
        source,
        sync,
        store,
        account,
      }) => {
        const own = await store.knowledge.addOrganization({ kind: "company", name: "Example company c1" })
        source.put("organization", exampleOrganization("c1"))
        source.put("person", examplePerson("p1", { email: "person@example.com" }))
        source.put("deal", exampleDeal("d1", { organization: "c1", people: [{ externalId: "p1", role: "contact" }] }))
        await sync()
        const {
          items: [deal],
        } = await store.deals.list({ account })
        assert.notEqual(deal?.organization?.ref, own.ref)
        assert.equal(deal?.organization?.name, "Example company c1")
        const person = await store.people.personOf({ provider: "email", id: "person@example.com" })
        assert.equal(deal?.people[0]?.ref, `person:${person?.uid}`)
      }),
      test("a cancelled run stops and keeps what it saved", async ({ source, sync, deals }) => {
        seeded(source, 4)
        const controller = new AbortController()
        const pipelines = source.pipelines.bind(source)
        source.pipelines = async (kind) => {
          if (kind === "lead") controller.abort()
          return pipelines(kind)
        }
        const run = await sync({ signal: controller.signal })
        assert.equal(run.stopped, "cancelled")
        assert.equal(run.state, "partial")
        assert.deepEqual(await deals(), [])
        const again = await sync()
        assert.equal(again.state, "complete")
        assert.equal((await deals()).length, 4)
      }),
    ]
  })
