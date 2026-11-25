// Writes src/domain/organization-sectors.generated.ts: registrable domain → sector, from the official websites (P856)
// of Wikidata items (CC0). Run at release, never at run time: a lookup per sender would tell a third party who writes
// to the owner. The query sends only class ids.
// Run: node --experimental-strip-types scripts/organization-sectors.ts && pnpm exec biome check --write src/domain/organization-sectors.generated.ts
import { writeFileSync } from "node:fs"
import { parse } from "tldts"

const ENDPOINT = "https://query.wikidata.org/sparql"
const OUT = new URL("../src/domain/organization-sectors.generated.ts", import.meta.url)
const USER_AGENT = "WireCat-build/1.0 (https://github.com/WireCatLabs/cli-core)"

// Most specific first: a domain several sectors claim takes the first. `tree`: the class with its subclasses;
// `direct`: its own instances only, since government agency's subclasses take in about 50,000 towns. `notable`: the
// fewest Wikipedia and sister-site pages an item needs, which keeps the long tail of local papers and agencies out of
// the package (all three together were about 90,000 domains, 1.6 MB, on 2026-11-25).
const CLASSES: Record<string, { tree: string[]; direct?: string[]; notable?: number }> = {
  airline: { tree: ["Q46970"] },
  bank: { tree: ["Q22687"] },
  financial: { tree: ["Q2143354", "Q1956140", "Q25401607", "Q11691", "Q650241"] },
  telecom: { tree: ["Q2401749", "Q1941618", "Q11371"] },
  social: { tree: ["Q3220391"] },
  shop: { tree: ["Q4382945", "Q3390477", "Q507619", "Q18043413", "Q216107"], notable: 2 },
  delivery: { tree: ["Q1529128"] },
  news: { tree: ["Q1193236", "Q11032", "Q192283", "Q17232649", "Q1153191", "Q15265344", "Q2001305"], notable: 3 },
  government: { tree: ["Q192350", "Q573607"], direct: ["Q327333"], notable: 2 },
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class TooBig extends Error {}

interface Row {
  item: string
  url: string
  links: number
}

const sparql = async (query: string): Promise<Record<string, { value: string }>[]> => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query }),
      signal: AbortSignal.timeout(90_000),
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") throw new TooBig()
      throw error
    })
    if (response.status === 429 && attempt < 6) {
      await sleep(Number(response.headers.get("retry-after") ?? 60) * 1000)
      continue
    }
    const text = await response.text()
    // The service cuts a query at 60 s; it answers 500 with a Java TimeoutException, or a broken JSON body.
    if (response.status === 500 && text.includes("TimeoutException")) throw new TooBig()
    // A gateway error is a query the proxy gave up on, or a busy server: try again, then split.
    if ([502, 503, 504].includes(response.status)) {
      if (attempt >= 3) throw new TooBig()
      await sleep(10_000 * attempt)
      continue
    }
    if (!response.ok) throw new Error(`Wikidata answered ${response.status}`)
    try {
      return (JSON.parse(text) as { results: { bindings: Record<string, { value: string }>[] } }).results.bindings
    } catch {
      throw new TooBig()
    }
  }
}

// The best-ranked website (preferred if any, else normal), no end date, of an item not dissolved. Only preferred
// statements would keep 227 of about 3,800 banks (2026-11-25).
const websites = (match: string, notable: number) =>
  `SELECT ?item ?url ?links WHERE { ${match} ?item wikibase:sitelinks ?links . FILTER(?links >= ${notable}) ` +
  "?item p:P856 ?st . ?st ps:P856 ?url ; a wikibase:BestRank . " +
  "FILTER NOT EXISTS { ?st pq:P582 [] } FILTER NOT EXISTS { ?item wdt:P576 [] } }"

const subclassesOf = async (id: string) =>
  (await sparql(`SELECT ?sub WHERE { ?sub wdt:P279 wd:${id} }`)).map(
    (row) => (row.sub?.value ?? "").split("/").pop() ?? "",
  )

const rowOf = (row: Record<string, { value: string }>): Row => ({
  item: row.item?.value ?? "",
  url: row.url?.value ?? "",
  links: Number(row.links?.value ?? 0),
})

const seen = new Set<string>()
/** Instances of `id` and its subclasses; a query too big for the 60 s limit is split into each direct subclass. */
const instancesOf = async (id: string, notable: number): Promise<Row[]> => {
  if (seen.has(id)) return []
  await sleep(1000)
  try {
    const rows = await sparql(websites(`?item wdt:P31/wdt:P279* wd:${id} .`, notable))
    seen.add(id)
    return rows.map(rowOf)
  } catch (error) {
    if (!(error instanceof TooBig)) throw error
    console.error(`${id}: too big, split by subclass`)
    seen.add(id)
    const direct = await sparql(websites(`?item wdt:P31 wd:${id} .`, notable))
    const found = direct.map(rowOf)
    for (const sub of await subclassesOf(id)) found.push(...(await instancesOf(sub, notable)))
    return found
  }
}

// A home page, or one in a language folder (`/en`, `/es-es/`), on the domain itself or `www`. A deeper path is a page
// on someone else's site: a bank's Facebook page would make facebook.com a bank.
const HOME = /^\/?([a-z]{2}([-_][a-z]{2})?\/?)?(index\.html?)?$/iu

/** The registrable domain as `registrableOf` reads mail (ICANN suffixes only); none under a shared host. */
const domainOf = (url: string): string | undefined => {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return undefined
  }
  if (!HOME.test(path)) return undefined
  const icann = parse(url)
  if (icann.isIp || icann.domain === null) return undefined
  // tv.youtube.com, apps.microsoft.com, a blog on wordpress.com: a product or a tenant of a bigger site, not its owner.
  if (icann.subdomain !== "" && icann.subdomain !== "www") return undefined
  // blogspot.com, github.io, …: the private part of the Public Suffix List; the domain is the host's, not the owner's.
  if (parse(url, { allowPrivateDomains: true }).domain !== icann.domain) return undefined
  return icann.domain.toLowerCase()
}

const claims = new Map<string, Set<string>>()
const counts: Record<string, number> = {}
for (const [sector, { tree, direct = [], notable = 0 }] of Object.entries(CLASSES)) {
  seen.clear()
  const rows: Row[] = []
  for (const id of tree) rows.push(...(await instancesOf(id, notable)))
  for (const id of direct) {
    await sleep(1000)
    rows.push(...(await sparql(websites(`?item wdt:P31 wd:${id} .`, notable))).map(rowOf))
  }
  const items = new Set(rows.map(({ item }) => item))
  for (const { url } of rows) {
    const domain = domainOf(url)
    if (domain !== undefined) claims.set(domain, (claims.get(domain) ?? new Set()).add(sector))
  }
  counts[sector] = items.size
  console.error(`${sector}: ${items.size} items`)
}

const order = Object.keys(CLASSES)
const table = new Map(order.map((sector) => [sector, [] as string[]]))
for (const [domain, sectors] of claims) {
  // Three sectors on one domain is a group or a host, not a sector.
  if (sectors.size >= 3) continue
  const sector = order.find((one) => sectors.has(one))
  if (sector !== undefined) table.get(sector)?.push(domain)
}

const date = new Date().toISOString().slice(0, 10)
writeFileSync(
  OUT,
  `// Generated by scripts/organization-sectors.ts from Wikidata on ${date}; do not edit by hand.\n` +
    "// Wikidata data is CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/): official websites (P856).\n" +
    "// Each value is the registrable domains of that sector, sorted, one space between.\n" +
    "export const SECTOR_DOMAINS = {\n" +
    [...table].map(([sector, domains]) => `  ${sector}: "${domains.sort().join(" ")}",\n`).join("") +
    "} as const\n",
)
for (const [sector, domains] of table)
  console.error(`${sector}: ${domains.length} domains from ${counts[sector]} items`)
