import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Credentials, keyringService } from "./credentials.js"
import { CliError } from "./errors.js"
import { brokenKeyring, memoryKeyring } from "./keyring.js"

const dir = () => mkdtempSync(join(tmpdir(), "cli-core-creds-"))
const make = (options: Partial<ConstructorParameters<typeof Credentials>[0]> = {}) =>
  new Credentials({
    configDir: dir(),
    service: "max-cli",
    keyring: memoryKeyring(),
    env: {},
    warn: () => {},
    ...options,
  })

describe("Credentials", () => {
  it("prefers the environment over everything else", () => {
    const keyring = memoryKeyring()
    const credentials = make({ keyring, envVar: "MAX_TOKEN", env: { MAX_TOKEN: "from-env" } })
    keyring.set("max-cli", "default", "from-keyring")

    expect(credentials.read("default")).toEqual({ secret: "from-env", source: "environment" })
  })

  it("writes to the keyring and reads it back", () => {
    const credentials = make()
    expect(credentials.write("default", "s3cret")).toBe("keyring")
    expect(credentials.read("default")).toEqual({ secret: "s3cret", source: "keyring" })
  })

  it("falls back to a file when the keyring refuses, and warns exactly once", () => {
    const warnings: string[] = []
    const configDir = dir()
    const credentials = new Credentials({
      configDir,
      service: "max-cli",
      keyring: brokenKeyring(),
      env: {},
      warn: (message) => warnings.push(message),
    })

    expect(credentials.write("default", "s3cret")).toBe("file")
    expect(credentials.read("default")).toEqual({ secret: "s3cret", source: "file" })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/keyring is unavailable/)
  })

  it("writes the fallback file with owner-only permissions", () => {
    const configDir = dir()
    new Credentials({ configDir, service: "max-cli", storage: "file", env: {}, warn: () => {} }).write("default", "s")
    expect(statSync(join(configDir, "credentials.json")).mode & 0o777).toBe(0o600)
  })

  it("lets a keyring failure through when the caller demanded the keyring", () => {
    const credentials = make({ keyring: brokenKeyring(), storage: "keyring" })
    expect(() => credentials.write("default", "s")).toThrow(/no secret service/)
  })

  it("removes from both places and says which ones held something", () => {
    const configDir = dir()
    const keyring = memoryKeyring()
    const credentials = new Credentials({ configDir, service: "max-cli", keyring, env: {}, warn: () => {} })
    credentials.write("default", "in-keyring")

    expect(credentials.remove("default")).toEqual(["keyring"])
    expect(credentials.read("default")).toBeUndefined()
  })

  it("keeps two accounts apart", () => {
    const credentials = make()
    credentials.write("default", "one")
    credentials.write("personal", "two")
    expect(credentials.read("personal")?.secret).toBe("two")
  })

  it("never writes the secret anywhere the file store does not name", () => {
    const configDir = dir()
    new Credentials({ configDir, service: "max-cli", storage: "file", env: {}, warn: () => {} }).write(
      "default",
      "s3cret",
    )
    const written = readFileSync(join(configDir, "credentials.json"), "utf8")
    expect(JSON.parse(written)).toEqual({ default: { secret: "s3cret" } })
  })
})

describe("a credentials file that cannot be parsed", () => {
  const broken = '{"other":{"secret":"keep-me"'

  for (const content of [broken, "null", "[]"]) {
    it(`refuses to write over ${JSON.stringify(content)} and leaves it as it was`, () => {
      const configDir = dir()
      const path = join(configDir, "credentials.json")
      writeFileSync(path, content)
      const credentials = make({ configDir, keyring: brokenKeyring() })

      const error = (() => {
        try {
          credentials.write("default", "s3cret")
        } catch (caught) {
          return caught
        }
      })()
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).code).toBe("configuration_error")
      expect((error as CliError).message).toContain(path)
      expect((error as CliError).message).not.toContain("keep-me")
      expect(readFileSync(path, "utf8")).toBe(content)
      expect(credentials.read("default")).toBeUndefined()
    })
  }

  it("removes nothing from it", () => {
    const configDir = dir()
    writeFileSync(join(configDir, "credentials.json"), broken)
    expect(make({ configDir, storage: "file" }).remove("other")).toEqual([])
    expect(readFileSync(join(configDir, "credentials.json"), "utf8")).toBe(broken)
  })
})

describe("keyringService", () => {
  it("scopes the service name to a throwaway config directory", () => {
    expect(keyringService("max-cli", "/tmp/x", true)).toBe("max-cli:/tmp/x")
    expect(keyringService("max-cli", "/home/me/.config/max-cli", false)).toBe("max-cli")
  })

  it("keeps two throwaway directories from colliding with each other", () => {
    expect(keyringService("max-cli", "/tmp/a", true)).not.toBe(keyringService("max-cli", "/tmp/b", true))
  })
})
