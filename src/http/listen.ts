import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Readable } from "node:stream"

export type Handle = (request: Request) => Promise<Response>

/** A web-standard handler on a Node socket. */
export interface Listening {
  url: URL
  close(): Promise<void>
}

/** Larger bodies are refused unread: the port faces the internet. MCP requests are small JSON. */
export const MAX_BODY = 4 * 1024 * 1024

class TooLarge extends Error {}

const readBody = (incoming: IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    if (Number(incoming.headers["content-length"] ?? 0) > limit) return reject(new TooLarge())
    const chunks: Buffer[] = []
    let size = 0
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        incoming.destroy()
        reject(new TooLarge())
      } else chunks.push(chunk)
    })
    incoming.once("end", () => resolve(Buffer.concat(chunks)))
    incoming.once("error", reject)
  })

const toRequest = async (incoming: IncomingMessage, origin: string, maxBody: number): Promise<Request> => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one)
    else if (value !== undefined) headers.set(name, value)
  }
  const method = incoming.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(incoming, maxBody)
  if (body) headers.set("content-length", String(body.length))
  return new Request(new URL(incoming.url ?? "/", origin), { method, headers, ...(body ? { body } : {}) })
}

const send = async (response: Response, outgoing: ServerResponse) => {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) return void outgoing.end()
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
  outgoing.once("close", () => body.destroy())
  body.pipe(outgoing)
}

/**
 * Binds `host` only — never every interface: the public address is the owner's tunnel.
 * `close` ends open streams too, so the process can exit.
 */
export const listen = (
  handle: Handle,
  { host, port, maxBody = MAX_BODY }: { host: string; port: number; maxBody?: number },
): Promise<Listening> =>
  new Promise((resolve, reject) => {
    const server = createServer((incoming, outgoing) => {
      toRequest(incoming, `http://${host}`, maxBody)
        .then(handle)
        .then((response) => send(response, outgoing))
        .catch((error: unknown) => {
          if (!outgoing.headersSent) outgoing.writeHead(error instanceof TooLarge ? 413 : 500, { connection: "close" })
          outgoing.end()
        })
    })
    server.once("error", reject)
    server.listen(port, host, () => {
      const { port: bound } = server.address() as AddressInfo
      resolve({
        url: new URL(`http://${host}:${bound}`),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
