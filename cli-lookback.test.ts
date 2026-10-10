import { Command } from "commander"
import { expect, it } from "vitest"
import { addMeetingCommands } from "./cli/index.js"
import { fakeMeetingSource, memoryMeetingStore } from "./testing/index.js"

it("CLI lookback revisits the cursor window for late transcripts and subtracts from explicit since", async () => {
  const store = memoryMeetingStore()
  let available = false
  let now = 86400000
  const boundaries: string[] = []
  const source = fakeMeetingSource({
    async meetings(since) {
      boundaries.push(since)
      return Date.parse(since) <= 1000 ? fakeMeetingSource().meetings(since) : []
    },
    async transcript() {
      return available ? [{ startMs: 0, endMs: 1000, speaker: null, text: "Late example transcript" }] : null
    },
  })
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
    addMeetingCommands(program, { store, source, accountId: 1, rootIngestion: true, write() {}, now: () => now })
    await program.parseAsync(["pull", ...args], { from: "user" })
  }
  await run("--since", "1970-01-01")
  available = true
  now += 1000
  await run()
  expect(boundaries[1]).toBe("1970-01-02T00:00:00.000Z")
  const meeting = (await store.meetings())[0]
  expect((await store.meeting(meeting?.id ?? 0))?.transcripts).toHaveLength(0)
  now += 1000
  await run("--lookback-days", "1")
  expect(boundaries[2]).toBe("1970-01-01T00:00:01.000Z")
  expect((await store.meeting(meeting?.id ?? 0))?.transcripts[0]?.rows[0]?.text).toBe("Late example transcript")
  await run("--since", "1970-01-02", "--lookback-days", "1")
  expect(boundaries[3]).toBe("1970-01-01T00:00:00.000Z")
  expect((await store.meeting(meeting?.id ?? 0))?.transcripts).toHaveLength(1)
  await run("--since", "1970-01-02", "--lookback-days", "0")
  expect(boundaries[4]).toBe("1970-01-02T00:00:00.000Z")
  await run("--since", "1970-02-01", "--lookback-days", "31")
  expect(boundaries[5]).toBe("1970-01-01T00:00:00.000Z")
})

it("CLI rejects invalid lookback bounds before requesting provider records", async () => {
  let requests = 0
  const source = fakeMeetingSource({
    async meetings() {
      requests++
      return []
    },
  })
  for (const days of ["-1", "32", "1.5", "NaN", "9007199254740992"]) {
    const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
    addMeetingCommands(program, { store: memoryMeetingStore(), source, accountId: 1, write() {} })
    await expect(
      program.parseAsync(["meetings", "pull", "--lookback-days", days], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.invalidArgument" })
  }
  expect(requests).toBe(0)
})
