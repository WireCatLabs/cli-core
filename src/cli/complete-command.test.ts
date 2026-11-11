import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { appCompleteCommand, type CompletionRequest } from "./complete-command.js"
import { run } from "./program.js"

const app = { command: "crm", appName: "crm-cli", envPrefix: "CRM", description: "test", version: "1" }

const complete = async (words: string[], env: NodeJS.ProcessEnv = {}) => {
  const asked: CompletionRequest[] = []
  const streams = captureStreams()
  const code = await run(
    ["complete", ...words],
    {
      app: { ...app, messenger: false },
      commands: () => [
        appCompleteCommand(
          app,
          { configuredProfiles: () => ["work"] },
          {
            sources: (request) => {
              asked.push(request)
              if (request.profile === "broken") throw new Error("never on a shell's screen")
              return request.profile
                ? { arguments: { deal: () => [{ value: "deal:7", description: "Kitchen" }] } }
                : undefined
            },
          },
        ),
        new Command("deals").addCommand(new Command("show").argument("<deal>")),
      ],
    },
    { env, streams, tty: false },
  )
  return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr, asked }
}

describe("shell completion for a CLI that is not a messenger", () => {
  it("prints the script a shell sources", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      expect((await complete(["zsh"])).code).toBe(0)
      expect(log.mock.calls.flat().join("\n")).toContain("crm complete --")
    } finally {
      log.mockRestore()
    }
  })

  it("offers the profiles first, then commands, then the CLI's own names for the profile", async () => {
    expect((await complete(["--", ""])).stdout).toContain("work")
    expect((await complete(["--", "work", "de"])).stdout).toContain("deals")
    const { stdout, asked } = await complete(["--", "work", "deals", "show", ""])
    expect(stdout).toBe("deal:7\tKitchen\n:4")
    expect(asked.at(-1)).toMatchObject({ profile: "work", words: ["deals", "show", ""] })
  })

  it("names nothing for another profile than the locked one, and keeps a failing source off stderr", async () => {
    expect((await complete(["--", "home", "deals", "show", ""], { CRM_PROFILE_LOCK: "work" })).stdout).toBe(":4")
    const broken = await complete(["--", "broken", "deals", "show", ""])
    expect(broken.code).toBe(0)
    expect(broken.stdout).toBe(":4")
    expect(broken.stderr).toEqual([])
  })
})
