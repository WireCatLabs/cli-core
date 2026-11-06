import assert from "node:assert/strict"
import { isCliError } from "@wirecat/cli-base"
import type { CrmItem, CrmPipeline } from "../../domain/crm.js"
import { DEAL_KINDS, type DealKind } from "../../domain/deals.js"
import type { ContractCase } from "../../meetings/index.js"
import { CRM_VERBS, type CrmWriter } from "../writer.js"

/**
 * One adapter over recorded or faked responses, fresh for each case, that takes writes of `kind`. `pipeline` is one
 * of the kind's pipelines with at least two open stages and a won one.
 */
export interface CrmWriteFixture {
  writer: CrmWriter
  kind?: DealKind
  pipeline: CrmPipeline
  /** Custom field codes that are a neutral field under the CRM's own name (Bitrix24's `stageId`, `ASSIGNED_BY_ID`). */
  aliases: readonly string[]
  /** Makes the next write's answer lost after the CRM got it, as a dropped connection does. */
  loseNextAnswer: () => void
  /** How many write requests reached the CRM so far. */
  requests: () => number
}

let operations = 0
const operation = () => {
  operations += 1
  return { operationId: `contract-${Date.now()}-${operations}` }
}

const refusedWith = async (code: string, act: () => Promise<unknown>) => {
  try {
    await act()
  } catch (error) {
    assert.ok(isCliError(error), `a CliError, not ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`expected ${code}`)
}

const outcomeOf = (pipeline: CrmPipeline, item: CrmItem) =>
  item.status ?? pipeline.stages.find((stage) => stage.externalId === item.stage)?.outcome

/** What every CRM adapter's write side does, whatever the CRM: run each case in the adapter's tests. */
export const crmWriteContract = (make: () => CrmWriteFixture | Promise<CrmWriteFixture>): ContractCase[] => {
  const openStages = async () => {
    const fixture = await make()
    const open = fixture.pipeline.stages.filter((stage) => stage.outcome === "open")
    assert.ok(open.length >= 2, "the fixture's pipeline has two open stages")
    const kind = fixture.kind ?? "deal"
    const made = await fixture.writer.create(
      kind,
      {
        title: "Example contract deal",
        pipeline: fixture.pipeline.externalId,
        stage: open[0]?.externalId as string,
        amount: "1500.50",
        currency: "EUR",
      },
      operation(),
    )
    return { ...fixture, kind, open, made }
  }
  return [
    {
      name: "capabilities: known verbs and kinds, and a yes or no for repeated writes",
      async run() {
        const { writer } = await make()
        const { kinds, verbs, idempotent } = writer.capabilities
        assert.ok(kinds.length > 0 && kinds.every((kind) => DEAL_KINDS.includes(kind)))
        assert.ok(verbs.length > 0 && verbs.every((verb) => CRM_VERBS.includes(verb)))
        assert.equal(typeof idempotent, "boolean")
      },
    },
    {
      name: "create answers the whole item in the stage it was given, with its new id",
      async run() {
        const { made, pipeline, open } = await openStages()
        assert.ok(made.externalId, "an id")
        assert.equal(made.title, "Example contract deal")
        assert.equal(made.pipeline, pipeline.externalId)
        assert.equal(made.stage, open[0]?.externalId)
        assert.equal(made.currency, "EUR")
        assert.equal(Number(made.amount), 1500.5)
      },
    },
    {
      name: "update of one field answers the whole item, every other field as it was",
      async run() {
        const { writer, kind, made } = await openStages()
        const changed = await writer.update(kind, made.externalId, { title: "Example renamed" }, operation())
        assert.equal(changed.externalId, made.externalId)
        assert.equal(changed.title, "Example renamed")
        for (const field of ["pipeline", "stage", "amount", "currency", "organization"] as const)
          assert.deepEqual(changed[field] ?? null, made[field] ?? null, `${field} kept`)
        assert.deepEqual(changed.people ?? [], made.people ?? [], "people kept")
      },
    },
    {
      name: "move goes to the stage given; close marks it won",
      async run() {
        const { writer, kind, made, open, pipeline } = await openStages()
        const moved = await writer.move(kind, made.externalId, open[1]?.externalId as string, operation())
        assert.equal(moved.stage, open[1]?.externalId)
        assert.equal(outcomeOf(pipeline, moved), "open")
        const closed = await writer.close(kind, made.externalId, "won", operation())
        assert.equal(outcomeOf(pipeline, closed), "won")
      },
    },
    {
      name: "remove answers once the CRM deleted it",
      async run() {
        const { writer, kind, made } = await openStages()
        await writer.remove(kind, made.externalId, operation())
      },
    },
    {
      name: "a custom code that is a neutral field under another name is refused, and nothing is sent",
      async run() {
        const { writer, kind, made, aliases, requests, open } = await openStages()
        assert.ok(aliases.length > 0, "the fixture names the CRM's own names for stage and owner")
        for (const code of aliases) {
          const before = requests()
          await refusedWith("validation_error", () =>
            writer.update(kind, made.externalId, { custom: { [code]: open[1]?.externalId as string } }, operation()),
          )
          assert.equal(requests(), before, `${code}: nothing sent`)
        }
      },
    },
    {
      name: "a lost answer is outcome_unknown after one request, never retried",
      async run() {
        const fixture = await openStages()
        const before = fixture.requests()
        fixture.loseNextAnswer()
        await refusedWith("outcome_unknown", () =>
          fixture.writer.update(fixture.kind, fixture.made.externalId, { title: "Example lost" }, operation()),
        )
        assert.equal(fixture.requests(), before + 1, "one request")
      },
    },
    {
      name: "an idempotent CRM answers a repeated operation id from its record",
      async run() {
        const { writer, kind, pipeline } = await make()
        if (!writer.capabilities.idempotent) return
        const once = operation()
        const draft = { title: "Example repeated", pipeline: pipeline.externalId }
        const first = await writer.create(kind ?? "deal", draft, once)
        const again = await writer.create(kind ?? "deal", draft, once)
        assert.equal(again.externalId, first.externalId)
      },
    },
  ]
}
