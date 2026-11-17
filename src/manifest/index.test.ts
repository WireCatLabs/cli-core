import { describe, expect, it } from "vitest"
import { type CliConfig, defineCli, parseCliConfig } from "./index.js"

const config: CliConfig = {
  identity: {
    command: "acme",
    package: "@wirecat/acme-cli",
    prefix: "WCACME",
    service: "Acme",
    owner: "WireCatLabs",
  },
  spec: { kind: "openapi", from: "https://api.acme.test/openapi.json" },
  auth: { preset: "token" },
  category: "other",
}

describe("parseCliConfig", () => {
  it("takes a config as defineCli gives it", () => {
    expect(parseCliConfig(defineCli(config))).toEqual(config)
    const oauth = {
      ...config,
      auth: { preset: "oauth2-pkce" as const, scopes: ["record:read"] },
      hooks: "./src/hooks.ts",
    }
    expect(parseCliConfig(oauth)).toEqual(oauth)
  })

  it("names where a config is wrong", () => {
    expect(() => parseCliConfig({ ...config, identity: { ...config.identity, command: "Acme" } })).toThrow(
      "wirecat.config: identity.command: lower-case letters and digits, words joined by one dash",
    )
    expect(() => parseCliConfig({ ...config, auth: { preset: "oauth2-pkce" } })).toThrow("wirecat.config: auth.scopes")
    expect(() =>
      parseCliConfig({
        ...config,
        auth: { preset: "oauth2-pkce", scopes: [], redirect: { kind: "relay", url: "http://relay.test/" } },
      }),
    ).toThrow("auth.redirect")
    expect(() => parseCliConfig({ ...config, spec: { kind: "openapi", from: "http://api.acme.test/x" } })).toThrow(
      "spec.from",
    )
    expect(() => parseCliConfig({ ...config, category: "crm" })).toThrow("a crm CLI needs its source")
    for (const from of [
      "/etc/spec.json",
      "//evil.test/x",
      "../../spec.json",
      "https://",
      "file:spec.json",
      "spec/openapi.json",
    ])
      expect(() => parseCliConfig({ ...config, spec: { kind: "openapi", from } })).toThrow("spec.from")
    expect(() => parseCliConfig({ ...config, identity: { ...config.identity, command: "acme-" } })).toThrow(
      "identity.command",
    )
    expect(() => parseCliConfig({ ...config, identity: { ...config.identity, owner: "-owner" } })).toThrow(
      "identity.owner",
    )
    expect(() => parseCliConfig({ ...config, source: { provider: "acme" } })).toThrow("only a crm CLI")
    expect(() => parseCliConfig({ ...config, extra: true })).toThrow(
      "wirecat.config: extra: not a field of wirecat.config",
    )
  })

  it("takes each category, a crm CLI with its source, and a token's verify call", () => {
    for (const category of ["mail", "files", "other"] as const)
      expect(parseCliConfig({ ...config, category }).category).toBe(category)
    expect(() => parseCliConfig({ ...config, category: "tracker" })).toThrow("wirecat.config: category")
    const crm = { ...config, category: "crm" as const, source: { provider: "acme" } }
    expect(parseCliConfig(crm).source).toEqual({ provider: "acme" })
    const verify = { operation: "getV2Self", id: "workspace_id", name: "workspace_name" }
    expect(parseCliConfig({ ...config, auth: { preset: "token", verify } }).auth).toEqual({ preset: "token", verify })
    expect(() => parseCliConfig({ ...config, auth: { preset: "token", verify: { id: "id" } } })).toThrow(
      "wirecat.config: auth.verify.operation: missing",
    )
  })

  it("refuses a URL that would put a secret, a space or no host into the CLI's files", () => {
    for (const [from, why] of [
      ["https://user:pass@api.acme.test/o.json", "without a user name or password"],
      ["https://api.acme.test/o.json?api_key=x", "without a key or token in its query"],
      ["https://api.acme.test/a b.json", "without spaces"],
      ["https://@", "with a host"],
      ["https://api.acme.test:99999/x", "with a host"],
    ])
      expect(() => parseCliConfig({ ...config, spec: { kind: "openapi", from } }), from).toThrow(
        `spec.from: an https URL ${why}`,
      )
    expect(
      parseCliConfig({ ...config, spec: { kind: "openapi", from: "https://api.acme.test/o.json?v=2" } }),
    ).toBeTruthy()
    const oauth = (extra: object) => ({ ...config, auth: { preset: "oauth2-pkce", scopes: [], ...extra } })
    expect(() => parseCliConfig(oauth({ revokeUrl: "https://" }))).toThrow("auth.revokeUrl")
    expect(() => parseCliConfig(oauth({ redirect: { kind: "relay", url: "https://u:p@r.test/" } }))).toThrow(
      "auth.redirect.url",
    )
  })

  it("refuses an old field and names a missing one", () => {
    expect(() => parseCliConfig({ ...config, identity: { ...config.identity, provider: "acme" } })).toThrow(
      "wirecat.config: identity.provider: not a field of wirecat.config",
    )
    const { spec: _, ...noSpec } = config
    expect(() => parseCliConfig(noSpec)).toThrow("wirecat.config: spec: missing")
  })

  it("takes the hooks module only as a script in the project", () => {
    for (const hooks of ["./", "./src/hooks.json", "./src/hooks.ts ", "./a/../../x.ts", "src/hooks.ts"])
      expect(() => parseCliConfig({ ...config, hooks }), hooks).toThrow("wirecat.config: hooks")
    expect(parseCliConfig({ ...config, hooks: "./src/hooks.js" }).hooks).toBe("./src/hooks.js")
  })
})
