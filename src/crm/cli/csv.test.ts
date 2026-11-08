import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type ProgramDefinition, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, exampleOrganization, examplePerson, fakeCrmSource } from "../testing/index.js"
import { addCrmCommands, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const home = mkdtempSync(join(tmpdir(), "crm-csv-"))
const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CRM_CONFIG_DIR: join(home, "config") }

const source = fakeCrmSource()
source.setFields("deal", [
  { code: "UF_SOURCE", label: "Source", type: "enumeration", multiple: false, filterable: true },
  { code: "UF_BUDGET", label: "Budget", type: "money", multiple: false, filterable: false },
  { code: "UF_TAGS", label: "Tags", type: "string", multiple: true, filterable: false },
  { code: "UF_TAGS_OLD", label: "Tags", type: "string", multiple: false, filterable: false },
])
source.put("organization", exampleOrganization("c1", { name: 'Acme, "the" company' }))
source.put("person", examplePerson("p1"))
source.put(
  "deal",
  exampleDeal("d1", {
    title: '=HYPERLINK("http://example.com")',
    amount: "1500.00",
    currency: "EUR",
    organization: "c1",
    people: [{ externalId: "p1", role: "contact" }],
    metadata: {
      UF_SOURCE: { label: "Source", value: "Website", option_id: "1" },
      UF_BUDGET: { label: "Budget", value: "1500.50|USD" },
      UF_TAGS: { label: "Tags", value: ["vip", "+fair"] },
    },
  }),
)
source.put("deal", exampleDeal("d2", { title: "Line one\nline two" }))

let store: MessageStore

const definition: ProgramDefinition = {
  app: APP,
  configuration: settingsFor(APP),
  commands: () => {
    const root = new Command("crm")
    addCrmCommands(root, {
      app: APP,
      open: async (): Promise<CrmRun> => ({
        profile: "work",
        account: { provider: "example-crm", account: "portal" },
        store,
        source: () => source,
      }),
    })
    return [...root.commands]
  },
}

const crm = async (...args: string[]) => {
  const streams = captureStreams()
  const code = await run(["work", ...args], definition, { streams, tty: false, env })
  return { code, stdout: streams.stdout.map((text) => `${text}\n`).join(""), stderr: streams.stderr.join("\n") }
}

const rowsOf = (stdout: string) => stdout.split("\r\n")

beforeAll(async () => {
  store = await openStore({ path: join(home, "store.db") })
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  expect((await crm("sync", "--json")).code).toBe(0)
})

afterAll(async () => {
  await store.close()
})

describe("deals list --format csv", () => {
  it("prints only the table: every built-in column, then each CRM field by its label, money split in two", async () => {
    const { code, stdout } = await crm("deals", "list", "--format", "csv")

    expect(code).toBe(0)
    expect(stdout.endsWith("\r\n")).toBe(true)
    const [header, ...rest] = rowsOf(stdout)
    expect(header).toBe(
      "ref,title,status,pipeline,pipeline_name,stage,amount,currency,organization,people,close_date,closed_date," +
        "closed_reason,assignee,external_id,created_at,updated_at,Source,Budget amount,Budget currency," +
        "Tags (UF_TAGS),Tags (UF_TAGS_OLD)",
    )
    const first = rest.find((row) => row.includes("HYPERLINK")) ?? ""
    expect(first).toContain(`,"'=HYPERLINK(""http://example.com"")",open,`)
    expect(first).toContain(',1500.00,EUR,"Acme, ""the"" company",Example person p1,')
    expect(first).toMatch(/,Website,1500\.50,USD,vip; \+fair,$/)
    expect(stdout).toContain('"Line one\nline two"')
  })

  it("takes its columns from --json=a,b, a CRM field by its code", async () => {
    const { code, stdout } = await crm(
      "deals",
      "list",
      "--format",
      "csv",
      "--json=external_id,provider_metadata.UF_SOURCE",
    )

    expect(code).toBe(0)
    expect(rowsOf(stdout).sort()).toEqual(["", "d1,Website", "d2,", "external_id,Source"].sort())
  })

  it("says on stderr how to reach the next page, never on stdout", async () => {
    const { stdout, stderr } = await crm("deals", "list", "--format", "csv", "--limit", "1")

    expect(rowsOf(stdout)).toHaveLength(3)
    expect(stderr).toContain("--page 2")
  })

  it("refuses another output beside it, and a column the answer does not have", async () => {
    for (const other of ["--jsonl", "--json", "--compact"]) {
      const { code, stdout, stderr } = await crm("deals", "list", "--format", "csv", other)
      expect(code, other).not.toBe(0)
      expect(stdout, other).not.toContain("ref,title")
      expect(stderr, other).toMatch(/output\.conflict|ask for different output/)
    }
    const unknown = await crm("deals", "list", "--format", "csv", "--json=nonsense")
    expect(unknown.code).not.toBe(0)
    expect(unknown.stdout).toBe("")
  })
})
