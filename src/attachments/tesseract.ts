import { spawn } from "node:child_process"
import { CliError } from "@wirecat/cli-base"
import type { ModelImage } from "../models/index.js"
import { MAX_TEXT_CHARS } from "./limits.js"
import type { OcrPipeline } from "./ocr.js"

/** Russian first: an owner's scans are more often Russian, and the order only breaks ties. */
const LANGUAGES = ["rus", "eng"]
const PAGE_MS = 120_000
const PROBE_MS = 10_000

export const TESSERACT_HINT =
  "reading scans on this computer needs the tesseract program with its Russian and English data " +
  "(apt install tesseract-ocr tesseract-ocr-rus, brew install tesseract tesseract-lang); scans are read on the next sync"

interface Ran {
  code: number | null
  stdout: string
}

const run = (args: string[], env: NodeJS.ProcessEnv, timeout: number, input?: Uint8Array, signal?: AbortSignal) =>
  new Promise<Ran>((resolve, reject) => {
    // The PATH of the run's own environment finds the program, so a test or a moved run picks its own.
    const child = spawn("tesseract", args, {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      timeout,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      // Four bytes a character at most: more than that is never text the store keeps.
      if (size > MAX_TEXT_CHARS * 4) child.kill()
      else chunks.push(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }))
    child.stdin.on("error", () => {})
    child.stdin.end(input ?? new Uint8Array())
  })

/**
 * The OCR of the `tesseract` program on this computer, or why there is none. Nothing leaves the computer and
 * nothing is downloaded: the program and its language data are the owner's own install.
 */
export const tesseractPipeline = async (
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ pipeline: OcrPipeline } | { missing: string }> => {
  let version: Ran
  let listed: Ran
  try {
    version = await run(["--version"], env, PROBE_MS)
    listed = await run(["--list-langs"], env, PROBE_MS)
  } catch {
    return { missing: TESSERACT_HINT }
  }
  const number = /tesseract\s+v?(\d+(?:\.\d+)*)/iu.exec(version.stdout)?.[1]
  const installed = new Set(listed.stdout.split(/\r?\n/u).map((line) => line.trim()))
  const languages = LANGUAGES.filter((language) => installed.has(language))
  if (version.code !== 0 || !number || !languages.length) return { missing: TESSERACT_HINT }
  const chosen = languages.join("+")
  return {
    pipeline: {
      // The version and the languages name the reading, so installing Russian data later reads the scans again.
      extractor: `ocr:v1:tesseract@${number}:${chosen}`,
      transcribe: async (image: ModelImage) => {
        const read = await run(
          ["stdin", "stdout", "-l", chosen],
          env,
          PAGE_MS,
          Buffer.from(image.data, "base64"),
          signal,
        ).catch((error: unknown) => {
          if (signal?.aborted) throw new CliError("cancelled", "OCR cancelled")
          throw error
        })
        if (read.code !== 0) throw new Error("tesseract failed")
        return read.stdout.trim()
      },
    },
  }
}
