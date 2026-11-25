import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { wirecatDirectory } from "../store/path.js"
import { isSector, type Sector } from "./organization-sectors.js"

/**
 * The domain-list pack: lists too big, too often updated or share-alike to build into the package. Published as
 * assets of a WireCat GitHub release, downloaded whole by `domain-lists update` and matched only on this computer:
 * a lookup per sender would tell a third party who writes to the owner.
 */
export const PACK_TAG = "domain-lists"
export const PACK_MANIFEST_URL = `https://github.com/WireCatLabs/cli-core/releases/download/${PACK_TAG}/manifest.json`

/**
 * `commercial-ok`: any use, paid services included. `non-commercial`: WireCat, which is free, may use it; a paid
 * service built around WireCat may not, and leaves it out with `--commercial-only`.
 */
export type LicenceClass = "commercial-ok" | "non-commercial"

/**
 * One list. `sector` files give an organization its sector; `bad` files only say a host is known for spam, phishing
 * or malware, and never set a sector. A line is a domain, or a domain, a tab and a sector (or a source's own
 * category, for `bad`). `upstream` lists may not be redistributed: the command fetches them from their source, whole.
 */
export interface PackSource {
  id: string
  title: string
  signal: "sector" | "bad"
  /** The sector or category of a line that names none. */
  tag?: string
  licence: string
  licence_url: string
  class: LicenceClass
  attribution: string
  homepage: string
  /** Where the file is: the release asset, or the source itself for `upstream`. */
  url: string
  /** The gzip file as published; absent for `upstream`, whose file changes at its source. */
  sha256?: string
  bytes?: number
  /** The most an `upstream` file may weigh. */
  max_bytes?: number
  upstream?: boolean
  /** Lines in the published file; absent for `upstream`. */
  count?: number
  /** Lines per tag, for `domain-lists list`. */
  tags?: Record<string, number>
  fetched_at?: string
}

export interface PackManifest {
  /** The build date, `YYYY-MM-DD`, newest wins. */
  version: string
  built_at: string
  sources: PackSource[]
}

/** The pack as this computer holds it: what was installed from which manifest. */
export interface InstalledPack extends PackManifest {
  installed_at: string
  commercial_only: boolean
  /** The files in place, by source id: their sha256 as checked, and their lines. */
  files: Record<string, { sha256: string; lines: number; bytes: number }>
}

/** Shared by every CLI of the family, like the models: one pack per computer. */
export const domainListsDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  join(wirecatDirectory(env), "lists", "domains")

export const listFile = (directory: string, id: string): string => join(directory, `${id}.txt`)

export const installedPack = (env: NodeJS.ProcessEnv = process.env): InstalledPack | undefined => {
  try {
    return JSON.parse(readFileSync(join(domainListsDirectory(env), "manifest.json"), "utf8")) as InstalledPack
  } catch {
    return undefined
  }
}

export interface DomainHits {
  /** The pack's sectors of each domain looked up, in list order. */
  sectors: Map<string, Sector[]>
  /** The `bad` sources that name each host exactly, as `source` or `source:category`. */
  bad: Map<string, string[]>
}

export interface LookupOptions {
  env?: NodeJS.ProcessEnv
  /** Leave out `non-commercial` sources even when they are installed: a paid service sets it. */
  commercialOnly?: boolean
}

const CHUNK = 1 << 20

/**
 * Reads each list once from disk, a megabyte at a time, keeping only the lines naming `hosts`. Exact names only: an
 * entry `click.mail.brand.example` says nothing about `brand.example`. The pack's biggest list has millions of lines,
 * so it is never held in memory; the caller passes the few hosts it needs.
 */
export const lookupDomains = (hosts: ReadonlySet<string>, options: LookupOptions = {}): DomainHits => {
  const hits: DomainHits = { sectors: new Map(), bad: new Map() }
  const pack = installedPack(options.env)
  if (pack === undefined || hosts.size === 0) return hits
  const directory = domainListsDirectory(options.env)
  for (const source of pack.sources) {
    if (pack.files[source.id] === undefined) continue
    if (options.commercialOnly && source.class !== "commercial-ok") continue
    scanLines(listFile(directory, source.id), (line) => {
      const tab = line.indexOf("\t")
      const host = tab === -1 ? line : line.slice(0, tab)
      if (!hosts.has(host)) return
      const tag = tab === -1 ? source.tag : line.slice(tab + 1)
      if (source.signal === "bad") {
        const name = tag === undefined ? source.id : `${source.id}:${tag}`
        hits.bad.set(host, [...(hits.bad.get(host) ?? []), name])
      } else if (tag !== undefined && isSector(tag)) hits.sectors.set(host, [...(hits.sectors.get(host) ?? []), tag])
    })
  }
  return hits
}

const scanLines = (path: string, line: (text: string) => void): void => {
  let descriptor: number
  try {
    descriptor = openSync(path, "r")
  } catch {
    return
  }
  try {
    const buffer = Buffer.allocUnsafe(CHUNK)
    const text = new StringDecoder("utf8")
    let rest = ""
    for (;;) {
      const read = readSync(descriptor, buffer, 0, CHUNK, null)
      if (read === 0) break
      const lines = (rest + text.write(buffer.subarray(0, read))).split("\n")
      rest = lines.pop() ?? ""
      for (const one of lines) if (one !== "") line(one)
    }
    if (rest !== "") line(rest)
  } finally {
    closeSync(descriptor)
  }
}
