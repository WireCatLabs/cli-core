import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it } from "vitest"
import { createMeetingSearchCommand, meetingSearchArguments } from "../meetings/cli/index.js"
import { toolsFromCommands } from "./agent.js"

it("replays numeric meeting selectors through the generated MCP command schema", () => {
  const program = new Command("example")
  createMeetingSearchCommand(program)
  const tool = toolsFromCommands(describeProgram(program))[0]
  const args = meetingSearchArguments("budget", {
    meetingId: 1,
    identityId: 2,
    personId: 3,
    eventId: 4,
    seriesId: 5,
  })
  if (!tool) throw new Error("meeting search was not generated")
  expect(v.safeParse(tool.input, args).success).toBe(true)
  expect(args).toMatchObject({ meeting_id: "1", identity_id: "2", person_id: "3", event_id: "4", series_id: "5" })
})
