import { type CountryCode, getExampleNumber } from "libphonenumber-js/max"
import examples from "libphonenumber-js/mobile/examples"
import { describe, expect, it } from "vitest"
import { findMentions, normalizedValue, typedPhone } from "./mentions.js"
import { PHONE_COUNTRIES, parsePhoneCountries } from "./phones.js"

const phones = (text: string, countries: string[] = ["ru"]) =>
  findMentions(text, { phoneCountries: countries })
    .filter((one) => one.kind === "phone")
    .map((one) => one.value)

describe("phone numbers in the countries of phone_countries", () => {
  // libphonenumber's own sample numbers: every supported plan reads its sample the way Google's library does.
  it.each(PHONE_COUNTRIES)("reads %s's sample mobile written locally, internationally and with 00", (country) => {
    const sample = getExampleNumber(country.toUpperCase() as CountryCode, examples)
    if (!sample) throw new Error(`no sample for ${country}`)
    expect(phones(`tel ${sample.formatNational()}`, [country])).toEqual([sample.number])
    expect(phones(sample.formatInternational(), [])).toEqual([sample.number])
    expect(phones(`00${sample.number.slice(1)}`, [])).toEqual([sample.number])
  })

  it("takes bare digits only when they are a mobile of a listed country", () => {
    expect(phones("llámame 612345678", ["es"])).toEqual(["+34612345678"])
    expect(phones("escribe al 612345678", ["es"])).toEqual(["+34612345678"])
    expect(phones("escribe al 612345678")).toEqual([])
    expect(phones("910 123 456", ["es"])).toEqual(["+34910123456"])
    expect(phones("910123456", ["es"])).toEqual([])
  })

  it("reads a number in the first listed country it fits", () => {
    expect(phones("8 900 000-00-01", ["es", "ru"])).toEqual(["+79000000001"])
    expect(phones("612 34 56 78", ["es", "ru"])).toEqual(["+34612345678"])
    expect(phones("07700 900123", ["gb"])).toEqual(["+447700900123"])
    expect(phones("(201) 555-0123", ["us"])).toEqual(["+12015550123"])
  })

  it("drops the bracketed trunk prefix of an international number", () => {
    expect(phones("+44 (0)20 7946 0958", [])).toEqual(["+442079460958"])
  })

  it("skips numbers after an order, invoice, tax or bank word", () => {
    expect(phones("pedido 612345678", ["es"])).toEqual([])
    expect(phones("factura nº 612 345 678", ["es"])).toEqual([])
    expect(phones("DNI 612345678", ["es"])).toEqual([])
  })

  it("refuses a country it has no plan for", () => {
    expect(parsePhoneCountries("ES, ru")).toEqual(["es", "ru"])
    expect(() => parsePhoneCountries("es,xx")).toThrow(/not xx/)
  })
})

describe("a number typed into a search", () => {
  it("is read in the listed countries and keeps its national number for older spellings", () => {
    expect(typedPhone("612345678", { phoneCountries: ["es"] })).toEqual({
      value: "+34612345678",
      national: "612345678",
    })
    expect(typedPhone("+34 612 345 678", { phoneCountries: ["es"] })?.national).toBe("612345678")
    expect(normalizedValue("8 900 000-00-01")).toBe("+79000000001")
    expect(typedPhone("ana@example.com")).toBeUndefined()
  })
})
