import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it } from "vitest"
import { answerEntity, answerEntitySchema } from "./answer-entity.js"
import { commandContract } from "./command-contract.js"
import { answerFields, checkJson } from "./json-fields.js"

it("one provider schema drives discovery and projection without changing another program", () => {
  const schema = v.strictObject({ id: v.string(), assets: v.array(v.string()) })
  const first = answerEntity(new Command("recordings"), "fixture_recording", schema)
  const second = answerEntity(new Command("recordings"), "fixture_recording", v.strictObject({ id: v.number() }))
  expect(commandContract(first)).toMatchObject({
    outputSchemaCoverage: "declared-entity",
    jsonlSchema: { properties: { id: { type: "string" }, assets: { type: "array" } }, additionalProperties: false },
  })
  expect(commandContract(second)).toMatchObject({ jsonlSchema: { properties: { id: { type: "number" } } } })
  expect(answerFields(first)).toEqual(["id", "assets"])
  expect(() => checkJson(first, { json: true, fields: "id" }, false)).not.toThrow()
  expect(() => checkJson(first, { json: true, fields: "unknown" }, false)).toThrow()
  expect(v.safeParse(answerEntitySchema(first) as v.GenericSchema, { id: 5, assets: [] }).success).toBe(false)
  annotate(first, { output: { entity: "different" } })
  expect(answerEntitySchema(first)).toBeUndefined()
})

it("shared entities cannot be replaced and unregistered commands retain no schema", () => {
  expect(() => answerEntity(new Command("list"), "meeting", v.unknown())).toThrow("shared entity")
  expect(() => answerEntity(new Command("list"), "Bad Name", v.unknown())).toThrow("lowercase")
  expect(() => answerEntity(new Command("list"), "fixture", v.unknown())).toThrow("object schema")
  expect(answerEntitySchema(undefined)).toBeUndefined()
  expect(answerEntitySchema(new Command("list"))).toBeUndefined()
  expect(answerFields(annotate(new Command("list"), { output: { entity: "meeting" } }))).toContain("id")
})
