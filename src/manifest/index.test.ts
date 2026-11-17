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
    expect(() => parseCliConfig({ ...config, extra: true })).toThrow("wirecat.config")
  })
})
