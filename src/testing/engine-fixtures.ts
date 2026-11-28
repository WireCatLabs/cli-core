import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "fflate"
import type { EnginePackage, EnginePin } from "../engines/install.js"
import type { Fetch } from "../speech/install.js"

export interface TarFile {
  path: string
  data?: string | Uint8Array
  /** `0` a file (the default), `5` a folder, `2` a symbolic link. */
  type?: "0" | "2" | "5"
  mode?: number
}

const header = (file: TarFile, size: number): Uint8Array => {
  const block = new Uint8Array(512)
  const put = (text: string, at: number) => block.set(new TextEncoder().encode(text), at)
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0")
  put(file.path, 0)
  put(octal(file.mode ?? 0o644, 8), 100)
  put(octal(0, 8), 108)
  put(octal(0, 8), 116)
  put(octal(size, 12), 124)
  put(octal(0, 12), 136)
  put("        ", 148)
  put(file.type ?? "0", 156)
  if (file.type === "2") put("../../../outside", 157)
  put("ustar\u000000", 257)
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(`${octal(sum, 7)}\u0000`, 148)
  return block
}

/** A gzipped ustar archive of `files`, as `npm pack` writes one (each path under `package/`). */
export const tarball = (files: TarFile[]): Uint8Array => {
  const parts: Uint8Array[] = []
  for (const file of files) {
    const data = typeof file.data === "string" ? new TextEncoder().encode(file.data) : (file.data ?? new Uint8Array())
    parts.push(header(file, file.type === "0" || file.type === undefined ? data.length : 0))
    if (file.type === "0" || file.type === undefined) {
      parts.push(data)
      parts.push(new Uint8Array((512 - (data.length % 512)) % 512))
    }
  }
  parts.push(new Uint8Array(1024))
  const tar = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    tar.set(part, at)
    at += part.length
  }
  return gzipSync(tar)
}

export const integrityOf = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

export interface FixturePackage {
  name: string
  version: string
  files: TarFile[]
  os?: string[]
  cpu?: string[]
  path?: string
}

/** An engine of `packages`, each served at `${base}/<name>-<version>.tgz`, with the bytes each URL answers. */
export const fixtureEngine = (
  base: string,
  name: string,
  version: string,
  packages: FixturePackage[],
): { pin: EnginePin; bodies: Map<string, Uint8Array> } => {
  const bodies = new Map<string, Uint8Array>()
  const pinned: EnginePackage[] = packages.map((pkg) => {
    const bytes = tarball(pkg.files)
    const url = `${base}/${(pkg.path ?? pkg.name).replaceAll("/", "-")}-${pkg.version}.tgz`
    bodies.set(url, bytes)
    return {
      name: pkg.name,
      version: pkg.version,
      url,
      integrity: integrityOf(bytes),
      bytes: bytes.length,
      ...(pkg.os ? { os: pkg.os } : {}),
      ...(pkg.cpu ? { cpu: pkg.cpu } : {}),
      ...(pkg.path ? { path: pkg.path } : {}),
    }
  })
  return { pin: { name, version, packages: pinned }, bodies }
}

/** The CommonJS files of a package whose `index.js` answers `answer` and loads `needs`, its dependency, when named. */
export const packageFiles = (name: string, version: string, answer: string, needs?: string): TarFile[] => [
  { path: "package/package.json", data: JSON.stringify({ name, version, main: "index.js" }) },
  {
    path: "package/index.js",
    data: needs
      ? `module.exports = { answer: ${JSON.stringify(answer)}, needs: require(${JSON.stringify(needs)}).answer }`
      : `module.exports = { answer: ${JSON.stringify(answer)} }`,
  },
]

/** A fake registry: each URL answers its bytes, counted; an unknown URL answers 404. */
export const fakeRegistry = (bodies: Map<string, Uint8Array>) => {
  const requests = new Map<string, number>()
  const fetch: Fetch = async (url) => {
    requests.set(url, (requests.get(url) ?? 0) + 1)
    const body = bodies.get(url)
    return body ? new Response(body.slice()) : new Response("not found", { status: 404 })
  }
  return { fetch, requests }
}

/**
 * The same registry over HTTP on 127.0.0.1, for a child process or Bun. `hold` keeps a URL's answer open after its
 * first bytes until `release` is called, so a test can stop an install halfway.
 */
export const serveRegistry = async (
  files: Map<string, Uint8Array>,
): Promise<{ base: string; server: Server; requests: Map<string, number>; hold: Set<string>; release: () => void }> => {
  const requests = new Map<string, number>()
  const hold = new Set<string>()
  const waiting: (() => void)[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? ""
    requests.set(path, (requests.get(path) ?? 0) + 1)
    const body = files.get(path)
    if (!body) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-length": body.length })
    if (!hold.has(path)) {
      response.end(Buffer.from(body))
      return
    }
    response.write(Buffer.from(body.subarray(0, 1)))
    waiting.push(() => response.end(Buffer.from(body.subarray(1))))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    requests,
    hold,
    release: () => {
      for (const go of waiting.splice(0)) go()
    },
  }
}
