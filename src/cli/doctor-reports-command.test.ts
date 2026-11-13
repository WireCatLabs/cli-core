import { expect, it } from "vitest"
import type { RunMetadata } from "../runs/run.js"
import { issueUrlFor } from "./doctor-reports-command.js"

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
