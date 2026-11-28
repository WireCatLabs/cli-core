import { fileURLToPath } from "node:url"
import { type EngineMissing, engineRequire, ensureEngine, SAME_COMMAND_AGAIN } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import type { Fetch } from "../speech/install.js"
import type { ChartSize, RenderedChart } from "./model.js"

export interface RenderedPng extends ChartSize {
  bytes: Uint8Array
  format: "png"
  mimeType: "image/png"
}

export interface PngOptions {
  env?: NodeJS.ProcessEnv
  fetch?: Fetch
  /** Lines for a person reading stderr; none for `--json` or MCP. */
  progress?: (line: string) => void
}

interface Resvg {
  renderAsync(svg: Buffer, options: object): Promise<{ asPng(): Uint8Array; width: number; height: number }>
}

/**
 * The chart as a PNG, drawn by resvg, which installs into the WireCat data folder on first use. When it cannot be
 * installed the answer is its `engine-missing` state: the SVG needs no engine, so a caller still has the chart.
 */
export const chartPng = async (svg: RenderedChart, options: PngOptions = {}): Promise<RenderedPng | EngineMissing> => {
  const state = await ensureEngine(ENGINE_PINS["@resvg/resvg-js"], {
    retry: SAME_COMMAND_AGAIN,
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.progress ? { progress: options.progress } : {}),
  })
  if (state.status !== "ready") return state
  const { renderAsync } = engineRequire(state.folder)("@resvg/resvg-js") as Resvg
  const image = await renderAsync(Buffer.from(svg.bytes), {
    font: {
      fontFiles: [fileURLToPath(new URL("./fonts/NotoSans-Regular.ttf", import.meta.url))],
      loadSystemFonts: false,
      defaultFontFamily: "Noto Sans",
      sansSerifFamily: "Noto Sans",
    },
  })
  return { bytes: image.asPng(), format: "png", mimeType: "image/png", width: image.width, height: image.height }
}

/** The answer's `meta` when the PNG could not be drawn: incomplete, naming the engine. */
export const engineIssue = (missing: EngineMissing | undefined) =>
  missing
    ? {
        complete: false,
        issues: [{ code: "configuration_error" as const, reason: "engine.missing", source: missing.engine }],
      }
    : {}
