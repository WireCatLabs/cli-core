import { describe, expect, it } from "vitest"
import { dateOrNone } from "./tasks-command.js"

describe("a task's dates as typed", () => {
  it("reads a due date alone as the end of that day, and a reminder date alone as its start", () => {
    const due = dateOrNone("--due", { end: true })("2099-11-20") as Date
    const remind = dateOrNone("--remind-time")("2099-11-20") as Date

    expect([due.getHours(), due.getMinutes(), due.getDate()]).toEqual([23, 59, 20])
    expect([remind.getHours(), remind.getMinutes(), remind.getDate()]).toEqual([0, 0, 20])
    expect(dateOrNone("--due", { end: true })("none")).toBe("none")
  })
})
