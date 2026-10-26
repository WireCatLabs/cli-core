import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { buildDoctorReport, doctorReportFileName } from "../index.js"

const report = () => ({
  doctor: { config: { path: "/home/example/config.json" } },
  runsDir: mkdtempSync(join(tmpdir(), "doctor-report-")),
  command: "example",
  sends: [],
  home: "/home/example",
  now: new Date("2026-10-24T12:34:56.000Z"),
})

describe("public diagnostic reports", () => {
  it("keeps the shared report shape when no consumer context is supplied", () => {
    expect(buildDoctorReport(report())).toEqual({
      createdAt: "2026-10-24T12:34:56.000Z",
      doctor: { config: { path: "~/config.json" } },
      run: null,
      sends: [],
    })
    expect(doctorReportFileName("example", report().now)).toBe("example-report-20261024T123456Z.json")
  })

  it("preserves typed consumer context and redacts its home paths", () => {
    const result = buildDoctorReport({
      ...report(),
      context: { version: "1.2.3", runtime: "Node", platform: "linux", arch: "x64", profile: "/home/example/profile" },
    })
    const version: string = result.version
    const path: string = result.doctor.config.path
    expect(version).toBe("1.2.3")
    expect(path).toBe("~/config.json")
    expect(result.profile).toBe("~/profile")
    expect(result).toMatchObject({ runtime: "Node", platform: "linux", arch: "x64", run: null, sends: [] })
  })

  it("does not let untyped context replace the report's own fields", () => {
    const context = {
      version: "1.2.3",
      createdAt: "wrong",
      doctor: { secret: "wrong" },
      run: "wrong",
      sends: ["wrong"],
    }
    // @ts-expect-error JavaScript callers can supply fields forbidden by the typed context contract.
    const result = buildDoctorReport({ ...report(), context })
    expect(result.createdAt).toBe("2026-10-24T12:34:56.000Z")
    expect(result.doctor).toEqual({ config: { path: "~/config.json" } })
    expect(result.run).toBeNull()
    expect(result.sends).toEqual([])
  })
  it("optionally preserves recorded technical fields while keeping content out and labelling ids", () => {
    const options = report()
    const dir = join(options.runsDir, "2026-10-24", "synthetic-run")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        runId: "synthetic-run",
        command: "messages list",
        status: "failed",
        profile: "example",
        startedAt: "2026-10-24T12:00:00.000Z",
        cliVersion: "1",
      }),
    )
    writeFileSync(
      join(dir, "events.jsonl"),
      JSON.stringify({
        time: "2026-10-24T12:00:00.000Z",
        severity: "info",
        attributes: {
          event: "request",
          opcode: 7,
          chat_id: "synthetic-chat",
          ids: { chat: "synthetic-chat" },
          message_text: "SYNTHETIC-CONTENT",
        },
      }),
    )
    const summary = buildDoctorReport(options).run?.events[0]
    expect(summary).not.toHaveProperty("time")
    expect(summary).not.toHaveProperty("opcode")
    const recorded = buildDoctorReport({ ...options, eventFields: "recorded" }).run?.events[0]
    expect(recorded).toMatchObject({
      time: "2026-10-24T12:00:00.000Z",
      severity: "info",
      opcode: 7,
      ids: { chat: expect.stringMatching(/^id:/) },
    })
    expect(recorded?.chat_id).toEqual((recorded?.ids as Record<string, string> | undefined)?.chat)
    expect(JSON.stringify(recorded)).not.toContain("SYNTHETIC-CONTENT")
    expect(JSON.stringify(recorded)).not.toContain("synthetic-chat")
  })

  it("masks the words a run kept as typed, since a report leaves the machine", () => {
    const options = report()
    const dir = join(options.runsDir, "2026-10-24", "typed-run")
    mkdirSync(dir, { recursive: true })
    const typed = ["messages", "send", "Mom", "SYNTHETIC-CONTENT", "--limit", "5"]
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        run_id: "typed-run",
        command: "messages send",
        status: "failed",
        started_at: "2026-10-24T12:00:00.000Z",
        argv: typed,
      }),
    )
    const program = new Command("example")
    program.command("messages").command("send").argument("<chat>").argument("<text>").option("--limit <n>")

    expect(buildDoctorReport({ ...options, program }).run?.metadata.argv).toEqual([
      "messages",
      "send",
      "[redacted]",
      "[redacted]",
      "--limit",
      "5",
    ])
    expect(JSON.stringify(buildDoctorReport(options))).not.toContain("SYNTHETIC-CONTENT")
  })
})
