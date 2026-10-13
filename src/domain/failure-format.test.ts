import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { failureObjectOf } from "./failure-format.js"

describe("released error contract compatibility", () => {
  it("keeps the standard registered error shape by default", () => {
    expect(failureObjectOf(new CliError("validation_error", "synthetic", { candidates: ["7"] }))).toEqual({
      error: { code: "validation_error", reason: "input.invalid", message: "synthetic" },
    })
  })

  it("preserves a legacy caller's details and reason without exposing its cause", () => {
    const result = failureObjectOf(
      new CliError("outcome_unknown", "synthetic", {
        reason: "deletion_unconfirmed",
        retained: ["7"],
        sendId: "42",
        cause: new Error("private"),
      }),
      {},
      "legacy",
    )
    expect(result.error).toMatchObject({
      code: "outcome_unknown",
      reason: "deletion_unconfirmed",
      retained: ["7"],
      sendId: "42",
    })
    expect(result.error).not.toHaveProperty("cause")
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it("preserves released input and output budget reason names only when opted in", () => {
    for (const [reason, expected] of [
      ["input.too-large", "input_limit"],
      ["output.too-large", "output_limit"],
    ]) {
      const error = new CliError("validation_error", "synthetic", { reason })
      expect(failureObjectOf(error, {}, "legacy").error.reason).toBe(expected)
      expect(failureObjectOf(error).error.reason).toBe("input.invalid")
    }
  })

  it("keeps unexpected thrown text private in either contract", () => {
    expect(failureObjectOf(new Error("private"), {}, "legacy").error).toEqual({
      code: "internal_error",
      reason: "command.crashed",
      message: "the command failed; this is a bug",
    })
  })
})
