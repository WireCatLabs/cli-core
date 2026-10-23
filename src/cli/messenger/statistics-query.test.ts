import { evaluate, type FieldSpec, parseLucene } from "@wirecat/cli-base/query"
import { expect, it } from "vitest"
import { statisticsQuery } from "./statistics-query.js"

const fields: FieldSpec[] = [
  { name: "from", type: "kw", operators: ["term", "phrase"], example: "from:1" },
  { name: "text", type: "txt", operators: ["term", "phrase"], example: "text:hello" },
]
const records = [
  { from: "1", text: "hello world" },
  { from: "2", text: "another word" },
  { from: "3", text: "hello" },
]

it.each([
  ["message_kind:posts from:(1 OR 2)", "from:(1 OR 2)"],
  ["min_messages:2 (text:hello OR text:another)", "(text:hello OR text:another)"],
  ['(message_kind:comments AND from:1) text:"hello world"', 'from:1 text:"hello world"'],
  ["from:(1 AND min_messages:2)", "from:1"],
  ["message_kind:posts NOT from:1", "NOT from:1"],
  ["min_messages:2 (text:hello OR text:another) NOT from:2", "(text:hello OR text:another) NOT from:2"],
])("preserves message selection when extracting report predicates: %s", (input, expected) => {
  const result = statisticsQuery(input, "contacts-top")
  expect(result.text).toBeDefined()
  const actual = parseLucene(result.text ?? "")
  const original = parseLucene(expected)
  expect(records.map((record) => evaluate(actual, fields, record))).toEqual(
    records.map((record) => evaluate(original, fields, record)),
  )
})

it("keeps predicate-free queries byte-for-byte and permits a report-only selection", () => {
  const text = 'from:(1 OR 2) NOT text:"hello world"'
  expect(statisticsQuery(text, "contacts-top")).toEqual({ text })
  expect(statisticsQuery("message_kind:POSTS min_messages:3", "contacts-top")).toEqual({
    messageKind: "posts",
    minMessages: 3,
  })
  expect(statisticsQuery("min_views:10 max_replies:0", "discussion")).toEqual({ minViews: 10, maxReplies: 0 })
  expect(statisticsQuery("older_than:0.5h", "unanswered")).toEqual({ olderThan: "0.5h" })
})

it.each([
  "message_kind:posts OR from:1",
  "NOT message_kind:posts",
  "message_kind:posts message_kind:comments",
  "message_kind:unknown",
  "min_messages:0",
  "min_messages:1.5",
  "min_messages:[1 TO 5]",
  "min_views:1",
])("refuses a report predicate it cannot apply before aggregation: %s", (query) => {
  expect(() => statisticsQuery(query, "contacts-top")).toThrow(/query\./)
})

it.each(["older_than:0h", "older_than:1ms", "older_than:9007199254740991d"])(
  "refuses an invalid question age: %s",
  (query) => {
    expect(() => statisticsQuery(query, "unanswered")).toThrow(/query.invalid-duration/)
  },
)
