import { expect, it } from "vitest"
import { drawsHyperlinks, hyperlink } from "./hyperlink.js"

it("draws links only where the terminal is known to, and FORCE_HYPERLINK decides elsewhere", () => {
  expect(drawsHyperlinks({ VTE_VERSION: "7600" })).toBe(true)
  expect(drawsHyperlinks({ TERM_PROGRAM: "iTerm.app" })).toBe(true)
  expect(drawsHyperlinks({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false)
  expect(drawsHyperlinks({ VTE_VERSION: "7600", TMUX: "/tmp/tmux" })).toBe(false)
  expect(drawsHyperlinks({ TERM_PROGRAM: "Apple_Terminal", FORCE_HYPERLINK: "1" })).toBe(true)
  expect(drawsHyperlinks({ VTE_VERSION: "7600", FORCE_HYPERLINK: "0" })).toBe(false)
})

it("keeps an escape in the address from ending the link early", () => {
  expect(hyperlink("apps", "https://a.example/\u0007x")).toBe("\u001b]8;;https://a.example/x\u0007apps\u001b]8;;\u0007")
})
