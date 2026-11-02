import { describe, expect, it } from "vitest"
import { transcriptLanguage } from "./language.js"

const russian = "Давайте обсудим план на следующую неделю и сроки по проекту."

describe("transcriptLanguage", () => {
  it("calls a Russian meeting Russian although a few of its lines are English", () => {
    const lines = [...Array.from({ length: 30 }, () => russian), "Let me share my screen.", "Okay, thank you."]
    expect(transcriptLanguage(lines)).toBe("ru")
  })

  it("tells Ukrainian from Russian by the letters Russian does not write", () => {
    expect(transcriptLanguage(["Давайте обговоримо план на наступний тиждень, і ще їхні терміни."])).toBe("uk")
  })

  it("tells Latin-script languages apart by their frequent words", () => {
    expect(transcriptLanguage(["We have the plan and this is what you asked for, with the dates that are left."])).toBe(
      "en",
    )
    expect(
      transcriptLanguage(["El plan para los clientes está listo, pero hay que revisar las fechas por la tarde."]),
    ).toBe("es")
  })

  it("names no language for a mixed, short or undecided transcript", () => {
    expect(transcriptLanguage([russian, "We have the plan and this is what you asked for, with the dates."])).toBeNull()
    expect(transcriptLanguage(["Окей"])).toBeNull()
    expect(transcriptLanguage(["Zoom Meeting Example Room Number Twelve"])).toBeNull()
    expect(transcriptLanguage([])).toBeNull()
  })
})
