import jsqr from "jsqr"
import { describe, expect, it } from "vitest"
import { plainQr, terminalQr } from "./qr.js"

describe("terminalQr", () => {
  it("draws two modules per cell, black on white whatever the theme, with a quiet zone", () => {
    const { text, width } = terminalQr("tg://login?token=abc")
    const lines = text.split("\n")

    // Version 1 is 21 modules; the quiet zone adds four on each side.
    expect(width).toBeGreaterThanOrEqual(21 + 8)
    expect(lines).toHaveLength(Math.ceil(width / 2))
    for (const line of lines) {
      expect(line.startsWith("\x1b[30;107m") && line.endsWith("\x1b[0m")).toBe(true)
      const cells = line.slice("\x1b[30;107m".length, -"\x1b[0m".length)
      expect(cells).toHaveLength(width)
      expect(cells).toMatch(/^[█▀▄ ]+$/)
    }
    expect(lines[0]).toBe(`\x1b[30;107m${" ".repeat(width)}\x1b[0m`)
  })

  it("grows with what it carries", () => {
    expect(terminalQr("x".repeat(200)).width).toBeGreaterThan(terminalQr("x").width)
  })
})

// A glyph is the foreground colour, white on a dark theme; a space is the dark background around it too.
const asSeenOnDarkTheme = (text: string, scale = 4, margin = 8) => {
  const lines = text.split("\n")
  const width = (Math.max(...lines.map((line) => line.length)) + margin * 2) * scale
  const height = (lines.length * 2 + margin * 2) * scale
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
  lines.forEach((line, row) => {
    ;[...line].forEach((glyph, col) => {
      const halves = [glyph === "█" || glyph === "▀", glyph === "█" || glyph === "▄"]
      halves.forEach((light, half) => {
        if (!light) return
        for (let y = 0; y < scale; y++)
          for (let x = 0; x < scale; x++) {
            const at = (((row * 2 + half + margin) * scale + y) * width + (col + margin) * scale + x) * 4
            pixels.fill(255, at, at + 3)
          }
      })
    })
  })
  return { pixels, width, height }
}

const decoded = (text: string) => {
  const { pixels, width, height } = asSeenOnDarkTheme(text)
  // jsqr is CommonJS with an ES default in its types: the function is `.default` under NodeNext.
  return jsqr.default(pixels, width, height, { inversionAttempts: "dontInvert" })?.data
}

describe("plainQr", () => {
  it("**decodes, as a dark theme shows it, to the link it was given**", () => {
    const link = "tg://login?token=not-a-real-token-for-the-test"
    expect(decoded(plainQr(link))).toBe(link)
  })

  it("keeps a WhatsApp-sized code under 80 columns, and it still decodes", () => {
    const link = `2@${"r".repeat(90)},${"n".repeat(44)},${"i".repeat(44)},${"a".repeat(44)}`
    const lines = plainQr(link).split("\n")
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(80)
    expect(decoded(lines.join("\n"))).toBe(link)
  })

  it("has no colours, and every line starts and ends with a glyph", () => {
    for (const line of plainQr("tg://login?token=abc").split("\n")) {
      expect(line).toMatch(/^[█▀][█▀▄ ]*[█▀]$/)
    }
  })

  it("keeps its shape", () => {
    expect(`\n${plainQr("tg://login?token=abc")}\n`).toMatchInlineSnapshot(`
      "
      █████████████████████████████████
      █████████████████████████████████
      ████ ▄▄▄▄▄ █▀▀▄█ ▀▄ ▀█ ▄▄▄▄▄ ████
      ████ █   █ ██ ▄ ██▀█▀█ █   █ ████
      ████ █▄▄▄█ █▄▄██ █▄ ▄█ █▄▄▄█ ████
      ████▄▄▄▄▄▄▄█▄█▄█▄▀▄█ █▄▄▄▄▄▄▄████
      ████ ▀▄▀ █▄█▀▀▀▀▄ █▄ ▀▀█▄▀▀▄▀████
      █████▀ ▀▄ ▄ █▀▄ █  ▀▀ ▀  ▀██ ████
      ████▄▄▀█▀█▄▄█▀  ██▄█ █ ███▀  ████
      ████▄▀██▄▀▄ ▀ █▀█▄███▄▀▄█ █ ▄████
      ████▄██▄▄█▄▄▀██▀ ▀█  ▄▄▄ █▀▄ ████
      ████ ▄▄▄▄▄ ██ ▄▄ ▀ ▄ █▄█ ▄█ ▄████
      ████ █   █ █▄▄█ ██ █ ▄▄  █▀▄▄████
      ████ █▄▄▄█ █▄▄ ▀█▄█ ▀▄█▄ █▄▀▄████
      ████▄▄▄▄▄▄▄█▄▄▄█▄██▄▄█▄▄███▄▄████
      █████████████████████████████████
      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
      "
    `)
  })
})
