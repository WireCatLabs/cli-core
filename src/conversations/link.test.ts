import { describe, expect, it } from "vitest"
import { type LinkInput, linkMessages } from "./link.js"

let clock = Date.parse("2026-05-12T10:00:00.000Z")

const said = (id: string, senderId: string, text: string, extra: Partial<LinkInput> = {}): LinkInput => {
  clock += 30_000
  return { id, senderId, text, timestamp: new Date(clock).toISOString(), ...extra }
}

const handles = new Map([
  ["alice", "a"],
  ["bob", "b"],
  ["carol", "c"],
  ["dave", "d"],
])

describe("linkMessages", () => {
  it("separates two interleaved conversations joined by replies and a mention", () => {
    const { parents, conversations } = linkMessages(
      [
        said("1", "a", "Anyone know a good dentist?"),
        said("2", "b", "did you deploy it?"),
        said("3", "c", "@Alice yes, Clínica X"),
        said("4", "d", "prod is broken again", { replyToId: "2" }),
        said("5", "a", "thanks, where is it?", { replyToId: "3" }),
        said("6", "b", "yes, 10 min ago", { replyToId: "4" }),
        said("7", "c", "Ruzafa", { replyToId: "5" }),
      ],
      { handles },
    )
    expect(parents.get("3")).toBe("1")
    expect(conversations).toEqual([
      ["1", "3", "5", "7"],
      ["2", "4", "6"],
    ])
  })

  it("links a mention to the mentioned person's latest message, not the one just before", () => {
    const { parents, links } = linkMessages(
      [said("1", "a", "school X?"), said("2", "b", "off topic"), said("3", "c", "alice: our son goes there")],
      { handles },
    )
    expect(parents.get("3")).toBe("1")
    expect(links).toContainEqual(expect.objectContaining({ messageId: "3", kind: "mention", source: "rule" }))
  })

  it("links a mention by id, as the messenger marks it, with no @handle in the text", () => {
    const { parents } = linkMessages([
      said("1", "e", "who drives on Friday?"),
      said("2", "b", "I'm in"),
      said("3", "c", "Eva, I can take two", { mentions: ["e"] }),
    ])

    expect(parents.get("3")).toBe("1")
  })

  it("**takes the agent's answer over the rules**, and the messenger's reply over the agent", () => {
    const messages = [
      said("1", "a", "school X?"),
      said("2", "b", "dentist?"),
      said("3", "a", "ok", { replyToId: "1" }),
      said("4", "b", "alice: thanks"),
      said("5", "c", "no idea"),
    ]
    const answers = new Map<string, string | null>([
      ["3", "2"],
      ["4", "2"],
      ["5", null],
    ])

    const { parents } = linkMessages(messages, { handles, answers })

    expect(parents.get("3")).toBe("1")
    expect(parents.get("4")).toBe("2")
    expect(parents.get("5")).toBeNull()
  })

  it("leaves the choice to the rules when the agent names a message not held, or a later one", () => {
    const { parents } = linkMessages(
      [said("1", "a", "school X?"), said("2", "c", "alice: which one?"), said("3", "b", "later")],
      {
        handles,
        answers: new Map([
          ["2", "99"],
          ["1", "3"],
        ]),
      },
    )

    expect(parents.get("2")).toBe("1")
    expect(parents.get("1")).toBeNull()
  })

  it("joins one sender's quick follow-up, and not one after a five-minute gap", () => {
    const messages = [said("1", "a", "I tried that school"), said("2", "a", "last year")]
    clock += 6 * 60_000
    messages.push(said("3", "a", "anyway"))
    const { parents } = linkMessages(messages)
    expect(parents.get("2")).toBe("1")
    expect(parents.get("3")).toBeNull()
  })

  it("prefers the messenger's reply over any rule", () => {
    const { parents } = linkMessages(
      [said("1", "b", "first"), said("2", "a", "hello"), said("3", "a", "@bob hi", { replyToId: "2" })],
      { handles },
    )
    expect(parents.get("3")).toBe("2")
  })

  it("never links across forum threads, not by a rule and not by an explicit reply", () => {
    const { parents, links } = linkMessages(
      [
        said("1", "a", "visa question", { threadId: "t1" }),
        said("2", "a", "also", { threadId: "t2" }),
        said("3", "b", "@alice which one?", { threadId: "t2" }),
        said("4", "b", "answering", { threadId: "t2", replyToId: "1" }),
      ],
      { handles },
    )
    expect(parents.get("2")).toBeNull()
    expect(parents.get("3")).toBe("2")
    expect(parents.get("4")).toBe("3")
    expect(links).not.toContainEqual(expect.objectContaining({ messageId: "4", parentId: "1" }))
  })

  it("**keeps each forum topic apart**: a reply to the topic's first message is no link, a reply inside it is", () => {
    const { conversations, links } = linkMessages([
      said("10", "a", ""),
      said("20", "a", ""),
      said("11", "b", "who has the hall key?", { threadId: "10", replyToId: "10" }),
      said("21", "c", "the boat leaves at nine", { threadId: "20", replyToId: "20" }),
      said("12", "d", "I do", { threadId: "10", replyToId: "11" }),
      said("22", "e", "noted", { threadId: "20", replyToId: "20" }),
    ])

    expect(conversations).toEqual([["10", "20"], ["11", "12"], ["21"], ["22"]])
    expect(links.filter(({ parentId }) => parentId === "10" || parentId === "20")).toEqual([
      expect.objectContaining({ messageId: "20", kind: "same_sender" }),
    ])
  })

  it("keeps a comment linked to the post it comments on, a thread whose first message has text", () => {
    const { conversations } = linkMessages([
      said("p1", "a", "Garden cleanup on Saturday, bring gloves"),
      said("p2", "d", "The pool opens in June"),
      said("c1", "b", "I can bring two rakes", { threadId: "p1", replyToId: "p1" }),
      said("c2", "c", "what time?", { threadId: "p2", replyToId: "p2" }),
    ])

    expect(conversations).toEqual([
      ["p1", "c1"],
      ["p2", "c2"],
    ])
  })

  it("leaves the choice to the rules when the agent names a message in another topic", () => {
    const { parents } = linkMessages(
      [said("1", "a", "lunch?", { threadId: "t1" }), said("2", "b", "rain later", { threadId: "t2" })],
      { answers: new Map([["2", "1"]]) },
    )
    expect(parents.get("2")).toBeNull()
  })

  it("starts a conversation for a reply to a message it does not hold", () => {
    const { parents, links } = linkMessages([said("9", "a", "as I said", { replyToId: "1" })])
    expect(parents.get("9")).toBeNull()
    expect(links).toEqual([])
  })

  it("ignores a mention of oneself and an unknown opening word", () => {
    const { parents } = linkMessages([said("1", "a", "hi"), said("2", "b", "note: @bob is me")], { handles })
    expect(parents.get("2")).toBeNull()
  })
})
