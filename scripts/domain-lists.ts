// Builds the domain-list pack into a folder: one gzip file per source and manifest.json, for
// .github/workflows/domain-lists.yml to publish as release assets. Never at run time: the CLIs download the result
// whole (`domain-lists update`) and match senders on the owner's computer.
// Run: node --experimental-strip-types scripts/domain-lists.ts <out folder>
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { getDomain, parse } from "tldts"
import type { PackManifest, PackSource } from "../src/domain/domain-lists.ts"

const OUT = resolve(process.argv[2] ?? "domain-lists")
const VERSION = new Date().toISOString().slice(0, 10)
const RELEASE = `https://github.com/WireCatLabs/cli-core/releases/download/domain-lists-${VERSION}`
const USER_AGENT = "WireCat-build/1.0 (https://github.com/WireCatLabs/cli-core)"

const UT1_URL = "https://dsi.ut-capitole.fr/blacklists/download/blacklists.tar.gz"
const UT1 = {
  homepage: "https://dsi.ut-capitole.fr/blacklists/index_en.php",
  licence: "CC BY-SA 4.0",
  licence_url: "https://creativecommons.org/licenses/by-sa/4.0/",
  class: "commercial-ok",
  attribution:
    "UT1 blacklists by Fabrice Prigent, Université Toulouse Capitole, under CC BY-SA 4.0. Kept as its own file, " +
    "not merged with other data, so the share-alike terms stay on this file.",
} as const
// UT1 category → our sector. UT1 has no travel, health, education, utility, insurance or software category.
const UT1_SECTORS: Record<string, string> = {
  bank: "bank",
  financial: "financial",
  shopping: "shop",
  press: "news",
  social_networks: "social",
  gambling: "gaming_gambling",
  arjel: "gaming_gambling",
  games: "gaming_gambling",
  adult: "adult",
}
// Mailbox providers: never an organization, so a list of its own rather than a sector.
const UT1_FREE_MAIL = "webmail"
// `phishing` says it is no longer kept and only copies `malware`.
const UT1_BAD = ["malware", "cryptojacking"]

const FDIC_URL =
  "https://api.fdic.gov/banks/institutions?filters=ACTIVE:1&fields=CERT,NAME,WEBADDR&limit=10000&offset=0&format=json"

const HOST = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9])?$/

/** The registrable domain as `registrableOf` reads mail; none for an address on a shared host or an IP. */
const registrable = (host: string): string | undefined => {
  const icann = parse(host)
  if (icann.isIp || icann.domain === null) return undefined
  if (parse(host, { allowPrivateDomains: true }).domain !== icann.domain) return undefined
  return icann.domain.toLowerCase()
}

const linesOf = (path: string): string[] => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line !== "" && !line.startsWith("#"))
  } catch {
    return []
  }
}

const sources: PackSource[] = []

const publish = (source: Omit<PackSource, "url" | "sha256" | "bytes" | "count" | "tags">, lines: string[]) => {
  const unique = [...new Set(lines)].sort()
  const tags: Record<string, number> = {}
  for (const line of unique) {
    const tag = line.split("\t")[1] ?? source.tag ?? source.id
    tags[tag] = (tags[tag] ?? 0) + 1
  }
  const gzip = gzipSync(`${unique.join("\n")}\n`, { level: 9 })
  writeFileSync(join(OUT, `${source.id}.txt.gz`), gzip)
  sources.push({
    ...source,
    url: `${RELEASE}/${source.id}.txt.gz`,
    sha256: createHash("sha256").update(gzip).digest("hex"),
    bytes: gzip.length,
    count: unique.length,
    tags,
  })
  console.error(`${source.id}: ${unique.length} lines, ${gzip.length} bytes gzip, ${JSON.stringify(tags)}`)
}

mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), "domain-lists-"))
try {
  const fetchedAt = new Date().toISOString()
  const tarball = join(work, "ut1.tar.gz")
  const response = await fetch(UT1_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`UT1 answered ${response.status}`)
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
  const wanted = [...Object.keys(UT1_SECTORS), UT1_FREE_MAIL, ...UT1_BAD].map(
    (category) => `blacklists/${category}/domains`,
  )
  execFileSync("tar", ["-xzf", tarball, "-C", work, "--wildcards", ...wanted], { stdio: "inherit" })

  const sectorLines: string[] = []
  for (const [category, sector] of Object.entries(UT1_SECTORS))
    for (const line of linesOf(join(work, "blacklists", category, "domains")))
      if (getDomain(line) === line && registrable(line) === line) sectorLines.push(`${line}\t${sector}`)
  publish(
    { id: "ut1-sectors", title: "UT1 sector lists", signal: "sector", ...UT1, fetched_at: fetchedAt },
    sectorLines,
  )

  publish(
    { id: "ut1-webmail", title: "UT1 webmail providers", signal: "freemail", ...UT1, fetched_at: fetchedAt },
    linesOf(join(work, "blacklists", UT1_FREE_MAIL, "domains")).filter(
      (line) => getDomain(line) === line && registrable(line) === line,
    ),
  )

  const badLines: string[] = []
  for (const category of UT1_BAD)
    for (const line of linesOf(join(work, "blacklists", category, "domains")))
      if (HOST.test(line) && line.includes(".")) badLines.push(`${line}\t${category}`)
  publish(
    { id: "ut1-bad", title: "UT1 malware and cryptojacking hosts", signal: "bad", ...UT1, fetched_at: fetchedAt },
    badLines,
  )

  const fdic = await fetch(FDIC_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) })
  if (!fdic.ok) throw new Error(`FDIC answered ${fdic.status}`)
  const banks = (await fdic.json()) as { data: { data: { WEBADDR?: string | null } }[]; totals: { count: number } }
  if (banks.data.length < banks.totals.count) throw new Error("FDIC has more banks than one page: page through offset")
  const bankDomains = banks.data.flatMap(({ data }) => {
    const address = (data.WEBADDR ?? "").trim()
    if (address === "") return []
    const domain = registrable(/^https?:\/\//i.test(address) ? address : `https://${address}`)
    return domain === undefined ? [] : [domain]
  })
  publish(
    {
      id: "fdic-banks",
      title: "FDIC-insured US banks with a website",
      signal: "sector",
      tag: "bank",
      homepage: "https://api.fdic.gov/banks/docs/",
      licence: "US government data, no licence stated",
      licence_url: "https://www.fdic.gov/about/website-policies",
      class: "commercial-ok",
      attribution: "Federal Deposit Insurance Corporation, BankFind Suite (active institutions, WEBADDR).",
      fetched_at: fetchedAt,
    },
    bankDomains,
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

// Its terms forbid redistribution and allow only non-commercial use: each computer fetches it from the source.
sources.push({
  id: "sfs-toxic",
  title: "Stop Forum Spam toxic domains",
  signal: "bad",
  tag: "toxic",
  homepage: "https://www.stopforumspam.com/downloads",
  licence: "Stop Forum Spam terms: non-commercial, no redistribution",
  licence_url: "https://www.stopforumspam.com/legal",
  class: "non-commercial",
  attribution: "Stop Forum Spam (stopforumspam.com), fetched from the source by each computer.",
  url: "https://www.stopforumspam.com/downloads/toxic_domains_whole.txt",
  upstream: true,
  max_bytes: 20_000_000,
})

const manifest: PackManifest = { version: VERSION, built_at: new Date().toISOString(), sources }
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.error(`${OUT}/manifest.json: version ${VERSION}, ${sources.length} sources`)
