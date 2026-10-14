import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { declaredSettingName, snakeCaseConfig } from "./config-keys.js"

describe("snake_case config names", () => {
  it("renames settings inside lists of objects", () => {
    const schema = v.object({
      max_body_chars: v.optional(v.number()),
      rules: v.optional(v.array(v.object({ match: v.object({ list_id: v.string() }), decided_at: v.string() }))),
    })
    const { config, renames } = snakeCaseConfig(schema, {
      maxBodyChars: 5,
      rules: [{ match: { listId: "a" }, decidedAt: "b" }],
    })
    expect(config).toEqual({ max_body_chars: 5, rules: [{ match: { list_id: "a" }, decided_at: "b" }] })
    expect(renames.map(({ to }) => to)).toEqual(["max_body_chars", "rules.0.match.list_id", "rules.0.decided_at"])
  })

  it("reads a typed name as the schema's, but keeps a permission path and a model purpose", () => {
    expect(declaredSettingName("readOtherBots")).toBe("read_other_bots")
    expect(declaredSettingName("permissions.messages.delete")).toBe("permissions.messages.delete")
    expect(declaredSettingName("models.speech-to-text.baseUrl")).toBe("models.speech-to-text.base_url")
  })
})
