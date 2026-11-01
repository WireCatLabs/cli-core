import { StringDecoder } from "node:string_decoder"
import { CliError } from "@wirecat/cli-base"
import { Option } from "commander"
import { MAX_SECRET_INPUT } from "../cli/input-policy.js"
import { stepLines } from "./step-lines.js"

/**
 * Opt-in, because a read nobody answers hangs: an agent running `session start` in a shell must get the refusal it
 * gets today, and only a caller that holds stdin open and answers each `needs` line (WireCat Desktop) passes it.
 */
export const answerStdinOption = (): Option =>
  new Option(
    "--answer-stdin",
    "with --json and no terminal: print each question as a `needs` line on stderr and read its answer, one line, from stdin",
  )

export interface Need {
  /** What is asked, for the caller to pick a field: `phone`, `code`, `password`, `api_id`, `api_hash`, `token`, `redirect`… */
  field: string
  /** Shown masked and never echoed. */
  secret: boolean
  prompt: string
  hint?: string | undefined
}

export interface SignInStepsOptions {
  /** Writes one whole line to the diagnostic stream; stdout keeps only the answer. */
  diagnostic: (line: string) => void
  /** Machine output (`--json`, `--jsonl`): only then are the steps printed. */
  json: boolean
  /** `--answer-stdin`. */
  answers: boolean
  input?: NodeJS.ReadableStream
}

/**
 * A sign-in told as JSON lines on the diagnostic stream, for a window to draw instead of a terminal: `open_url`,
 * `pairing_code`, `progress`, and `needs`, whose answer is one line on stdin. A QR code is `loginQr`'s `qr` line.
 */
export interface SignInSteps {
  readonly json: boolean
  /** Whether `ask` reads answers from stdin; tools keep their own terminal prompt otherwise. */
  readonly answers: boolean
  openUrl: (url: string, purpose: string) => void
  pairingCode: (code: string, where: string, expiresAt?: Date) => void
  progress: (step: string, message: string) => void
  /** A `signal` that aborts withdraws the question: the caller got its answer another way (a browser callback). */
  ask: (need: Need, signal?: AbortSignal) => Promise<string>
}

export const signInSteps = ({ diagnostic, json, answers, input = process.stdin }: SignInStepsOptions): SignInSteps => {
  if (answers && !json) throw new CliError("validation_error", "--answer-stdin needs --json")
  const emit = stepLines(diagnostic, json)
  const next = answers ? lineReader(input) : undefined
  return {
    json,
    answers,
    openUrl: (url, purpose) => emit({ event: "open_url", url, purpose }),
    pairingCode: (code, where, expiresAt) =>
      emit({ event: "pairing_code", code, where, expires_at: expiresAt?.toISOString() ?? null }),
    progress: (step, message) => emit({ event: "progress", step, message }),
    ask: async ({ field, secret, prompt, hint }, signal) => {
      if (!next)
        throw new CliError("validation_error", `the ${prompt} must be typed at a terminal`, {
          reason: "input.required",
        })
      signal?.throwIfAborted()
      emit({ event: "needs", field, secret, prompt, hint: hint ?? null })
      return await next(signal)
    },
  }
}

/**
 * One reader for the whole run, so a second answer that arrived with the first is not lost. It reads only while a
 * question waits and pauses stdin between them, so a pipe the caller keeps open does not hold the process after the
 * last answer.
 */
const lineReader = (input: NodeJS.ReadableStream & { ref?: () => void; unref?: () => void }) => {
  const decoder = new StringDecoder("utf8")
  let buffered = ""
  let ended = false
  return (signal?: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        input.off("data", data).off("end", end).off("error", fail)
        signal?.removeEventListener("abort", aborted)
        input.pause()
        // A paused pipe still holds the event loop; the tool must end once its work is done.
        input.unref?.()
      }
      const fail = (error: unknown) => {
        cleanup()
        reject(error)
      }
      const take = () => {
        const at = buffered.indexOf("\n")
        if (at < 0) return false
        const line = buffered.slice(0, at).replace(/\r$/, "")
        buffered = buffered.slice(at + 1)
        cleanup()
        resolve(line.trim())
        return true
      }
      const data = (chunk: Buffer | string) => {
        buffered += typeof chunk === "string" ? chunk : decoder.write(chunk)
        if (take()) return
        if (buffered.length > MAX_SECRET_INPUT)
          fail(new CliError("validation_error", "the answer exceeds its byte limit", { reason: "input.too-large" }))
      }
      const end = () => {
        ended = true
        fail(new CliError("cancelled", "the input closed before the answer came", { reason: "input.closed" }))
      }
      const aborted = () => fail(signal?.reason ?? new CliError("cancelled", "cancelled"))
      if (take()) return
      if (ended) return end()
      input.on("data", data).once("end", end).once("error", fail)
      signal?.addEventListener("abort", aborted, { once: true })
      input.ref?.()
      input.resume()
    })
}
