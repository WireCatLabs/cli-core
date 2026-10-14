import { callMeetingPreparationTool, readMeetingPreparation } from "../src/cli/index.js"
import { createMeetingPreparationService } from "../src/services/index.js"
import { preparationFixture } from "../src/testing/meeting-preparation.js"

export const smokeMeetingPreparation = async (check: (what: string, condition: boolean) => void) => {
  const fixture = await preparationFixture()
  try {
    const service = createMeetingPreparationService(fixture.key, fixture.accountId, {
      meetings: fixture.store.meetings,
      upcoming: fixture.upcoming,
    })
    const result = await service.prepare("example-series", fixture.request)
    const entry = result.items[0]
    check("meeting preparation selects explicit upcoming proof", result.upcoming.verifiedNext)
    check("meeting preparation retains cited cues", entry?.evidence.items[0]?.text === "Ship the example plan.")
    check(
      "meeting preparation retains confirmed project context",
      entry?.context.projects.items[0]?.ref === fixture.project.ref,
    )
    check("meeting preparation retains accepted meeting facts", entry?.context.facts.items[0]?.ref === fixture.fact.ref)
    check(
      "meeting preparation retains account-owned meeting tasks",
      entry?.context.tasks.items[0]?.ref === `task:${fixture.task.task.id}`,
    )
    const input = { series_id: "example-series" }
    const answer = await readMeetingPreparation(service.prepare.bind(service), input, undefined, 10000)
    check("meeting preparation public answer retains string IDs", answer.item.account_id === String(fixture.accountId))
    const tool = await callMeetingPreparationTool(service.prepare.bind(service), input, undefined, {}, 10000)
    check(
      "meeting preparation MCP returns a standard item envelope",
      !("isError" in tool) && "item" in tool.structuredContent,
    )
  } finally {
    await fixture.close()
  }
}
