import assert from "node:assert/strict"
import { isCliError } from "@wirecat/cli-base"
import type { ContractCase } from "../../meetings/index.js"
import type { ContentWriter } from "../writer.js"

/** One writer over recorded or faked answers, fresh for each case. */
export interface ContentWriteFixture {
  writer: ContentWriter
  /** Makes the next write's answer lost after the source got it, as a dropped connection does. */
  loseNextAnswer: () => void
  /** How many write requests reached the source so far. */
  requests: () => number
  /** Changes a post at the source behind the copy's back, so the version a write sends is old. */
  changeElsewhere?: (externalId: string) => void | Promise<void>
}

let operations = 0
const operation = (version?: string | null) => {
  operations += 1
  return { operationId: `contract-${Date.now()}-${operations}`, ...(version === undefined ? {} : { version }) }
}

const refusedWith = async (
  check: (error: { code: string; details: Record<string, unknown> }) => void,
  act: () => Promise<unknown>,
) => {
  try {
    await act()
  } catch (error) {
    assert.ok(isCliError(error), `a CliError, not ${String(error)}`)
    check(error)
    return
  }
  assert.fail("expected a refusal")
}

/** What every content writer does, whatever the source: run each case in the adapter's tests. */
export const contentWriteContract = (
  make: () => ContentWriteFixture | Promise<ContentWriteFixture>,
): ContractCase[] => {
  const drafted = async () => {
    const fixture = await make()
    const made = await fixture.writer.createDraft(
      { title: "Example contract post", body: "A *contract* body.\n\n- one\n- two" },
      operation(),
    )
    return { ...fixture, made }
  }
  return [
    {
      name: "createDraft answers a draft with its new id, never a published post",
      async run() {
        const { made } = await drafted()
        assert.ok(made.externalId, "a new id")
        assert.equal(made.status, "draft")
        assert.equal(made.title, "Example contract post")
        assert.match(made.body ?? "", /contract/)
      },
    },
    {
      name: "update of one field answers the whole post, every other field as it was",
      async run() {
        const { writer, made } = await drafted()
        const updated = await writer.update(made.externalId, { title: "Renamed" }, operation(made.version))
        assert.equal(updated.title, "Renamed")
        assert.equal(updated.body, made.body)
        assert.equal(updated.status, "draft")
      },
    },
    {
      name: "a write with an old version is refused as content.conflict, and the post stays as it was",
      async run() {
        const { writer, made, changeElsewhere } = await drafted()
        if (!changeElsewhere) return
        await changeElsewhere(made.externalId)
        await refusedWith(
          (error) => assert.equal(error.details.reason, "content.conflict"),
          () => writer.update(made.externalId, { title: "Overwritten" }, operation(made.version)),
        )
      },
    },
    {
      name: "publish publishes once: a second publish answers the post as it is and sends nothing out again",
      async run() {
        const { writer, made, requests } = await drafted()
        const published = await writer.publish(made.externalId, operation(made.version))
        assert.equal(published.status, "published")
        const before = requests()
        const again = await writer.publish(made.externalId, operation(published.version))
        assert.equal(again.status, "published")
        assert.ok(requests() - before <= 1, "a repeated publish makes at most a read")
        assert.equal(again.publishedAt, published.publishedAt, "the first publish time stays")
      },
    },
    {
      name: "schedule answers a scheduled post with its time; unpublish brings it back to a draft",
      async run() {
        const { writer, made } = await drafted()
        const at = Date.UTC(2030, 0, 1, 9)
        const scheduled = await writer.schedule(made.externalId, at, operation(made.version))
        assert.equal(scheduled.status, "scheduled")
        assert.equal(scheduled.scheduledFor, at)
        const back = await writer.unpublish(made.externalId, operation(scheduled.version))
        assert.equal(back.status, "draft")
      },
    },
    {
      name: "trash keeps the post, trashed; force deletes it for good",
      async run() {
        const { writer, made } = await drafted()
        const trashed = await writer.trash(made.externalId, operation(made.version))
        assert.equal(trashed?.status, "trashed")
        assert.equal(await writer.trash(made.externalId, { ...operation(trashed?.version), force: true }), null)
      },
    },
    {
      name: "a lost answer is outcome_unknown after one request, never retried",
      async run() {
        const { writer, made, loseNextAnswer, requests } = await drafted()
        loseNextAnswer()
        const before = requests()
        await refusedWith(
          (error) => assert.equal(error.code, "outcome_unknown"),
          () => writer.update(made.externalId, { title: "Lost" }, operation(made.version)),
        )
        assert.equal(requests() - before, 1, "one request, not a retry")
      },
    },
  ]
}
