import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import { CliError } from "@wirecat/cli-base"
import { hostFetch } from "@wirecat/cli-base/http"
import {
  domainListsDirectory,
  type InstalledPack,
  installedPack,
  listFile,
  PACK_MANIFEST_URL,
  type PackManifest,
  type PackSource,
} from "../domain/domain-lists.js"
import { type Fetch, installFiles, megabytes } from "../speech/install.js"

export interface DomainListsUpdateOptions {
  env: NodeJS.ProcessEnv
  /** Leave out `non-commercial` sources, and remove those already here. */
  commercialOnly?: boolean
  fetch?: Fetch
  manifestUrl?: string
  progress?: (line: string) => void
  bytes?: (done: number, total: number) => void
}

export interface DomainListsUpdate {
  pack: InstalledPack
  updated: boolean
  previous: string | null
}

/** Where a release asset is served from: GitHub answers with a redirect to its asset host. */
const RELEASE_HOSTS = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]
const DOWNLOAD_MS = 10 * 60_000

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const SHA256 = /^[0-9a-f]{64}$/
const DOMAIN = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9])?$/

const invalid = (what: string) => new CliError("invalid_response", `the domain-list manifest ${what}`)

/** The manifest as a release serves it, refused whole when a source would write outside the pack or skip its check. */
export const parseManifest = (value: unknown): PackManifest => {
  const manifest = value as PackManifest
  if (typeof manifest?.version !== "string" || !Array.isArray(manifest.sources))
    throw invalid("has no version or sources")
  const ids = new Set<string>()
  for (const source of manifest.sources) {
    if (typeof source.id !== "string" || !ID.test(source.id) || ids.has(source.id))
      throw invalid(`names a bad or repeated source id: ${String(source.id)}`)
    ids.add(source.id)
    if (typeof source.url !== "string" || !source.url.startsWith("https://"))
      throw invalid(`gives ${source.id} a url that is not https`)
    if (!["sector", "freemail", "bad"].includes(source.signal)) throw invalid(`gives ${source.id} no signal`)
    if (source.class !== "commercial-ok" && source.class !== "non-commercial")
      throw invalid(`gives ${source.id} no licence class`)
    if (source.upstream === true) {
      if (!Number.isSafeInteger(source.max_bytes)) throw invalid(`gives upstream ${source.id} no size limit`)
    } else if (!SHA256.test(source.sha256 ?? "") || !Number.isSafeInteger(source.bytes))
      throw invalid(`gives ${source.id} no sha256 and size`)
  }
  return manifest
}

const fetchManifest = async (url: string, get: Fetch): Promise<PackManifest> => {
  const response = await get(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new CliError("network_error", `the domain-list manifest could not be downloaded: HTTP ${response.status}`)
  }
  try {
    return parseManifest(await response.json())
  } catch (error) {
    if (error instanceof CliError) throw error
    throw invalid("is not JSON")
  }
}

const gunzipTo = async (from: string, to: string) =>
  pipeline(createReadStream(from), createGunzip(), createWriteStream(to, { flags: "wx", mode: 0o600 }))

/**
 * A list the source does not let us redistribute, fetched from the source itself, whole. Nothing pins its bytes, so
 * its sha256 is recorded as it arrived, and only lines that read as a domain are kept.
 */
const fetchUpstream = async (source: PackSource, path: string, get: Fetch) => {
  const response = await get(source.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new CliError("network_error", `${source.id} could not be downloaded from its source: HTTP ${response.status}`)
  }
  const limit = source.max_bytes ?? 0
  const hash = createHash("sha256")
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length
    if (bytes > limit) throw new CliError("invalid_response", `${source.id} is larger than ${megabytes(limit)}`)
    hash.update(chunk)
    chunks.push(Buffer.from(chunk))
  }
  const lines = [
    ...new Set(
      Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter((line) => DOMAIN.test(line) && line.includes(".")),
    ),
  ]
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 })
  return { sha256: hash.digest("hex"), lines: lines.length, bytes }
}

/**
 * Brings the pack to the newest release: every file checked against the manifest's sha256 as it arrives, then the
 * whole folder swapped at once, so a failed download leaves the pack as it was. Nothing is downloaded when the pack
 * here is already that version with the same sources.
 */
export const updateDomainLists = async ({
  env,
  commercialOnly = false,
  fetch: given,
  manifestUrl = PACK_MANIFEST_URL,
  progress = () => {},
  bytes,
}: DomainListsUpdateOptions): Promise<DomainListsUpdate> => {
  const manifest = await fetchManifest(
    manifestUrl,
    given ?? hostFetch({ hosts: [...RELEASE_HOSTS, new URL(manifestUrl).hostname], timeoutMs: 60_000 }),
  )
  const get =
    given ??
    hostFetch({
      hosts: [...RELEASE_HOSTS, ...manifest.sources.map((one) => new URL(one.url).hostname)],
      timeoutMs: DOWNLOAD_MS,
    })
  const before = installedPack(env)
  const sources = manifest.sources.filter((one) => !commercialOnly || one.class === "commercial-ok")
  if (
    before !== undefined &&
    before.version === manifest.version &&
    before.commercial_only === commercialOnly &&
    sources.every((one) => before.files[one.id] !== undefined)
  )
    return { pack: before, updated: false, previous: before.version }
  const directory = domainListsDirectory(env)
  const staging = `${directory}.${randomUUID()}.part`
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    const published = sources.filter((one) => !one.upstream)
    const weight = published.reduce((sum, one) => sum + (one.bytes ?? 0), 0)
    progress(`domain lists ${manifest.version}: ${megabytes(weight)} from the WireCat release`)
    await installFiles(
      published.map((one) => [
        { name: `${one.id}.txt.gz`, url: one.url, sha256: one.sha256 ?? "", bytes: one.bytes ?? 0 },
        `${listFile(staging, one.id)}.gz`,
      ]),
      { fetch: get, progress, ...(bytes ? { bytes } : {}) },
    )
    const files: InstalledPack["files"] = {}
    for (const source of published) {
      const path = listFile(staging, source.id)
      await gunzipTo(`${path}.gz`, path)
      await rm(`${path}.gz`)
      files[source.id] = { sha256: source.sha256 ?? "", lines: source.count ?? 0, bytes: source.bytes ?? 0 }
    }
    for (const source of sources.filter((one) => one.upstream)) {
      progress(`${source.id}: from ${new URL(source.url).host}, under its own terms (${source.licence})`)
      files[source.id] = await fetchUpstream(source, listFile(staging, source.id), get)
    }
    const pack: InstalledPack = {
      ...manifest,
      installed_at: new Date().toISOString(),
      commercial_only: commercialOnly,
      files,
    }
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 })
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
    const old = `${directory}.${randomUUID()}.old`
    await rename(directory, old).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    await rename(staging, directory)
    await rm(old, { recursive: true, force: true })
    return { pack, updated: true, previous: before?.version ?? null }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
