import { describe, expect, it } from "vitest"
import { indent } from "./pretty.js"

describe("indent", () => {
  it("shifts every line and leaves empty lines empty", () => {
    expect(indent("[1/5] Title\n\nbody", 2)).toBe("  [1/5] Title\n\n  body")
  })

  it("leaves the text alone at zero", () => {
    expect(indent("a\nb", 0)).toBe("a\nb")
  })
})
