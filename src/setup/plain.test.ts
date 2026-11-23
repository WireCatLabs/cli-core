import { expect, it } from "vitest"
import { plainSetupText } from "./plain.js"

it("drops the marks a terminal would show and keeps each link's address", () => {
  expect(plainSetupText("Click **Create**, copy `xoxp-…`, open [your apps](https://api.example/apps).")).toBe(
    "Click Create, copy xoxp-…, open your apps (https://api.example/apps).",
  )
  expect(plainSetupText("Sign in at [example.com/signin](https://example.com/signin).")).toBe(
    "Sign in at https://example.com/signin.",
  )
  expect(plainSetupText("[apps](https://api.example/apps)")).toBe("apps (https://api.example/apps)")
  expect(plainSetupText("2 * 3 and a_b stay")).toBe("2 * 3 and a_b stay")
})

it("drops heading marks and lets a terminal draw a link", () => {
  expect(
    plainSetupText("## How to get the token\n\nOpen [apps](https://api.example/apps)", { link: (l) => `<${l}>` }),
  ).toBe("How to get the token\n\nOpen <apps>")
})
