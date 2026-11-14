import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { toolsFromCommands } from "../mcp/agent.js"
import { addMeetingCommands, type MeetingCommandDeps } from "../meetings/cli/index.js"
import { flagPaging, memoryMeetingStore, sampleMeeting } from "../meetings/testing/index.js"
import { isStoreChange, readsOverMcpAt, writesNewFileOnlyWith } from "./effects.js"
import { writeNewFile } from "./new-file.js"

const program = async (deps: Partial<MeetingCommandDeps> = {}) => {
  const store = memoryMeetingStore()
  const saved = await store.saveMeeting(sampleMeeting())
  const root = new Command("meet").exitOverride().configureOutput({ writeErr() {}, writeOut() {} })
  addMeetingCommands(root, {
    store,
    pagingOf: flagPaging,
    accountId: 1,
    write() {},
    inRun: (_command, body) => body(),
    newFileOutput: writesNewFileOnlyWith,
    writeFile: writeNewFile,
    ...deps,
  })
  const exporter = root.commands
    .find((one) => one.name() === "meetings")
    ?.commands.find((one) => one.name() === "export")
  if (!exporter) throw new Error("no meetings export")
  return { root, exporter, id: String(saved.meeting.id) }
}

describe("meetings export with the new-file mark", () => {
  it("is a read over MCP, without --output, and passes the read-only lock with it", async () => {
    const { root, exporter } = await program()
    const tools = toolsFromCommands(describeProgram(root), { fetchOnly: readsOverMcpAt(root) })
    expect(tools.find(({ command }) => command === "meetings export")?.writes).toBe(false)
    expect(isStoreChange(exporter)).toBe(false)
    exporter.setOptionValue("output", "meeting.md")
    expect(isStoreChange(exporter)).toBe(false)
  })

  it("is still a store change for a host that does not mark it", async () => {
    const { exporter } = await program({ newFileOutput: undefined })
    expect(isStoreChange(exporter)).toBe(true)
  })

  it("writes a new file and refuses one that exists, leaving it as it was", async () => {
    const folder = mkdtempSync(join(tmpdir(), "meetings-export-"))
    const taken = join(folder, "taken.md")
    writeFileSync(taken, "the owner's notes")
    const { root, id } = await program()
    await expect(root.parseAsync(["meetings", "export", id, "--output", taken], { from: "user" })).rejects.toThrow(
      /already exists/,
    )
    expect(readFileSync(taken, "utf8")).toBe("the owner's notes")
    const fresh = join(folder, "new.md")
    await root.parseAsync(["meetings", "export", id, "--output", fresh], { from: "user" })
    expect(readFileSync(fresh, "utf8")).toContain("#")
  })
})
