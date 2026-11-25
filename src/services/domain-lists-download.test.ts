import { createHash } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { afterEach, expect, it } from "vitest"
import { domainListsDirectory, installedPack, listFile, lookupDomains } from "../domain/domain-lists.js"
import { updateDomainLists } from "./domain-lists-download.js"

const MANIFEST = "https://example.org/manifest.json"

afterEach(() => rmSync(domainListsDirectory(), { recursive: true, force: true }))

const packOf = (version: string, sectorLines: string, { tamper = false } = {}) => {
  const gzip = gzipSync(sectorLines)
  const served: Record<string, Buffer | string> = {
    "https://example.org/sectors.txt.gz": tamper ? gzipSync("evil.example\tbank\n") : gzip,
    "https://upstream.example/toxic.txt": "# comment\nSpam.Example\nnot a domain\nspam.example\n",
  }
  served[MANIFEST] = JSON.stringify({
    version,
    built_at: `${version}T00:00:00.000Z`,
    sources: [
      {
        id: "sectors",
        title: "Sectors",
        signal: "sector",
        licence: "CC BY-SA 4.0",
        licence_url: "https://creativecommons.org/licenses/by-sa/4.0/",
        class: "commercial-ok",
        attribution: "test",
        homepage: "https://example.org",
        url: "https://example.org/sectors.txt.gz",
        sha256: createHash("sha256").update(gzip).digest("hex"),
        bytes: gzip.length,
        count: sectorLines.split("\n").filter(Boolean).length,
      },
      {
        id: "toxic",
        title: "Toxic",
        signal: "bad",
        tag: "toxic",
        licence: "non-commercial",
        licence_url: "https://upstream.example/legal",
        class: "non-commercial",
        attribution: "test",
        homepage: "https://upstream.example",
        url: "https://upstream.example/toxic.txt",
        upstream: true,
        max_bytes: 1000,
      },
    ],
  })
  const asked: string[] = []
  const fetch = async (url: string) => {
    asked.push(url)
    const body = served[url]
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body)
  }
  return { fetch, asked }
}

it("installs every list checked by sha256, fetches an upstream list from its source, and matches only exact hosts", async () => {
  const { fetch } = packOf("2026-11-25", "bank.example\tbank\ncasino.example\tgaming_gambling\n")

  const done = await updateDomainLists({ env: process.env, fetch, manifestUrl: MANIFEST })

  expect(done).toMatchObject({ updated: true, previous: null })
  expect(installedPack()?.files.toxic?.lines).toBe(1)
  const hits = lookupDomains(new Set(["bank.example", "spam.example", "mail.bank.example"]))
  expect(Object.fromEntries(hits.sectors)).toEqual({ "bank.example": ["bank"] })
  expect(Object.fromEntries(hits.bad)).toEqual({ "spam.example": ["toxic:toxic"] })
  expect(lookupDomains(new Set(["spam.example"]), { commercialOnly: true }).bad.size).toBe(0)
})

it("downloads nothing when the newest pack is already here, and drops non-commercial lists on request", async () => {
  const { fetch, asked } = packOf("2026-11-25", "bank.example\tbank\n")
  await updateDomainLists({ env: process.env, fetch, manifestUrl: MANIFEST })
  asked.length = 0

  expect(await updateDomainLists({ env: process.env, fetch, manifestUrl: MANIFEST })).toMatchObject({ updated: false })
  expect(asked).toEqual([MANIFEST])

  await updateDomainLists({ env: process.env, fetch, manifestUrl: MANIFEST, commercialOnly: true })
  expect(Object.keys(installedPack()?.files ?? {})).toEqual(["sectors"])
  expect(existsSync(listFile(domainListsDirectory(), "toxic"))).toBe(false)
})

it("keeps the pack it had when a file is not the one the manifest names", async () => {
  await updateDomainLists({
    env: process.env,
    fetch: packOf("2026-11-24", "bank.example\tbank\n").fetch,
    manifestUrl: MANIFEST,
  })

  await expect(
    updateDomainLists({
      env: process.env,
      fetch: packOf("2026-11-25", "other.example\tbank\n", { tamper: true }).fetch,
      manifestUrl: MANIFEST,
    }),
  ).rejects.toThrow(/nothing was installed/)

  expect(installedPack()?.version).toBe("2026-11-24")
  expect(lookupDomains(new Set(["bank.example"])).sectors.get("bank.example")).toEqual(["bank"])
})

it("refuses a manifest whose source id would write outside the pack", async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({
        version: "1",
        sources: [{ id: "../x", url: "https://e.org", signal: "bad", class: "commercial-ok", sha256: "0", bytes: 1 }],
      }),
    )
  await expect(updateDomainLists({ env: process.env, fetch, manifestUrl: MANIFEST })).rejects.toThrow(/source id/)
})
