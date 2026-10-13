import { CliError } from "@wirecat/cli-base"

export const SIZE = 224

/** `preprocessor_config.json` of the model, as read once. */
const MEAN = [0.48145466, 0.4578275, 0.40821073] as const
const STD = [0.26862954, 0.26130258, 0.27577711] as const

interface Canvas {
  createCanvas(
    width: number,
    height: number,
  ): {
    getContext(kind: "2d"): {
      fillStyle: string
      imageSmoothingQuality: string
      fillRect(x: number, y: number, width: number, height: number): void
      drawImage(
        image: unknown,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
      ): void
      getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray }
    }
  }
  loadImage(bytes: Uint8Array): Promise<{ width: number; height: number }>
}

export type LoadCanvas = () => Promise<Canvas>

export const importCanvas: LoadCanvas = async () => {
  try {
    return (await import("@napi-rs/canvas")) as unknown as Canvas
  } catch {
    throw new CliError(
      "validation_error",
      "searching pictures needs the optional package @napi-rs/canvas to read an image — install it next to this tool",
    )
  }
}

/**
 * What the vision side takes: the shorter edge scaled to 224, the middle 224 by 224 kept, each channel in 0–1
 * and then `(x − mean) / std`, channels first. A transparent background is white; the resize is the canvas's
 * own, not the reference's bicubic, which moves the vector by a rounding.
 */
export const preprocess = async (bytes: Uint8Array, load: LoadCanvas = importCanvas): Promise<Float32Array> => {
  const { createCanvas, loadImage } = await load()
  let image: Awaited<ReturnType<Canvas["loadImage"]>>
  try {
    image = await loadImage(bytes)
  } catch {
    throw new CliError("invalid_response", "the file is not an image this tool can read")
  }
  const scale = SIZE / Math.min(image.width, image.height)
  const width = Math.max(SIZE, Math.round(image.width * scale))
  const height = Math.max(SIZE, Math.round(image.height * scale))
  const surface = createCanvas(SIZE, SIZE)
  const context = surface.getContext("2d")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, SIZE, SIZE)
  context.imageSmoothingQuality = "high"
  context.drawImage(
    image,
    0,
    0,
    image.width,
    image.height,
    Math.round((SIZE - width) / 2),
    Math.round((SIZE - height) / 2),
    width,
    height,
  )
  const { data } = context.getImageData(0, 0, SIZE, SIZE)
  const plane = SIZE * SIZE
  const pixels = new Float32Array(3 * plane)
  for (let at = 0; at < plane; at++) {
    for (let channel = 0; channel < 3; channel++) {
      pixels[channel * plane + at] =
        ((data[at * 4 + channel] as number) / 255 - (MEAN[channel] as number)) / (STD[channel] as number)
    }
  }
  return pixels
}
