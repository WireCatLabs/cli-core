import { describe, expect, it } from "vitest"
import type { SearchAllIncludingMeetingsFound } from "../../services/search-all-meetings.js"
import { allAnswer } from "./search-answers.js"

const found = (messages: SearchAllIncludingMeetingsFound["messages"]): SearchAllIncludingMeetingsFound => ({
  query: "cat",
  items: [],
  hasMore: false,
  searched: ["messages"],
  accounts: [],
  skipped: [],
  messages,
})

describe("allAnswer", () => {
  it("names the step that would let search all find messages by meaning", () => {
    const answer = allAnswer(
      "search all",
      found({
        by: "words",
        meaningSkipped: { reason: "no message has a vector yet", step: "conversations.rebuild", model: "e5-small" },
      }),
      { limit: 10 },
    )

    expect(JSON.stringify(answer)).toContain("conversations.rebuild")
    expect(JSON.stringify(answer)).toContain("searched by words only: no message has a vector yet")
  })

  it("asks for the model once when neither notes nor messages could use it", () => {
    const answer = allAnswer(
      "search all",
      {
        ...found({
          by: "words",
          meaningSkipped: { reason: "e5-small is not downloaded", step: "models.download", model: "e5-small" },
        }),
        notes: { by: "words", meaningSkipped: "e5-small is not downloaded" },
      },
      { limit: 10 },
    )

    expect(answer.next?.filter(({ step }) => step === "models.download")).toHaveLength(1)
  })

  it("adds nothing once messages were searched by meaning", () => {
    const answer = allAnswer("search all", found({ by: "words and meaning" }), { limit: 10 })

    expect(JSON.stringify(answer)).not.toContain("conversations.rebuild")
  })
})
