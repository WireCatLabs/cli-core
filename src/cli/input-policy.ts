import { CliError } from "@wirecat/cli-base"

export const MAX_BUFFERED_INPUT = 16 * 1024 * 1024
export const MAX_SECRET_INPUT = 64 * 1024

export interface InputPolicy {
  noInput?: boolean
  maxBytes?: number
  signal?: AbortSignal
}

const policies = new WeakMap<NodeJS.ReadableStream, InputPolicy>()

export const inputPolicy = (input: NodeJS.ReadableStream): InputPolicy => policies.get(input) ?? {}

export const provideInputPolicy = (input: NodeJS.ReadableStream, policy: InputPolicy): (() => void) => {
  const previous = policies.get(input)
  policies.set(input, policy)
  return () => {
    if (previous) policies.set(input, previous)
    else policies.delete(input)
  }
}

export const bufferedInput = (
  input: NodeJS.ReadableStream,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Buffer> => {
  const policy = inputPolicy(input)
  const maxBytes = options.maxBytes ?? policy.maxBytes ?? MAX_BUFFERED_INPUT
  const signals = [options.signal, policy.signal].filter((one): one is AbortSignal => one !== undefined)
  const signal = signals.length ? AbortSignal.any(signals) : undefined
  const state = input as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean }
  if (state.readableEnded) return Promise.resolve(Buffer.alloc(0))
  if (state.destroyed)
    return Promise.reject(new CliError("validation_error", "input closed before EOF", { reason: "input.closed" }))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      input.off("data", data).off("end", end).off("error", error).off("close", closed)
      signal?.removeEventListener("abort", aborted)
      input.pause()
    }
    const error = (cause: unknown) => {
      cleanup()
      reject(cause)
    }
    const aborted = () => error(new CliError("cancelled", "input cancelled", { retryable: false }))
    const closed = () => error(new CliError("validation_error", "input closed before EOF", { reason: "input.closed" }))
    const end = () => {
      cleanup()
      resolve(Buffer.concat(chunks, bytes))
    }
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) {
        error(
          new CliError(
            "validation_error",
            `buffered input exceeds ${maxBytes} bytes — use a smaller input or --max-input-bytes`,
            {
              reason: "input.too-large",
              max_bytes: maxBytes,
              retryable: false,
            },
          ),
        )
        return
      }
      chunks.push(buffer)
    }
    if (signal?.aborted) {
      aborted()
      return
    }
    input.on("data", data).once("end", end).once("error", error).once("close", closed)
    signal?.addEventListener("abort", aborted, { once: true })
    input.resume()
  })
}
