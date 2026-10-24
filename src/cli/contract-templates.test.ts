import { Command } from "commander"
import { expect, it } from "vitest"
import { SEARCH_SHELL } from "../../test/cli-contract-templates.fixture.js"
import { sharedCommandTemplate } from "./contract-templates.js"
import { assertSharedContracts, customizeSharedCommand, sharedContractOverrides } from "./shared-contracts.js"

const app = {
  command: "synthetic",
  appName: "synthetic",
  envPrefix: "SYNTHETIC",
  description: "synthetic data",
  version: "1",
}
it("offers protected standard defaults without opening a runtime or account", async () => {
  for (const name of ["commands", "doctor", "mcp", "search", "notes", "session", "setup", "meetings"] as const) {
    const command = sharedCommandTemplate(app, name)
    expect(command.name()).toBe(name)
    expect(() => assertSharedContracts(command)).not.toThrow()
  }
  const doctor = sharedCommandTemplate(app, "doctor")
  await expect(new Command("synthetic").addCommand(doctor).parseAsync(["doctor"], { from: "user" })).rejects.toThrow(
    "template cannot execute",
  )
})
it("keeps a standalone source shell explicit and exposes its exact deviations", () => {
  const source = customizeSharedCommand(
    sharedCommandTemplate(app, "search"),
    "This standalone source searches imported documents only.",
    () => new Command("search").description("imported document search").option("--limit <n>", "result count"),
    SEARCH_SHELL,
  )
  const root = new Command("synthetic").addCommand(source)
  expect(sharedContractOverrides(root)).toContainEqual(
    expect.objectContaining({ command: ["search"], field: "description", after: "imported document search" }),
  )
  source.option("--undocumented", "a silent change")
  expect(() => assertSharedContracts(root)).toThrow("without an explicit override")
})
