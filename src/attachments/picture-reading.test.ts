import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import type { Body } from "../cli/envelope.js"
import { localOnlyCommand } from "../cli/local-only-command.js"
import { pictureReadingCommand } from "../cli/picture-reading-command.js"
import { storePath } from "../store/path.js"
import { sharedConfigPath, writeSharedSection } from "../store/shared-config.js"
import {
  agentPictureReader,
  pictureAgentEnv,
  readPictureReading,
  readPictureWithAgent,
  writePictureReading,
} from "./picture-reading.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1" }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])

const machine = () => {
  const root = mkdtempSync(join(tmpdir(), "picture-reading-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  return {
    root,
    bin,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      WIRECAT_STATE_DIR: root,
      WIRECAT_CONFIG_DIR: join(root, "wirecat"),
      MESSAGING_STORE: join(root, "store.db"),
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_STATE_DIR: join(root, "state"),
      FAKE_OUT: root,
      ANTHROPIC_API_KEY: "synthetic-key",
      OPENAI_API_KEY: "synthetic-key",
      CLAUDECODE: "1",
      AI_AGENT: "claude-code_1_agent",
      CHAT_MCP_CLIENT: "synthetic",
    } as NodeJS.ProcessEnv,
  }
}

// Records what it was started with; Codex's answer goes to the file named after --output-last-message.
const fake = (bin: string, name: string) => {
  writeFileSync(
    join(bin, name),
    `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_OUT/argv"
env > "$FAKE_OUT/env"
cat > "$FAKE_OUT/stdin"
ls > "$FAKE_OUT/ls"
next=""
for arg in "$@"; do
  if [ "$next" = 1 ]; then printf 'Board: release plan' > "$arg"; next=""; fi
  [ "$arg" = "--output-last-message" ] && next=1
done
echo "Board: release plan"
`,
  )
  chmodSync(join(bin, name), 0o755)
}

const argv = (root: string) => readFileSync(join(root, "argv"), "utf8").trim().split("\n")

describe("picture reading by the owner's coding agent", () => {
  it("reads as never when absent or broken, and keeps agent and model when set", () => {
    const { env } = machine()
    expect(readPictureReading(env).mode).toBe("never")
    writePictureReading(env, { mode: "request", agent: "codex", model: "gpt-5" })
    expect(readPictureReading(env)).toMatchObject({ mode: "request", agent: "codex", model: "gpt-5" })
    writeSharedSection(sharedConfigPath(storePath(env), env), "picture_reading", { mode: "always", agent: "claude" })
    expect(readPictureReading(env).mode).toBe("never")
    writePictureReading(env, { mode: "never" })
    expect(readPictureReading(env).mode).toBe("never")
  })

  it("runs Claude Code with only Read, in a folder holding the picture, without the keys and agent variables", async () => {
    const { env, bin, root } = machine()
    fake(bin, "claude")
    const text = await readPictureWithAgent({ agent: "claude", bytes: JPEG, mime: "image/jpeg", env })
    expect(text).toBe("Board: release plan")
    const args = argv(root)
    expect(args.slice(0, 7)).toEqual([
      "--print",
      "--output-format",
      "text",
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
    ])
    expect(args).not.toContain("--model")
    expect(readFileSync(join(root, "ls"), "utf8").trim()).toBe("picture.jpg")
    expect(readFileSync(join(root, "stdin"), "utf8")).toContain("picture.jpg")
    const seen = readFileSync(join(root, "env"), "utf8")
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDECODE", "AI_AGENT", "CHAT_MCP_CLIENT"])
      expect(seen).not.toContain(`${name}=`)
    expect(seen).toContain("FAKE_OUT=")
  })

  it("gives Codex the picture with --image= first and the prompt on stdin last, with and without a model", async () => {
    const { env, bin, root } = machine()
    fake(bin, "codex")
    expect(await readPictureWithAgent({ agent: "codex", bytes: JPEG, mime: "image/jpeg", env })).toBe(
      "Board: release plan",
    )
    const plain = argv(root)
    expect(plain[0]).toBe("exec")
    expect(plain[1]).toMatch(/^--image=.*picture\.jpg$/)
    expect(plain.at(-1)).toBe("-")
    expect(plain).not.toContain("--model")
    await readPictureWithAgent({ agent: "codex", model: "gpt-5", bytes: JPEG, mime: "image/jpeg", env })
    const withModel = argv(root)
    expect(withModel.slice(-3)).toEqual(["--model", "gpt-5", "-"])
  })

  it("refuses what is not a picture, and says when the agent is missing or fails", async () => {
    const { env, bin } = machine()
    await expect(readPictureWithAgent({ agent: "claude", bytes: JPEG, mime: "text/plain", env })).rejects.toThrow(
      /PNG, JPEG or WebP/,
    )
    await expect(readPictureWithAgent({ agent: "claude", bytes: JPEG, mime: "image/jpeg", env })).rejects.toThrow(
      /not installed/,
    )
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho 'not signed in' >&2\nexit 3\n")
    chmodSync(join(bin, "claude"), 0o755)
    await expect(readPictureWithAgent({ agent: "claude", bytes: JPEG, mime: "image/jpeg", env })).rejects.toThrow(
      /Claude Code failed: not signed in/,
    )
  })

  it("hides only the keys and the agent variables", () => {
    expect(Object.keys(pictureAgentEnv({ PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "k", TG_MCP_CLIENT: "x" }))).toEqual(
      ["PATH", "HOME"],
    )
  })

  const command = (env: NodeJS.ProcessEnv) => {
    const answers: Body[] = []
    const notes: string[] = []
    const options = {
      env: () => env,
      output: (body: Body) => answers.push(body),
      diagnostic: (line: string) => notes.push(line),
    }
    const run = (...words: string[]) =>
      new Command("chat")
        .exitOverride()
        .addCommand(pictureReadingCommand(app, options))
        .addCommand(localOnlyCommand(app, options))
        .parseAsync(words, { from: "user" })
    const last = () => (answers.at(-1) as { item: Record<string, unknown> }).item
    return { run, last, notes }
  }

  it("`models picture-reading` turns reading on for an agent, warns, and local-only show lists it", async () => {
    const { env } = machine()
    delete env.CLAUDECODE
    delete env.AI_AGENT
    const { run, last, notes } = command(env)
    await run("picture-reading", "show")
    expect(last()).toEqual({ mode: "never", agent: null, model: null, extractor: null, since: null })
    await expect(run("picture-reading", "set", "request")).rejects.toThrow(/--agent claude or --agent codex/)
    await run("picture-reading", "set", "request", "--agent", "codex", "--model", "gpt-5")
    expect(last()).toMatchObject({ mode: "request", agent: "codex", model: "gpt-5", extractor: "agent:codex/gpt-5" })
    expect(notes.at(-1)).toContain("sent to Codex")
    await run("picture-reading", "set", "request", "--agent", "claude")
    expect(last()).toMatchObject({ agent: "claude", model: null, extractor: "agent:claude", changed: true })
    await run("local-only", "show")
    const row = (last().features as { id: string; where: string; refused: boolean }[]).find(
      ({ id }) => id === "picture_reading",
    )
    expect(row).toMatchObject({ where: "agent", refused: false })
    await expect(run("picture-reading", "set", "request", "--agent", "claude", "--model", "--x")).rejects.toThrow()
    await run("picture-reading", "set", "never")
    expect(last()).toMatchObject({ mode: "never", changed: true })
  })

  it("an agent may turn reading off but not on, unless the owner acts in the app", async () => {
    const { env } = machine()
    const { run, last } = command(env)
    await expect(run("picture-reading", "set", "request", "--agent", "claude")).rejects.toThrow(/only the owner/)
    expect(readPictureReading(env).mode).toBe("never")
    await run("picture-reading", "set", "request", "--agent", "claude", "--from-app")
    expect(last()).toMatchObject({ mode: "request" })
    await run("picture-reading", "set", "never")
    expect(readPictureReading(env).mode).toBe("never")
  })

  it("reads a file the owner adds with the same agent and extractor, and is absent while never", async () => {
    const { env, bin } = machine()
    fake(bin, "claude")
    expect(agentPictureReader(env)).toBeUndefined()
    writePictureReading(env, { mode: "request", agent: "claude", model: "sonnet" })
    const reader = agentPictureReader(env)
    expect(reader?.pipeline.extractor).toBe("agent:claude/sonnet")
    expect(
      await reader?.pipeline.transcribe({ mimeType: "image/jpeg", data: Buffer.from(JPEG).toString("base64") }),
    ).toBe("Board: release plan")
  })
})
