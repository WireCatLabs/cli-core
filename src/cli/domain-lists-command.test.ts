import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it } from "vitest"
import { PACK_MANIFEST_URL } from "../domain/domain-lists.js"
import { domainList } from "../entities/domain-list.js"
import { domainListsCommand } from "./domain-lists-command.js"
import type { Body } from "./envelope.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }

const fixture = (offline = false) => {
  const home = mkdtempSync(join(tmpdir(), "domain-lists-"))
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") }
  const gzip = gzipSync("bank.example\tbank\n")
  const served: Record<string, Buffer | string> = {
    [PACK_MANIFEST_URL]: JSON.stringify({
      version: "2026-11-25",
      built_at: "2026-11-25T00:00:00.000Z",
      sources: [
        {
          id: "ut1-sectors",
          title: "UT1 sector lists",
          signal: "sector",
          licence: "CC BY-SA 4.0",
          licence_url: "https://creativecommons.org/licenses/by-sa/4.0/",
          class: "commercial-ok",
          attribution: "UT1",
          homepage: "https://dsi.ut-capitole.fr/blacklists/index_en.php",
          url: "https://example.org/ut1-sectors.txt.gz",
          sha256: createHash("sha256").update(gzip).digest("hex"),
          bytes: gzip.length,
          count: 1,
          tags: { bank: 1 },
        },
      ],
    }),
    "https://example.org/ut1-sectors.txt.gz": gzip,
  }
  const answers: Body[] = []
  const lists = domainListsCommand(app, {
    env: () => env,
    output: (body) => answers.push(body),
    diagnostic: () => {},
    offline: () => offline,
    fetch: async (url) => new Response(served[url] ?? null, { status: served[url] === undefined ? 404 : 200 }),
  })
  return { root: new Command("fixture").addCommand(lists), answers }
}

const itemsOf = (body: Body | undefined) => (body && "items" in body ? body.items : [])

it("updates the pack and lists each source with its licence class in the shared schema", async () => {
  const { root, answers } = fixture()

  await root.parseAsync(["domain-lists", "list"], { from: "user" })
  await root.parseAsync(["domain-lists", "update"], { from: "user" })
  await root.parseAsync(["domain-lists", "list"], { from: "user" })

  expect(itemsOf(answers[0])).toEqual([])
  const listed = itemsOf(answers[2])
  expect(listed).toMatchObject([{ id: "ut1-sectors", class: "commercial-ok", lines: 1, version: "2026-11-25" }])
  for (const item of [...itemsOf(answers[1]), ...listed]) expect(v.safeParse(domainList, item).success).toBe(true)
})

it("refuses an update in offline mode before any network work", async () => {
  const { root } = fixture(true)
  await expect(root.parseAsync(["domain-lists", "update"], { from: "user" })).rejects.toThrow("--offline")
})
