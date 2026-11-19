import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import { hostFetch } from "@wirecat/cli-base/http"
import { describe, expect, it } from "vitest"
import { generatedApiCommand } from "./bot/api.js"
import { commandPermissions } from "./permission-keys.js"
import { run } from "./program.js"
import { serviceApiPermissions } from "./service-api.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { settingsFor } from "./settings.js"
import { serviceApiCommand } from "./shared-command-exports.js"

const app = {
  command: "crm",
  appName: "crm-cli",
  envPrefix: "CRM",
  description: "a CRM",
  version: "1.0.0",
  messenger: false,
}

type Operation = ManifestOperation & { group?: string }

const operation = (command: string, method: "GET" | "POST" | "DELETE", path: string, group?: string): Operation => ({
  id: command,
  command,
  ...(group ? { group } : {}),
  binding: { kind: "http", method, path },
  effect: method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write",
  tags: [],
  parameters: [],
  ...(method === "DELETE" ? { permissions: [{ key: "records.delete" }] } : {}),
})

const operations: Operation[] = [
  operation("contacts-list", "GET", "/contacts", "contacts"),
  operation("contacts-create", "POST", "/contacts", "contacts"),
  operation("contacts-delete", "DELETE", "/contacts/1", "contacts"),
  operation("move-page", "POST", "/pages/move", "pages"),
  operation("pages-list", "GET", "/pages", "pages"),
  operation("status", "GET", "/status"),
]

const manifest: ServiceApiManifest = { operations, servers: [{ url: "https://api.crm.test" }] }

const fixture = (saved: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "service-api-groups-"))
  const env = {
    CRM_CONFIG_DIR: join(root, "config"),
    CRM_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "w.db"),
  }
  mkdirSync(env.CRM_CONFIG_DIR, { recursive: true })
  writeFileSync(join(env.CRM_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { work: { permissions: saved } } }))
  const sent: string[] = []
  const configuration = settingsFor(app, { permissions: commandPermissions(serviceApiPermissions({ manifest })) })
  const definition = {
    app,
    configuration,
    commands: () => [
      serviceApiCommand({
        manifest,
        app,
        configuration,
        service: "CRM",
        fetch: () =>
          hostFetch({
            hosts: ["api.crm.test"],
            fetch: async (input, init) => {
              sent.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`)
              return Response.json({ ok: true })
            },
          }),
        schemas: async () => ({}),
        definitions: async () => ({}),
      }),
    ],
  }
  const cli = async (...args: string[]) => {
    const streams = captureStreams()
    const code = await run(args, definition, { streams, env, tty: false })
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out.startsWith("{") ? JSON.parse(out) : undefined,
      // A warning may come first on stderr.
      error: err.includes('{"error"')
        ? (JSON.parse(err.slice(err.indexOf('{"error"'))).error as { code: string; message: string })
        : undefined,
      err,
    }
  }
  return { cli, sent }
}

describe("api subgroups", () => {
  it("mounts a grouped operation as api <group> <command> and keeps the rest flat; the old path is gone", async () => {
    const { cli, sent } = fixture()
    expect((await cli("work", "api", "contacts", "list", "--json")).code).toBe(0)
    expect((await cli("work", "api", "pages", "move-page", "--json")).code).toBe(0)
    expect((await cli("work", "api", "status", "--json")).code).toBe(0)
    expect(sent).toEqual(["GET /contacts", "POST /pages/move", "GET /status"])
    expect((await cli("work", "api", "contacts-list", "--json")).code).not.toBe(0)
    expect(sent).toHaveLength(3)
  })

  it("lists the path and the group, and shows an operation by its path, its old name or its id", async () => {
    const { cli } = fixture()
    const { json } = await cli("work", "api", "list", "--json")
    expect(json.items.map((one: { command: string; group: string | null }) => [one.command, one.group])).toEqual([
      ["contacts list", "contacts"],
      ["contacts create", "contacts"],
      ["contacts delete", "contacts"],
      ["pages move-page", "pages"],
      ["pages list", "pages"],
      ["status", null],
    ])
    for (const name of ["contacts list", "contacts-list"])
      expect((await cli("work", "api", "show", name, "--json")).json.item.operation.id).toBe("contacts-list")
  })

  it("checks the path as the key, so one key covers a whole group", async () => {
    const { cli, sent } = fixture({ "api.contacts": "deny" })
    expect((await cli("work", "api", "contacts", "list", "--json")).error).toMatchObject({ code: "permission_error" })
    expect((await cli("work", "api", "contacts", "create", "--json")).error).toMatchObject({
      code: "permission_error",
    })
    expect((await cli("work", "api", "pages", "list", "--json")).code).toBe(0)
    expect(sent).toEqual(["GET /pages"])
  })

  it("keeps an old flat key as an alias that only tightens, and says to rename it", async () => {
    const denied = fixture({ "api.contacts-list": "deny" })
    const refused = await denied.cli("work", "api", "contacts", "list", "--json")
    expect(refused.error).toMatchObject({ code: "permission_error" })
    expect(refused.err).toContain("rename it to api.contacts.list")
    expect(denied.sent).toEqual([])

    const loose = fixture({ "api.contacts": "deny", "api.contacts-list": "allow" })
    expect((await loose.cli("work", "api", "contacts", "list", "--json")).error).toMatchObject({
      code: "permission_error",
    })
    expect(loose.sent).toEqual([])

    const readonly = fixture({ "api.contacts-list": "readonly", "api.contacts-create": "readonly" })
    expect((await readonly.cli("work", "api", "contacts", "list", "--json")).code).toBe(0)
    expect((await readonly.cli("work", "api", "contacts", "create", "--json")).error).toMatchObject({
      code: "permission_error",
    })
    expect(readonly.sent).toEqual(["GET /contacts"])
  })

  it("puts the new key on a delete's default and shows the old key in --dry-run", () => {
    const permissions = serviceApiPermissions({ manifest })
    expect(permissions.defaults["api.contacts.delete"]).toBe("ask")
    expect(permissions.defaults["api.contacts-delete"]).toBeUndefined()
    expect(permissions.extra).toContain("api.contacts-list")
    expect(permissions.alsoChecks(["api", "contacts", "delete"])).toEqual([
      "records.delete",
      { key: "api.contacts-delete", when: "while a profile still names this old key" },
    ])
    expect(permissions.alsoChecks(["api", "status"])).toEqual([])
  })

  it("refuses a group and an operation of one name", () => {
    const clash = [operation("contacts", "GET", "/contacts"), ...operations]
    expect(() =>
      generatedApiCommand({ operations: clash, checkParameter: () => undefined, execute: async () => {} }),
    ).toThrow("api contacts is both a group and an operation")
  })
})
