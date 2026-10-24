import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { answerEntity } from "./answer-entity.js"
import { addContractInfo, contractEvidence } from "./contract-evidence.js"
import { LOCAL_READ } from "./effects.js"

describe("actual CLI contract evidence", () => {
  it("exports shared schemas, provider schemas and the effective reason registry", () => {
    const root = new Command("fixture")
    root.addCommand(
      answerEntity(
        annotate(new Command("show"), { effects: LOCAL_READ }),
        "fixture_record",
        v.strictObject({ id: v.string() }),
      ),
    )
    const evidence = contractEvidence(root, {
      errors: {
        reasons: [{ reason: "fixture.invalid", code: "validation_error", message: "invalid fixture", details: [] }],
      },
    })
    expect(evidence.schemas.fixture_record).toMatchObject({ type: "object", properties: { id: { type: "string" } } })
    expect(evidence.schemas.message).toBeDefined()
    expect(evidence.reasons).toContainEqual({
      reason: "fixture.invalid",
      code: "validation_error",
      message: "invalid fixture",
      details: [],
    })
    expect(evidence.field_only).toEqual([])
  })
  it("keeps field-only declarations visible rather than claiming a typed schema", () => {
    const root = new Command("fixture").addCommand(
      annotate(new Command("show"), { output: { entity: "fixture_fields" } }),
    )
    const evidence = contractEvidence(root, { fields: () => ["id", "state"] })
    expect(evidence.field_only).toEqual(["fixture_fields"])
    expect(evidence.schemas.fixture_fields).toMatchObject({ properties: { id: {}, state: {} } })
  })
  it("serves evidence through commands info without touching an account", async () => {
    const root = new Command("fixture").addCommand(new Command("commands"))
    const results: unknown[] = []
    addContractInfo(root, (result) => results.push(result))
    await root.parseAsync(["commands", "info", "--json"], { from: "user" })
    expect(results[0]).toMatchObject({ schemas: expect.any(Object), reasons: expect.any(Array), overrides: [] })
  })
})
