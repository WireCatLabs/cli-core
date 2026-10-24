import { CliError } from "@wirecat/cli-base"
import { expect, it } from "vitest"
import { meetingResultItem } from "./meeting-results.js"

it("adapts export IDs without changing SDK objects or file contents", () => {
  const source = { meetingId: 3, format: "vtt", filename: "fixture.vtt", content: "WEBVTT\n" }
  expect(meetingResultItem("meeting_export", source)).toEqual({
    meeting_id: "3",
    format: "vtt",
    filename: "fixture.vtt",
    content: "WEBVTT\n",
  })
  expect(source.meetingId).toBe(3)
})

it("adapts association IDs recursively and retains explicit target accounts and nullable preconditions", () => {
  const source = {
    scope: { provider: "fixture", account: "invented" },
    accountId: 1,
    meetingId: 2,
    change: {
      action: "person.link",
      participantId: 3,
      personUid: "4",
      targetAccountIds: [1, 2],
      expectedPersonUid: null,
    },
    applied: true,
    result: { meetingId: 2, participantId: 3, personUid: "4", previousPersonUid: null, changed: true },
  }
  expect(meetingResultItem("meeting_association", source)).toEqual({
    scope: { provider: "fixture", account: "invented" },
    account_id: "1",
    meeting_id: "2",
    change: {
      action: "person.link",
      participant_id: "3",
      person_uid: "4",
      target_account_ids: ["1", "2"],
      expected_person_uid: null,
    },
    applied: true,
    result: { meeting_id: "2", participant_id: "3", person_uid: "4", previous_person_uid: null, changed: true },
  })
})

it("invalid receipts never expose payloads and an applied write retains uncertain-outcome semantics", () => {
  for (const applied of [false, true]) {
    try {
      meetingResultItem("meeting_transcription", { applied, media: "synthetic private payload" })
      throw new Error("expected a contract refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ code: applied ? "outcome_unknown" : "invalid_response" })
      expect((error as Error).message).not.toContain("synthetic private payload")
    }
  }
})
