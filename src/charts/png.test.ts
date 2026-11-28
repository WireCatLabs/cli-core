import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import { beforeAll, describe, expect, it } from "vitest"
import { placeEngines } from "../kit/engines.js"
import type { Fetch } from "../speech/install.js"
import { CHART_SIZE, type ChartData, type RenderedChart } from "./model.js"
import { chartPng, type RenderedPng } from "./png.js"
import { chartRenderer } from "./render.js"

const png = async (svg: RenderedChart): Promise<RenderedPng> => {
  const rendered = await chartPng(svg)
  if ("status" in rendered) throw new Error(rendered.reason)
  return rendered
}

beforeAll(() => placeEngines(process.env, ["@resvg/resvg-js"]))

const chart: ChartData = {
  version: 1,
  kind: "bar",
  title: "Сообщения клуба",
  x: { type: "day", values: ["2026-10-01", "2026-10-02", "2026-10-03"] },
  series: [{ name: "Messages", values: [4, null, 2] }],
  unit: "messages",
  timezone: "Europe/Madrid",
  partial: true,
  reasons: ["store-incomplete"],
}

describe("PNG chart encoding", () => {
  it("keeps dimensions, dark background, observed bars and visible Cyrillic text", async () => {
    const rendered = await png(await (await chartRenderer()).render(chart, CHART_SIZE))
    expect(rendered).toMatchObject({ ...CHART_SIZE, format: "png", mimeType: "image/png" })
    const image = PNG.sync.read(Buffer.from(rendered.bytes))
    expect(image).toMatchObject(CHART_SIZE)
    expect([...image.data.subarray(0, 4)]).toEqual([17, 24, 39, 255])
    const pixel = (x: number, y: number) => [
      ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
    ]
    expect(pixel(188, 270)).toEqual([129, 140, 248, 255])
    expect(pixel(422, 270)).toEqual([17, 24, 39, 255])
    expect(pixel(655, 270)).toEqual([129, 140, 248, 255])
    let titlePixels = 0
    for (let y = 16; y < 40; y++) {
      for (let x = 24; x < 220; x++) {
        const [r, g, b] = pixel(x, y)
        if ((r ?? 0) > 180 && (g ?? 0) > 180 && (b ?? 0) > 180) titlePixels++
      }
    }
    expect(titlePixels).toBeGreaterThan(100)
  })

  it("encodes an alternate renderer and loads Cyrillic glyphs without system fonts", async () => {
    const svg = (text: string): RenderedChart => ({
      bytes: new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text x="2" y="28" font-size="24" font-family="sans-serif">${text}</text></svg>`,
      ),
      width: 100,
      height: 40,
      format: "svg",
      mimeType: "image/svg+xml",
    })
    const letters = PNG.sync.read(Buffer.from((await png(svg("ЖЩЫ"))).bytes))
    const missing = PNG.sync.read(Buffer.from((await png(svg("\u0378\u0378\u0378"))).bytes))
    expect(letters).toMatchObject({ width: 100, height: 40 })
    expect(letters.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
    expect(letters.data.equals(missing.data)).toBe(false)
  })

  it("**offline, with no engine yet: engine-missing with the command to retry, and the SVG still drawn**", async () => {
    const offline: Fetch = async () => {
      throw new TypeError("fetch failed")
    }
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "png-offline-")) }
    const svg = await (await chartRenderer()).render(chart, CHART_SIZE)
    expect(svg.format).toBe("svg")
    expect(await chartPng(svg, { env, fetch: offline })).toMatchObject({
      status: "engine-missing",
      engine: "@resvg/resvg-js",
      reason: "fetch failed",
      retry: "the same command, once this computer can reach registry.npmjs.org",
    })
  })
})
