import { expect, it } from "vitest"
import { at } from "./map.js"

it("a path past the end of a list the service sent is empty to its end, so a cleared value leaves the copy", () => {
  const raw = { values: { job_title: [], name: [{ value: "Ada" }], owner: [null] } }
  expect(at(raw, "values.job_title.0.value")).toBeNull()
  expect(at(raw, "values.job_title.0")).toBeNull()
  expect(at(raw, "values.name.0.value")).toBe("Ada")
  expect(at(raw, "values.missing.0.value")).toBeUndefined()
  expect(at(raw, "values.owner.0.id")).toBeUndefined()
})
