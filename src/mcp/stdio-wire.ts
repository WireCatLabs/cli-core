import { PassThrough, type Readable, Writable } from "node:stream"

type JsonRpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { requestId?: unknown } }

const lineReader = (onMessage: (message: JsonRpc) => void) => {
  let rest = ""
  return (chunk: Buffer | string) => {
    const lines = (rest + chunk.toString()).split("\n")
    rest = lines.pop() ?? ""
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as JsonRpc
        if (message !== null && typeof message === "object") onMessage(message)
      } catch {
        // Not a message; the transport answers it as a parse error.
      }
    }
  }
}

/**
 * Stdin and stdout as the transport sees them, noting each request that comes in and each answer that goes out, so
 * the server can tell when everything asked has been answered. The transport's stdin never ends by itself: the server
 * closes it, after the client's stdin ended and the last answer went out.
 */
export const answeredWire = (source: Readable, sink: Writable) => {
  const asked = new Set<string>()
  let settle: (() => void) | undefined
  const input = new PassThrough()
  const answeredOne = (id: unknown) => {
    asked.delete(JSON.stringify(id))
    if (asked.size === 0) settle?.()
  }
  // The SDK answers neither a line it cannot parse as JSON-RPC 2.0 nor a request the client cancelled: waiting
  // for either would keep the server open after the client is gone.
  const onData = lineReader(({ jsonrpc, id, method, params }) => {
    if (jsonrpc !== "2.0" || typeof method !== "string") return
    if (method === "notifications/cancelled") answeredOne(params?.requestId)
    else if (id !== undefined) asked.add(JSON.stringify(id))
  })
  const output = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      noteAnswer(chunk)
      sink.write(chunk, done)
    },
  })
  const noteAnswer = lineReader(({ id, method }) => {
    if (id !== undefined && method === undefined) answeredOne(id)
  })
  const forward = (chunk: Buffer) => {
    onData(chunk)
    input.write(chunk)
  }
  source.on("data", forward)
  const ended = new Promise<void>((resolve) => {
    source.once("end", resolve)
    source.once("close", resolve)
  })
  return {
    input,
    output,
    /**
     * Until the client's stdin ended and everything it asked was answered, or until a stop: `signal` for a session
     * relayed on other streams, SIGINT or SIGTERM for this process's own. A stop never waits for answers.
     */
    finished: (signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop)
          process.off("SIGTERM", stop)
          resolve()
        }
        if (signal) {
          if (signal.aborted) return resolve()
          signal.addEventListener("abort", stop, { once: true })
        } else {
          process.once("SIGINT", stop)
          process.once("SIGTERM", stop)
        }
        ended.then(() => {
          if (asked.size === 0) stop()
          else settle = stop
        })
      }),
    /** Lets go of the real stdin, so it no longer holds the process open. */
    release: () => {
      source.off("data", forward)
      if (source.listenerCount("data") === 0) source.pause()
      input.end()
    },
  }
}
