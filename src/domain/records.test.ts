import { expect, it } from "vitest"
import { recordErrors } from "./records.js"

const record = (extra: Record<string, unknown>) => ({
  key: "k",
  type: "payment",
  external_id: "1",
  operation: "upsert",
  fields: {},
  ...extra,
})

it("names every registered type when it refuses one", () => {
  expect(recordErrors(record({ type: "task" }), 0)).toEqual([
    {
      pointer: "/records/0/type",
      code: "record.type",
      message:
        "a type is one of invoice, payment, person, organization, project, order, product, contract, subscription, wallet, transaction, deal, lead, message, event, pipeline or custom:<name>",
      key: "k",
    },
  ])
})

it("lets only a settles relation carry an amount", () => {
  const relations = [{ role: "payer", type: "organization", external_id: "c", amount: "1" }]
  expect(recordErrors(record({ relations }), 0)).toEqual([
    expect.objectContaining({ message: "only a settles relation carries an amount" }),
  ])
})
