import { describe, expect, it } from "vitest"
import {
  DEFAULT_TASK_CATEGORIES,
  parseTaskCategory,
  storedTaskCategories,
  taskCategoryValue,
  withTaskCategory,
} from "./task-categories.js"

describe("task categories as the owner writes them", () => {
  it("**reads `<meaning> | <words>`**, a word's language by its tag or its script, and writes it back the same", () => {
    const travel = parseTaskCategory("Travel", "trips | Flight, рейс, es:vuelo, flight")
    expect(travel).toEqual({
      name: "travel",
      meaning: "trips",
      triggers: { en: ["flight"], ru: ["рейс"], es: ["vuelo"] },
    })
    expect(parseTaskCategory("travel", taskCategoryValue(travel))).toEqual(travel)
    expect(() => parseTaskCategory("travel", " | flight")).toThrow(/meaning/)
  })

  it("**replaces a category in place, adds a new one before other, and never removes other**", () => {
    const added = withTaskCategory(DEFAULT_TASK_CATEGORIES, "garden", "plants")
    expect(added.map(({ name }) => name).slice(-2)).toEqual(["garden", "other"])
    expect(withTaskCategory(added, "money", "bills").find(({ name }) => name === "money")?.meaning).toBe("bills")
    expect(() => withTaskCategory(added, "other", undefined)).toThrow(/other stays/)
    expect(() => withTaskCategory(added, "nope", undefined)).toThrow(/no task category/)
  })

  it("falls back to the default list when the stored one is not a list it can read", () => {
    expect(storedTaskCategories("not json")).toBeUndefined()
    expect(storedTaskCategories(JSON.stringify([{ name: "money", meaning: "x", triggers: {} }]))).toBeUndefined()
    expect(storedTaskCategories(JSON.stringify(DEFAULT_TASK_CATEGORIES))).toEqual(DEFAULT_TASK_CATEGORIES)
  })
})
