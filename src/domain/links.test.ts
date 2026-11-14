import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_LINK_CONFIG,
  type DeepLinkTarget,
  formatLink,
  linkConfigOf,
  linkFor,
  linkTargetOf,
  parseLink,
  refsForLink,
} from "./links.js"

interface Fixture {
  valid: { ref: string; path: string; web: string; app: string; target: DeepLinkTarget }[]
  /** Kinds a link is built for only from its target: no ref names them. */
  target_only: { path: string; web: string; app: string; target: DeepLinkTarget }[]
  refused: { path: string; why: string }[]
  ignored_query: { path: string; target: DeepLinkTarget }[]
}

const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/links-v1.json", import.meta.url), "utf8"),
) as Fixture
const env = {}

describe("the v1 link grammar, as the shared fixture states it", () => {
  it.each(fixture.valid.map((one) => [one.ref, one] as const))("round-trips %s", (_, one) => {
    expect(linkTargetOf(one.ref)).toEqual(one.target)
    expect(formatLink(one.target)).toBe(one.path)
    expect(linkFor(one.ref, { form: "web", env })).toBe(one.web)
    expect(linkFor(one.ref, { form: "app", env })).toBe(one.app)
    for (const text of [one.path, one.web, one.app]) expect(parseLink(text)).toEqual(one.target)
  })

  it.each(fixture.target_only.map((one) => [one.path, one] as const))(
    "builds and reads %s from its target",
    (_, one) => {
      expect(formatLink(one.target)).toBe(one.path)
      expect(linkFor(one.target, { form: "web", env })).toBe(one.web)
      expect(linkFor(one.target, { form: "app", env })).toBe(one.app)
      for (const text of [one.path, one.web, one.app]) expect(parseLink(text)).toEqual(one.target)
    },
  )

  it("**never reads a store's meeting reference as a meeting link**: it names store rows, not the provider's ids", () => {
    for (const ref of ["meeting:3/12", "meeting:3/12/4", "meeting:asterisk/office/1731571200.42"])
      expect(linkTargetOf(ref)).toBeNull()
  })

  it.each(fixture.refused.map((one) => [one.why, one.path] as const))("refuses %s", (_, path) => {
    expect(parseLink(path)).toBeNull()
    if (path.startsWith("/")) {
      expect(parseLink(`https://wirecat.dev/o#${path}`)).toBeNull()
      expect(parseLink(`wirecat://open${path}`)).toBeNull()
    }
  })

  it("ignores a query a later version may add", () => {
    for (const one of fixture.ignored_query) expect(parseLink(one.path)).toEqual(one.target)
  })

  it("keeps @, /, :, spaces and negative ids inside one segment", () => {
    const target: DeepLinkTarget = {
      type: "message",
      provider: "email",
      account: "a@b.c",
      chat: "x/y: z",
      message: "-5",
    }
    expect(formatLink(target)).toBe("/v1/msg/email/a%40b.c/x%2Fy%3A%20z/-5")
    expect(parseLink(formatLink(target))).toEqual(target)
  })
})

describe("linkFor", () => {
  it("leaves out what no link opens: an organization, an unknown ref, a target the parser would refuse", () => {
    expect(linkFor("organization:78", { form: "web", env })).toBeNull()
    expect(linkFor("account:max/1", { form: "web", env })).toBeNull()
    expect(linkFor({ type: "digest", date: "08.11.2026" }, { form: "web", env })).toBeNull()
    expect(linkFor({ type: "task", id: "1".repeat(600) }, { form: "web", env })).toBeNull()
  })

  it("is off with links.enabled false, or with WIRECAT_LINKS=off for one run", () => {
    expect(linkFor("task:80", { form: "web", config: { ...DEFAULT_LINK_CONFIG, enabled: false }, env })).toBeNull()
    expect(linkFor("task:80", { form: "app", env: { WIRECAT_LINKS: "off" } })).toBeNull()
  })

  it("puts the path after the configured base's #", () => {
    const config = linkConfigOf({ base: "https://links.example/open/" })
    expect(linkFor("task:80", { form: "web", config, env })).toBe("https://links.example/open#/v1/task/80")
    expect(linkConfigOf({ base: "http://plain.example", enabled: "no" })).toEqual(DEFAULT_LINK_CONFIG)
  })
})

describe("refsForLink", () => {
  it("puts person and project refs after the refs that say where an item happened", () => {
    expect(refsForLink(["person:77", "project:ACME", "msg:max/1/2/3", "task:80"])).toEqual([
      "msg:max/1/2/3",
      "task:80",
      "person:77",
      "project:ACME",
    ])
  })
})
