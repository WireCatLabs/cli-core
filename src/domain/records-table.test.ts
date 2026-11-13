import { describe, expect, it } from "vitest"
import { envelopeErrors } from "./records.js"
import {
  csvRows,
  envelopeOfCsv,
  recordColumns,
  recordTemplate,
  TABLE_RECORD_TYPES,
  TableError,
} from "./records-table.js"

const source = { provider: "sheet", account: "rentals", batch_id: "b1" }

describe("templates", () => {
  it("has a template for every type a sheet can carry, and each one is an envelope the store accepts", () => {
    expect(TABLE_RECORD_TYPES).not.toContain("message")
    expect(JSON.parse(recordTemplate("document", "json")).source.provider).toBe("import")
    for (const type of TABLE_RECORD_TYPES) {
      const json = JSON.parse(recordTemplate(type, "json", { source }))
      expect(envelopeErrors(json, "rentals"), type).toEqual([])
    }
  })

  it("writes a CSV header Excel opens as UTF-8, in the separator asked for", () => {
    const csv = recordTemplate("invoice", "csv", { separator: ";" })
    expect(csv.startsWith("﻿external_id;direction;number;")).toBe(true)
    expect(csv).toContain(";counterparty;")
    expect(csv).toContain(";lines.amount")
  })

  it("marks what a type requires: a transaction's wallet, a pipeline's stages", () => {
    const required = (type: string) =>
      recordColumns(type)
        .filter((c) => c.required)
        .map((c) => c.name)
    expect(required("transaction")).toEqual(expect.arrayContaining(["external_id", "amount", "wallet"]))
    expect(required("pipeline")).toEqual(expect.arrayContaining(["stages.external_id", "stages.name"]))
  })
})

describe("reading a sheet", () => {
  it("reads what Russian Excel saves: semicolons, a BOM, decimal commas and dotted dates", () => {
    const csv =
      "﻿external_id;direction;number;currency;issue_date;total;counterparty\r\n" +
      "INV-1;in;7;rub;09.11.2026;10 000,50;organization:C-1\r\n"
    const { envelope } = envelopeOfCsv(csv, { type: "invoice", source })
    expect(envelope.records).toEqual([
      {
        key: "invoice:INV-1",
        type: "invoice",
        external_id: "INV-1",
        operation: "upsert",
        fields: { direction: "in", number: "7", currency: "RUB", issue_date: "2026-11-09", total: "10000.50" },
        relations: [{ role: "counterparty", type: "organization", external_id: "C-1" }],
      },
    ])
    expect(envelopeErrors(envelope, "rentals")).toEqual([])
  })

  it("adds a line a row, where a row repeats the invoice's external id", () => {
    const csv = [
      "external_id,currency,lines.description,lines.amount",
      "INV-1,EUR,Bike,100.00",
      "INV-1,,Helmet,25.00",
    ].join("\n")
    const { envelope, placeOf } = envelopeOfCsv(csv, { type: "invoice", source })
    expect(envelope.records[0]?.fields).toEqual({
      currency: "EUR",
      lines: [
        { description: "Bike", amount: "100.00" },
        { description: "Helmet", amount: "25.00" },
      ],
    })
    expect(placeOf("/records/0/fields/lines/1/amount")).toEqual({ line: 3, column: "lines.amount" })
    expect(placeOf("/records/0/fields/currency")).toEqual({ line: 2, column: "currency" })
    expect(placeOf("/records/0/type")).toEqual({ line: 2 })
  })

  it("names a role's single target by its external id, and several by type", () => {
    const csv = "external_id,direction,amount,date,wallet\nT-1,out,5.00,2026-11-01,W-1\n"
    const { envelope } = envelopeOfCsv(csv, { type: "transaction", source })
    expect(envelope.records[0]?.relations).toEqual([{ role: "wallet", type: "wallet", external_id: "W-1" }])
  })

  it("refuses a column the type does not have and a party without its type, naming the line and column", () => {
    const bad = (type: string, csv: string) => {
      try {
        envelopeOfCsv(csv, { type, source })
      } catch (e) {
        if (e instanceof TableError) return e.errors.map((x) => [x.place, x.message])
      }
      return []
    }
    expect(bad("invoice", "external_id,totl\nI,1\n")).toEqual([
      [{ line: 1, column: "totl" }, expect.stringContaining("invoice has no field for: totl")],
    ])
    expect(bad("invoice", "external_id,counterparty\nI,C-1\n")).toEqual([
      [{ line: 2, column: "counterparty" }, expect.stringContaining("<type>:<external id>")],
    ])
  })

  it("keeps a separator, a quote and a line break inside quotes", () => {
    expect(csvRows('a,"b, ""c""\nd"\n', ",")).toEqual([{ cells: ["a", 'b, "c"\nd'], line: 1 }])
  })
})
