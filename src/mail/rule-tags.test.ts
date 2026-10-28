import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { MessageStore } from "../store/index.js"
import { mapProposedTags, ruleTagger, settleRuleTags } from "./rule-tags.js"
import type { MailRule } from "./rules.js"

const key = { provider: "email", account: "owner@example.com" } as const
const ref = (messageId: string) => ({ type: "message" as const, chatId: "t1", messageId })
const refusal = (candidate?: string) =>
  new CliError("validation_error", "similar labels exist; reuse one or review this distinct label before creation", {
    reason: "tag-review.required",
    candidates: candidate === undefined ? [] : [{ id: "1", name: candidate, kind: "tag", similarity: 0.9 }],
  })

const fakeStore = (labels: string[], refuse: Record<string, CliError>) => {
  const tagged: [string, string][] = []
  const upserts: unknown[] = []
  const store = {
    tags: {
      addTags: async (_key: unknown, target: { messageId: string }, tags: string[]) => {
        for (const tag of tags) {
          if (refuse[tag]) throw refuse[tag]
          if (!labels.includes(tag)) labels.push(tag)
          tagged.push([target.messageId, tag])
        }
        return tags
      },
    },
    mail: { rules: { upsert: async (_id: number, rule: unknown) => upserts.push(rule) } },
  } as unknown as MessageStore
  return { store, tagged, upserts }
}

describe("rule tags the store refuses", () => {
  it("reuses the label the store points to and keeps importing", async () => {
    const { store, tagged } = fakeStore(["Clients/Acme Ltd"], { "Clients/Acme": refusal("Clients/Acme Ltd") })
    const tagger = ruleTagger(store, key)
    await tagger.tag(ref("m1"), ["Clients/Acme", "travel"])
    await tagger.tag(ref("m2"), ["Clients/Acme"])
    expect(tagged).toEqual([
      ["m1", "Clients/Acme Ltd"],
      ["m1", "travel"],
      ["m2", "Clients/Acme Ltd"],
    ])
    expect(tagger.outcome()).toEqual({ reused: [{ tag: "Clients/Acme", as: "Clients/Acme Ltd" }], skipped: [] })
  })

  it("skips and counts a tag with nothing to reuse instead of failing", async () => {
    const { store, tagged } = fakeStore([], { "bad/label": refusal() })
    const tagger = ruleTagger(store, key)
    await tagger.tag(ref("m1"), ["bad/label", "travel"])
    await tagger.tag(ref("m2"), ["bad/label"])
    expect(tagged).toEqual([["m1", "travel"]])
    expect(tagger.outcome().skipped).toEqual([
      { tag: "bad/label", reason: expect.stringContaining("similar labels exist"), emails: 2 },
    ])
  })

  it("writes reused labels and skipped tags back into the rules", async () => {
    const { store, upserts } = fakeStore([], {})
    const rules: MailRule[] = [
      {
        id: 7,
        match: { from: "a@example.com" },
        action: "envelope",
        tags: ["Clients/Acme", "bad/label"],
        decided_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 8,
        match: { from: "b@example.com" },
        action: "keep",
        tags: ["travel"],
        decided_at: "2026-01-01T00:00:00.000Z",
      },
    ]
    await settleRuleTags(store, 1, rules, {
      reused: [{ tag: "Clients/Acme", as: "Clients/Acme Ltd" }],
      skipped: [{ tag: "bad/label", reason: "refused", emails: 2 }],
    })
    expect(upserts).toEqual([
      expect.objectContaining({
        actions: { store: "envelope", tags: ["Clients/Acme Ltd"], tags_skipped: { "bad/label": "refused" } },
      }),
    ])
  })

  it("maps proposed tags to existing labels before anything is created", async () => {
    const store = {
      knowledge: {
        tagPreflight: async (name: string) =>
          name === "Travel"
            ? { disposition: "reuse", existing: { name: "travel" }, suggestions: [] }
            : name === "Acme"
              ? { disposition: "review", existing: null, suggestions: [{ entry: { name: "acme-ltd" } }] }
              : { disposition: "create", existing: null, suggestions: [] },
      },
    } as unknown as MessageStore
    const rules: MailRule[] = [
      {
        match: { from: "a@example.com" },
        action: "keep",
        tags: ["Travel", "Acme", "new"],
        decided_at: "2026-01-01T00:00:00.000Z",
      },
    ]
    const mapped = await mapProposedTags(store, rules)
    expect(mapped.rules[0]?.tags).toEqual(["travel", "acme-ltd", "new"])
    expect(mapped.mapping).toEqual([
      { tag: "Travel", as: "travel", why: "reuse" },
      { tag: "Acme", as: "acme-ltd", why: "similar" },
    ])
  })
})
