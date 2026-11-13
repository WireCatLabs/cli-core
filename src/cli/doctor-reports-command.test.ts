import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { RunMetadata } from "../runs/run.js"
import { issuesPage, issueUrlFor } from "./doctor-reports-command.js"

const app = {
  command: "cal",
  appName: "cal-cli",
  envPrefix: "CAL",
  description: "calendar",
  version: "1.2.3",
  issues: "https://github.com/example/cal-cli/issues/new",
}

it("fills a new issue with the version, the platform and the run's codes, and nothing private", () => {
  const run = {
    runId: "r-1",
    command: "events list",
    profile: "work",
    errorCode: "provider_error",
    providerError: "quota.exceeded",
  } as unknown as RunMetadata

  const url = new URL(issueUrlFor(app, run, "linux", "x64"))

  expect(`${url.origin}${url.pathname}`).toBe(app.issues)
  expect(url.searchParams.get("title")).toBe("cal 1.2.3: provider_error")
  const body = url.searchParams.get("body") ?? ""
  expect(body).toContain("cal 1.2.3, linux x64")
  expect(body).toContain("error: provider_error (quota.exceeded)")
  expect(body).not.toMatch(/r-1|events list|work/)
  expect(new URL(issueUrlFor(app, undefined, "linux", "x64")).searchParams.get("title")).toBe(
    "cal 1.2.3: problem report",
  )
})

const installed = (manifest: object): string => {
  const root = mkdtempSync(join(tmpdir(), "reports-package-"))
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3", ...manifest }))
  writeFileSync(join(root, "dist", "cli.js"), "")
  return join(root, "dist", "cli.js")
}

it("**finds the new-issue page in the CLI's package.json** when its app definition names none", () => {
  const { issues: _, ...bare } = app
  const github = { type: "git", url: "git+https://github.com/WireCatLabs/max-cli.git" }

  expect(issuesPage(bare, installed({ repository: github }))).toBe("https://github.com/WireCatLabs/max-cli/issues/new")
  expect(issuesPage(bare, installed({ bugs: { url: "https://github.com/WireCatLabs/tg-cli/issues" } }))).toBe(
    "https://github.com/WireCatLabs/tg-cli/issues/new",
  )
  expect(issuesPage(bare, installed({ repository: "https://gitlab.com/example/cal-cli" }))).toBeUndefined()
  expect(issuesPage(bare, installed({ version: "9.9.9", repository: github }))).toBeUndefined()
  expect(issuesPage(app, installed({ repository: github }))).toBe(app.issues)
})
