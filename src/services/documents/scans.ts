import { CliError } from "@wirecat/cli-base"
import { engineHint, importEngine, type LoadEngine } from "../../attachments/extract.js"
import { MAX_PAGES, type OcrPipeline, ocrImage, ocrPdf } from "../../attachments/ocr.js"
import { tesseractPipeline } from "../../attachments/tesseract.js"
import { type AiCallDeps, aiImageReader, aiOrigin, aiSettingPath, readAiSetting } from "../../models/ai.js"
import { NO_TEXT_LAYER } from "./file-text.js"

/** Who reads the text of a scan or a picture: this computer, one of the two model providers the owner allows, or no one. */
export const SCAN_READERS = ["local", "anthropic", "openai", "off"] as const
export type ScanReaderChoice = (typeof SCAN_READERS)[number]

/** Pages one file may have to be read by OCR; a longer scan is kept by name only. */
export const SCAN_PAGES_PER_FILE = MAX_PAGES
/** Pages one sync reads by OCR; the rest wait for the next sync. */
export const SCAN_PAGES_PER_SYNC = 100

const OFFICIAL: Record<"anthropic" | "openai", string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
}
const PICTURES = new Set(["image/jpeg", "image/png", "image/webp"])
const UNAVAILABLE = "scans are not read: "
const LATER = "OCR page limit of this sync reached"

/** A picture OCR reads: what `ocrImage` takes. Other images (TIFF, HEIC) stay by name only. */
export const isPicture = (file: { mime: string }): boolean => PICTURES.has(file.mime)

const PICTURE_BYTES = 25 * 1024 * 1024

/**
 * The CLI's skip reason with a picture it keeps for its type let through when a reader reads pictures: CLIs name
 * every image `unsupported type: …`, as no text reader takes one.
 */
export const scanSkipReason = (
  reader: ScanReader | undefined,
  file: { mime: string; size?: number | undefined },
  reason: string | undefined,
): string | undefined =>
  reason?.startsWith("unsupported type: ") &&
  reader?.extractor !== undefined &&
  isPicture(file) &&
  (file.size ?? 0) <= PICTURE_BYTES
    ? undefined
    : reason

/** Reads the text of a scan or a picture, or fails as `validation_error` with the reason the file is kept by name. */
export interface ScanReader {
  /** The reading's name, saved with the text, so a change of engine or model reads the scans again. Unset: none. */
  extractor?: string
  read(bytes: Uint8Array, file: { name: string; mime: string }): Promise<string>
}

/** A skip this reader would now read: a scan an earlier sync could not, or one this sync's page limit held back. */
export const scanRetry = (reader: ScanReader | undefined, reason: string): boolean =>
  reader?.extractor !== undefined &&
  (reason.startsWith(NO_TEXT_LAYER) || reason.startsWith(UNAVAILABLE) || reason.startsWith(LATER))

const refusing = (why: string): ScanReader => ({
  read: async () => {
    throw new CliError("validation_error", `${UNAVAILABLE}${why}`, { reason: "document.scan-unread" })
  },
})

const modelPipeline = (choice: "anthropic" | "openai", deps: AiCallDeps): OcrPipeline | string => {
  const setting = readAiSetting(aiSettingPath(deps.env))
  // Only these two providers at their own address: an OpenAI-shaped address elsewhere is another provider.
  if (!setting || setting.provider !== choice || aiOrigin(setting) !== OFFICIAL[choice])
    return `read_scans is ${choice}, but the AI model is not ${choice} at ${OFFICIAL[choice]}; choose it with \`ai set\``
  const reader = aiImageReader(deps)
  if ("refused" in reader)
    return reader.refused === "ai.key-missing"
      ? `the ${choice} key is missing; add it with \`ai set\``
      : `pictures may not go to ${setting.model} yet; allow them with \`ai set --images\``
  return reader.pipeline
}

const reasonOf = (status: string, engine?: string, command = "this tool") =>
  status === "too-large"
    ? `scan is over ${SCAN_PAGES_PER_FILE} pages, or a page is too large to read`
    : status === "engine-missing" && engine
      ? `${UNAVAILABLE}${engineHint(engine as Parameters<typeof engineHint>[0], command)}`
      : status === "needs-agent"
        ? "picture is too large to read"
        : "OCR could not read the file"

/**
 * The scan reader a documents sync uses, from the profile's `read_scans`: undefined for `off`. A local reader that
 * finds no program, or a model the settings do not allow, still answers, with the reason as each file's skip.
 */
export const scanReader = async (
  choice: ScanReaderChoice,
  deps: AiCallDeps & { command: string },
  load: LoadEngine = importEngine,
): Promise<ScanReader | undefined> => {
  if (choice === "off") return undefined
  let pipeline: OcrPipeline
  if (choice === "local") {
    const local = await tesseractPipeline(deps.env, deps.signal)
    if ("missing" in local) return refusing(local.missing)
    pipeline = local.pipeline
  } else {
    const model = modelPipeline(choice, deps)
    if (typeof model === "string") return refusing(model)
    pipeline = model
  }
  let pages = 0
  let held = false
  const counted: OcrPipeline = {
    extractor: pipeline.extractor,
    transcribe: async (image) => {
      if (pages >= SCAN_PAGES_PER_SYNC) {
        held = true
        throw new Error("page limit")
      }
      pages += 1
      return pipeline.transcribe(image)
    },
  }
  return {
    extractor: pipeline.extractor,
    read: async (bytes, file) => {
      if (pages >= SCAN_PAGES_PER_SYNC)
        throw new CliError("validation_error", `${LATER}; the next sync goes on`, { reason: "document.scan-later" })
      const pdf = Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-"
      if (!pdf && !isPicture(file)) throw new CliError("validation_error", reasonOf("needs-agent"))
      held = false
      const read = pdf ? await ocrPdf(bytes, counted, load, deps.signal) : await ocrImage(bytes, counted, deps.signal)
      if (read.status === "extracted") return read.text
      if (held)
        throw new CliError("validation_error", `${LATER}; the next sync goes on`, { reason: "document.scan-later" })
      throw new CliError(
        "validation_error",
        reasonOf(read.status, read.status === "engine-missing" ? read.engine : undefined, deps.command),
        { reason: "document.scan-unread" },
      )
    },
  }
}
