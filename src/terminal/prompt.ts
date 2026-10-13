import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import { CliError } from "@wirecat/cli-base"
import { bufferedInput, inputPolicy, MAX_SECRET_INPUT } from "../cli/input-policy.js"

export interface SecretInput {
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  output?: NodeJS.WritableStream
  /** For a phone number or an SMS code, which a person needs to see while typing. */
  echo?: boolean
  /** Cancels pending input without closing the caller's stream. */
  signal?: AbortSignal
}

/**
 * One line of secret, taken without a file and without argv.
 *
 * A token on a command line is read by `ps` and kept by shell history; a token in a file is a
 * second copy nobody remembers to delete. Both are avoided by never letting it land anywhere: it
 * is typed or piped, goes straight to the keyring, and is never echoed.
 *
 * The prompt goes to **stderr**, not stdout, so that `session start --json` still writes one JSON
 * value and nothing else.
 */
export const readSecret = async (
  prompt: string,
  { input = process.stdin, output = process.stderr, echo = false, signal: givenSignal }: SecretInput = {},
): Promise<string> => {
  const policy = inputPolicy(input)
  const signals = [givenSignal, policy.signal].filter((one): one is AbortSignal => one !== undefined)
  const signal = signals.length ? AbortSignal.any(signals) : undefined
  const cancelled = () => new CliError("cancelled", "cancelled — nothing was stored")
  if (signal?.aborted) throw cancelled()
  if (input.isTTY && policy.noInput)
    throw new CliError("validation_error", "interactive input is disabled — provide the input through a pipe", {
      reason: "input.required",
    })
  if (!input.isTTY) {
    return (
      await bufferedInput(input, {
        maxBytes: Math.min(policy.maxBytes ?? MAX_SECRET_INPUT, MAX_SECRET_INPUT),
        ...(signal ? { signal } : {}),
      })
    )
      .toString("utf8")
      .trim()
  }

  let muted = false
  const shim = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk)
      done()
    },
  })

  const reader = createInterface({ input, output: shim, terminal: true })
  const abort = () => reader.close()
  let bytes = 0
  let inputFailure: unknown
  const data = (chunk: Buffer | string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > Math.min(policy.maxBytes ?? MAX_SECRET_INPUT, MAX_SECRET_INPUT)) {
      inputFailure = new CliError("validation_error", "secret input exceeds its byte limit", {
        reason: "input.too-large",
        retryable: false,
      })
      reader.close()
    }
  }
  const inputError = (error: unknown) => {
    inputFailure = error
    reader.close()
  }
  input.on("data", data).on("error", inputError)
  try {
    // Ctrl-C and a closed terminal would otherwise leave this waiting for ever, and Node exits
    // on the unsettled promise with a warning and a code nobody documents.
    const answer = await new Promise<string>((resolve, reject) => {
      const cancel = () => reject(inputFailure ?? cancelled())
      reader.once("SIGINT", cancel)
      reader.once("close", cancel)
      signal?.addEventListener("abort", abort, { once: true })
      reader.question(prompt, resolve)
      muted = !echo
    })
    return answer.trim()
  } finally {
    input.off("data", data).off("error", inputError)
    signal?.removeEventListener("abort", abort)
    reader.close()
    output.write("\n")
  }
}
