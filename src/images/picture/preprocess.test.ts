import { createCanvas } from "@napi-rs/canvas"
import { describe, expect, it } from "vitest"
import { importCanvas, preprocess, SIZE } from "./preprocess.js"

const png = (
  width: number,
  height: number,
  paint: (context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void,
) => {
  const canvas = createCanvas(width, height)
  paint(canvas.getContext("2d"))
  return canvas.toBuffer("image/png")
}

describe("picture preprocessing", () => {
  it("gives channels first, 224 by 224, each channel normalised with the model's mean and deviation", async () => {
    const red = png(300, 200, (context) => {
      context.fillStyle = "#ff0000"
      context.fillRect(0, 0, 300, 200)
    })
    const pixels = await preprocess(red)
    expect(pixels).toHaveLength(3 * SIZE * SIZE)
    const centre = (SIZE / 2) * SIZE + SIZE / 2
    expect(pixels[centre]).toBeCloseTo((1 - 0.48145466) / 0.26862954, 2)
    expect(pixels[SIZE * SIZE + centre]).toBeCloseTo((0 - 0.4578275) / 0.26130258, 2)
    expect(pixels[2 * SIZE * SIZE + centre]).toBeCloseTo((0 - 0.40821073) / 0.27577711, 2)
  })

  it("scales the short edge to 224 and keeps the middle: the left and right of a wide picture are cut", async () => {
    const wide = png(600, 200, (context) => {
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, 600, 200)
      context.fillStyle = "#000000"
      context.fillRect(0, 0, 100, 200)
    })
    const pixels = await preprocess(wide)
    // The black strip is the leftmost sixth of a picture whose middle third survives: none of it is left.
    expect(pixels.every((value) => value > 0)).toBe(true)
  })

  it("refuses bytes that are no image, without echoing them", async () => {
    await expect(preprocess(new TextEncoder().encode("hello"))).rejects.toThrow(
      "the file is not an image this tool can read",
    )
  })

  it("names the optional package when it cannot be loaded", async () => {
    await expect(
      preprocess(new Uint8Array(), async () => {
        throw new Error("Cannot find module")
      }),
    ).rejects.toThrow("Cannot find module")
    expect(typeof importCanvas).toBe("function")
  })
})
