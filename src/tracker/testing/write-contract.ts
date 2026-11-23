import assert from "node:assert/strict"
import { isCliError } from "@wirecat/cli-base"
import type { ContractCase } from "../../meetings/index.js"
import { TRACKER_WRITES, type TrackerWriter } from "../writer.js"

/**
 * One adapter over recorded or faked responses, fresh for each case, and ids of what it holds: a team, a state of that
 * team, a user, a label and a project, as a sync stored them.
 */
export interface TrackerWriteFixture {
  writer: TrackerWriter
  team: string
  state: string
  user: string
  label: string
  project: string
  /** Makes the next write's answer lost after the tracker got it, as a dropped connection does. */
  loseNextAnswer: () => void
  /** How many write requests reached the tracker so far. */
  requests: () => number
}

let operations = 0
const operation = () => {
  operations += 1
  return { operationId: `contract-${Date.now()}-${operations}` }
}

/** What every tracker adapter's write side does, whatever the tracker: run each case in the adapter's tests. */
export const trackerWriteContract = (
  make: () => TrackerWriteFixture | Promise<TrackerWriteFixture>,
): ContractCase[] => {
  const created = async () => {
    const fixture = await make()
    const issue = await fixture.writer.createIssue(
      {
        title: "Example contract issue",
        description: "Example: written by the contract",
        team: fixture.team,
        state: fixture.state,
        assignee: fixture.user,
        priority: 2,
        labels: [fixture.label],
        project: fixture.project,
      },
      operation(),
    )
    return { ...fixture, issue }
  }
  return [
    {
      name: "writes: known writes, at least one",
      async run() {
        const { writer } = await make()
        assert.ok(writer.writes.length > 0 && writer.writes.every((one) => TRACKER_WRITES.includes(one)))
      },
    },
    {
      name: "create answers the whole issue with its new id, in the fields it was given",
      async run() {
        const { issue, team, state, user, label, project } = await created()
        assert.ok(issue.externalId, "an id")
        assert.equal(issue.title, "Example contract issue")
        assert.equal(issue.description, "Example: written by the contract")
        assert.equal(issue.team, team)
        assert.equal(issue.state, state)
        assert.equal(issue.assignee, user)
        assert.equal(issue.priority, 2)
        assert.deepEqual(issue.labels, [label])
        assert.equal(issue.project, project)
      },
    },
    {
      name: "update of one field answers the whole issue, every other field as it was",
      async run() {
        const { writer, issue } = await created()
        const changed = await writer.updateIssue(issue.externalId, { title: "Example renamed" }, operation())
        assert.equal(changed.externalId, issue.externalId)
        assert.equal(changed.title, "Example renamed")
        for (const field of ["description", "team", "state", "assignee", "priority", "project"] as const)
          assert.deepEqual(changed[field] ?? null, issue[field] ?? null, `${field} kept`)
        assert.deepEqual(changed.labels ?? [], issue.labels ?? [], "labels kept")
      },
    },
    {
      name: "an update clears the assignee, the project and the labels",
      async run() {
        const { writer, issue } = await created()
        const cleared = await writer.updateIssue(
          issue.externalId,
          { assignee: null, project: null, labels: [] },
          operation(),
        )
        assert.equal(cleared.assignee ?? null, null)
        assert.equal(cleared.project ?? null, null)
        assert.deepEqual(cleared.labels ?? [], [])
      },
    },
    {
      name: "comment answers the comment on the issue, and text that looks like a slot goes out as written",
      async run() {
        const { writer, issue } = await created()
        // A manifest's variables hold "{id}" and "{values}": the owner's text must never be filled as one.
        const renamed = await writer.updateIssue(issue.externalId, { title: "{id}" }, operation())
        assert.equal(renamed.title, "{id}")
        const comment = await writer.comment(issue.externalId, "{values}", operation())
        assert.ok(comment.externalId, "an id")
        assert.equal(comment.issue, issue.externalId)
        assert.equal(comment.body, "{values}")
      },
    },
    {
      name: "a lost answer is outcome_unknown, and the write reached the tracker once",
      async run() {
        const { writer, issue, loseNextAnswer, requests } = await created()
        const before = requests()
        loseNextAnswer()
        await assert.rejects(
          writer.updateIssue(issue.externalId, { title: "Example lost" }, operation()),
          (error: unknown) => isCliError(error) && error.code === "outcome_unknown",
        )
        assert.equal(requests(), before + 1)
      },
    },
  ]
}
