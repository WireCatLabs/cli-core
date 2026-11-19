import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import { hostFetch } from "@wirecat/cli-base/http"
import { describe, expect, it } from "vitest"
import { appMcpCommand } from "./app-mcp-command.js"
import { generatedApiCommand } from "./bot/api.js"
import { configCommand } from "./config-command.js"
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
      configCommand(app, configuration),
      appMcpCommand(app, configuration, { name: "CRM", untrusted: ["contact names"], permissionExample: "api=deny" }),
    ],
  }
  const cli = async (...args: string[]) => {
    const streams = captureStreams()
    const stdin = new PassThrough()
    stdin.end()
    const code = await run(args, definition, { streams, env, tty: false, stdin, stdout: new PassThrough() })
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

  it("refuses an old flat key and names the key to rename it to, whatever its level", async () => {
    for (const level of ["deny", "allow"]) {
      const old = fixture({ "api.contacts-list": level })
      const refused = await old.cli("work", "api", "pages", "list", "--json")
      expect(refused.error).toMatchObject({ code: "configuration_error" })
      expect(refused.error?.message).toContain("rename it to permissions.api.contacts.list")
      expect(old.sent).toEqual([])
    }
    const served = await fixture({ "api.contacts-list": "deny" }).cli("work", "mcp", "serve")
    expect(served.code).not.toBe(0)
    expect(served.err).toContain("rename it to permissions.api.contacts.list")
    const flagged = await fixture().cli("work", "mcp", "serve", "--permission", "api.contacts-list=deny")
    expect(flagged.code).not.toBe(0)
    expect(flagged.err).toContain("its command moved, so use api.contacts.list")
    const set = await fixture().cli("work", "config", "set", "permissions.api.contacts-list", "deny")
    expect(set.error?.message).toContain("its command moved, so use permissions.api.contacts.list")
  })

  it("puts the new key on a delete's default and in --dry-run, and the old key nowhere", () => {
    const permissions = serviceApiPermissions({ manifest })
    expect(permissions.defaults["api.contacts.delete"]).toBe("ask")
    expect(permissions.defaults["api.contacts-delete"]).toBeUndefined()
    expect(permissions.extra).not.toContain("api.contacts-list")
    expect(permissions.alsoChecks(["api", "contacts", "delete"])).toEqual(["records.delete"])
    expect(permissions.alsoChecks(["api", "status"])).toEqual([])
  })

  it("refuses a group and an operation of one name", () => {
    const clash = [operation("contacts", "GET", "/contacts"), ...operations]
    expect(() =>
      generatedApiCommand({ operations: clash, checkParameter: () => undefined, execute: async () => {} }),
    ).toThrow("api contacts is both a group and an operation")
  })
})
