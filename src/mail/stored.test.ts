import { expect, it } from "vitest"
import type { EmailFacts } from "../store/index.js"
import { factsOf } from "./facts.js"
import { listedOf } from "./stored.js"

const ME = "owner@example.test"

const email = (n: number, from: string, to: string, more: Partial<EmailFacts> = {}): EmailFacts => ({
  externalId: `<${n}@example.test>`,
  fromAddress: from,
  fromName: null,
  subject: `Synthetic ${n}`,
  receivedAt: 1_000 + n,
  size: null,
  read: true,
  flagged: false,
  outgoing: false,
  listId: null,
  recipients: [to],
  mailboxes: [],
  replyTo: null,
  dkim: null,
  dmarc: null,
  ...more,
})

it("labels the owner's stored mail Sent, so a sender the owner wrote to counts as replied", async () => {
  const listed = [
    email(1, "news@shop.example", ME),
    email(2, ME, "news@shop.example", { outgoing: true }),
    email(3, ME, "ann@people.example", {
      outgoing: true,
      mailboxes: [{ externalId: "s", name: "Sent", kind: "label" }],
    }),
  ].map(listedOf)
  expect(listed.map(({ labels }) => labels)).toEqual([[], ["Sent"], ["Sent"]])
  const rules = [{ match: { score_at_least: 1 }, action: "skip", decided_at: "2026-11-14T00:00:00Z" }] as const
  const facts = await factsOf(listed, rules, async () => new Set())
  expect(facts(listed[0] as (typeof listed)[number])).toMatchObject({ replied: true })
})
