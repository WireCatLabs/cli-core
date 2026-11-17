import { describe, expect, it } from "vitest"
import { mapTrackerRecord } from "./map.js"

describe("mapTrackerRecord", () => {
  it("clears a field whose selected object the tracker answered null, whatever the rule, converted by its type", () => {
    const record = mapTrackerRecord(
      "issue",
      {
        externalId: "id",
        title: "title",
        assignee: { first: ["assignee.id", "delegate.id"] },
        project: { path: "project.id" },
        labels: "labels.nodes",
        parent: "parent.id",
      },
      { id: "i", title: "x", assignee: null, delegate: null, project: null, labels: null },
    )
    expect(record).toEqual({ externalId: "i", title: "x", assignee: null, project: null, labels: [] })
  })

  it("keeps out a state of a type the domain does not know, and a comment without its issue", () => {
    expect(mapTrackerRecord("state", { externalId: "id", name: "name", type: "type" }, { id: "s", type: "x" })).toBe(
      null,
    )
    expect(mapTrackerRecord("comment", { externalId: "id", body: "body" }, { id: "c", body: "hi" })).toBe(null)
  })
})
