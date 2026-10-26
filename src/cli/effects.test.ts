import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { annotate, describeProgram, flatten, metaOf } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { keyForCommand, WRITE_KEYS } from "../sends/permissions.js"
import { messenger, sharedProgram } from "../testing/shared-program.js"
import {
  changesAuthority,
  destroysNothing,
  FETCH,
  isOtherServiceCall,
  isStoreChange,
  judgedEffects,
  judgedTargets,
  LOCAL_WRITE,
  logsInOrOut,
  refuseUnderReadOnly,
} from "./effects.js"
import { chatsCommand } from "./messenger/chats-command.js"
import { createProgram, run } from "./program.js"
import { commandAt } from "./steps.js"

const program = createProgram(sharedProgram)

const runnable = (root: Command): { path: string; command: Command }[] => {
  const found: { path: string; command: Command }[] = []
  const visit = (command: Command, parents: string[]) => {
    if ((command as unknown as { _hidden?: boolean })._hidden) return
    const path = [...parents, command.name()]
    if ((command as unknown as { _actionHandler?: unknown })._actionHandler)
      found.push({ path: path.join(" "), command })
    for (const child of command.commands) visit(child, path)
  }
  for (const child of root.commands) visit(child, [])
  return found
}

describe("command effects", () => {
  const commands = runnable(program)

  it("are declared by every command that runs, reads included", () => {
    expect(commands.length).toBeGreaterThan(150)
    expect(commands.filter(({ command }) => !metaOf(command).effects).map(({ path }) => path)).toEqual([])
  })

  it("write somewhere wherever the profile's permissions call the command a write", () => {
    const wrong = commands.filter(({ path, command }) => {
      const key = keyForCommand(path.split(" "))
      const effects = metaOf(command).effects
      return key && WRITE_KEYS.includes(key) && effects && !writes(effects)
    })
    // Reads behind a key a profile must allow: the session list is private, and `conversations embeddings status`
    // shares the whole `conversations.embeddings` group's key (FIND-1262).
    expect(wrong.map(({ path }) => path)).toEqual(["account sessions list", "conversations embeddings status"])
  })

  it("mark the local writes the read-only lock refuses: what changes a later run's authority, and no read", () => {
    const marked = commands.filter(({ command }) => changesAuthority(command))
    expect(marked.filter(({ command }) => metaOf(command).effects?.local !== "write")).toEqual([])
    expect(marked.map(({ path }) => path).sort()).toEqual(
      [
        "attachments jobs install",
        "attachments jobs start",
        "attachments jobs stop",
        "attachments jobs uninstall",
        "bot auth remove",
        "bot auth set",
        "bot chats rules set",
        "bot chats rules unset",
        "bot recipients add",
        "bot recipients clear",
        "bot recipients remove",
        "chats rules set",
        "chats rules unset",
        "config set",
        "config unset",
        "flood clear",
        "mcp add",
        "models keys remove",
        "models keys set",
        "recipients add",
        "recipients clear",
        "recipients remove",
        "replies add",
        "replies audience",
        "replies consents allow",
        "replies consents deny",
        "replies consents grant",
        "replies consents revoke",
        "replies edit",
        "replies off",
        "replies on",
        "replies pause",
        "replies resume",
        "schedule agent",
        "schedule command",
        "schedule remove",
        "server install",
        "server uninstall",
        "skill install",
      ].sort(),
    )
  })

  it("refuse under the read-only lock every local write but what destroys nothing that cannot be got back", () => {
    const localWrites = commands.filter(({ command }) => {
      const effects = metaOf(command).effects
      return (
        (effects?.remote === "none" || isStoreChange(command)) &&
        effects?.local === "write" &&
        !changesAuthority(command)
      )
    })
    const refused = localWrites.filter(({ command }) => isStoreChange(command)).map(({ path }) => path)
    const kept = localWrites.filter(({ command }) => !isStoreChange(command)).map(({ path }) => path)

    expect(kept.sort()).toEqual(
      [
        "conversations embeddings clear",
        "conversations rebuild",
        "doctor reports create",
        "mcp server start",
        "mcp server stop",
        "mentions rebuild",
        "server restart",
        "server start",
        "server stop",
        "stats charts",
        "store backup",
        "store export",
        "store jobs cancel",
        "store jobs clear",
        "store jobs retry",
        "store rebuild",
        "tasks add",
        "tasks claim",
        "tasks close",
        "tasks duplicates defer",
        "tasks duplicates reject",
        "tasks link",
        "tasks merge",
        "tasks update",
        "tasks release",
        "tasks scan",
        "tasks unmerge",
      ].sort(),
    )
    expect(refused.sort()).toEqual(
      [
        "attachments move",
        "attachments update",
        "chats tracking add",
        "chats tracking remove",
        "contacts aliases remove",
        "contacts aliases set",
        "contacts link",
        "contacts notes add",
        "contacts notes edit",
        "contacts notes remove",
        "contacts unlink",
        "conversations consents remove",
        "conversations links add",
        "conversations links clear",
        "mentions confirm",
        "mentions reject",
        "searches clear",
        "searches create",
        "searches delete",
        "store clear",
        "store copies delete",
        "store decrypt",
        "store migrate",
        "store repair",
        "store reset",
        "store restore",
        "tags add",
        "tags rebuild",
        "tags remove",
        "tasks reject",
      ].sort(),
    )
    expect(
      commands
        .filter(({ command }) => isStoreChange(command) && metaOf(command).effects?.remote !== "none")
        .map(({ path }) => path),
    ).toEqual(["tags rebuild"])
  })

  it("let through every task write the follow-ups skill makes on a timer, but the owner's tasks reject", () => {
    const skill = readFileSync(new URL("../../skills/follow-ups/SKILL.md", import.meta.url), "utf8")
    const named = [
      ...new Set([...skill.matchAll(/`(?:\{\{command\}\} )?(tasks (?:duplicates )?[a-z]+)/g)].map((m) => m[1])),
    ]
    const used = commands.filter(({ path }) => named.includes(path))

    expect(used.length).toBeGreaterThan(10)
    expect(used.filter(({ command }) => isStoreChange(command)).map(({ path }) => path)).toEqual(["tasks reject"])
  })

  it("refuse a local write nobody marked, so a new command fails closed", () => {
    const fresh = annotate(new Command("fresh"), { effects: LOCAL_WRITE })
    expect(isStoreChange(fresh)).toBe(true)
    expect(isStoreChange(destroysNothing(annotate(new Command("kept"), { effects: LOCAL_WRITE })))).toBe(false)
    expect(isStoreChange(annotate(new Command("fetch"), { effects: FETCH }))).toBe(false)
  })

  it("keep off serve's relay the commands whose remote side is another service", () => {
    const marked = commands.filter(({ command }) => isOtherServiceCall(command)).map(({ path }) => path)
    expect(marked.sort()).toEqual(
      [
        "conversations links rebuild",
        "conversations embed",
        "images models download",
        "models download",
        "search conversations",
      ].sort(),
    )
  })

  it("tell the commands document which commands reach another service, so its page does not call them messenger writes", () => {
    const described = flatten(describeProgram(program))
    const reaching = described
      .filter((command) => command.reaches === "other_service")
      .map(({ path }) => path.join(" "))
    expect(reaching.sort()).toEqual(
      commands
        .filter(({ command }) => isOtherServiceCall(command))
        .map(({ path }) => path)
        .sort(),
    )
    const send = described.find(({ path }) => path.join(" ") === "messages send")
    expect(send).toBeDefined()
    expect(send?.reaches).toBeUndefined()
  })

  it("judge retry on the remote side, and keep a local-only write from running unasked", () => {
    expect(judgedEffects({ remote: "read", local: "write" })).toEqual({ remote: "read", local: "none" })
    expect(judgedEffects(undefined)).toBeUndefined()
    const targets = judgedTargets(program)
    expect(targets("messages sync")?.effects).toEqual({ remote: "read", local: "none" })
    expect(targets("messages send")?.effects).toEqual({ remote: "write", local: "none" })
    expect(targets("conversations embed")?.effects).toEqual({ remote: "write", local: "none" })
    expect(targets("conversations links rebuild")?.effects).toEqual({ remote: "write", local: "none" })
    expect(targets("server restart")?.effects).toEqual({ remote: "none", local: "write" })
  })
})

describe("refuseUnderReadOnly", () => {
  const unlink = async (env: NodeJS.ProcessEnv) => {
    let ended = false
    const streams = captureStreams()
    const code = await run(
      ["session", "end"],
      {
        app: sharedProgram.app,
        commands: () => [
          new Command("session").addCommand(
            new Command("end").action(function (this: Command) {
              refuseUnderReadOnly(this, "unlink the device")
              ended = true
            }),
          ),
        ],
      },
      { streams, tty: false, env },
    )
    return { code, ended, stderr: streams.stderr.join("") }
  }

  it("stops a write the send guard never sees, before it runs, under the app's lock", async () => {
    const locked = await unlink({ CHAT_READ_ONLY: "1" })

    expect(locked.ended).toBe(false)
    expect(locked.code).toBe(5)
    expect(JSON.parse(locked.stderr).error).toMatchObject({
      code: "permission_error",
      message: "this process is read-only (CHAT_READ_ONLY) — it cannot unlink the device",
    })
  })

  it("lets it run without the lock, or with the lock set to 0", async () => {
    expect((await unlink({})).ended).toBe(true)
    expect((await unlink({ CHAT_READ_ONLY: "0" })).ended).toBe(true)
  })

  it("refuses a command marked as a login or logout under the lock, before its action", async () => {
    let ran = false
    const streams = captureStreams()
    const code = await run(
      ["session", "end"],
      {
        app: sharedProgram.app,
        commands: () => [
          new Command("session").addCommand(
            logsInOrOut(new Command("end")).action(() => {
              ran = true
            }),
          ),
        ],
      },
      { streams, tty: false, env: { CHAT_READ_ONLY: "1" } },
    )

    expect([code, ran]).toEqual([5, false])
    expect(JSON.parse(streams.stderr.join("")).error.message).toBe(
      "this process is read-only (CHAT_READ_ONLY) — it cannot log in or out",
    )
  })

  it("refuses to guess whose lock it is outside run()", () => {
    expect(() => refuseUnderReadOnly(new Command("end"), "unlink the device")).toThrow(/inside run\(\)/)
  })
})

describe("the read-only lock on the message store", () => {
  const root = mkdtempSync(join(tmpdir(), "read-only-store-"))
  const kept = (name: string) => {
    const path = join(root, name)
    writeFileSync(path, "kept")
    return path
  }
  const locked = async (argv: string[], store: string) => {
    const streams = captureStreams()
    const code = await run([...argv, "--json"], sharedProgram, {
      streams,
      tty: false,
      env: { ...process.env, CHAT_READ_ONLY: "1", MESSAGING_STORE: store },
    })
    const error = JSON.parse(streams.stderr.find((line) => line.startsWith("{")) ?? "{}").error
    return { code, error }
  }

  it.each([
    ["reset", ["store", "reset", "--yes"]],
    ["restore", ["store", "restore", "BACKUP"]],
    ["clear", ["store", "clear", "--left", "--allow-dangerous"]],
    ["migrate", ["store", "migrate"]],
    ["repair", ["store", "repair"]],
    ["copies delete", ["store", "copies", "delete", "old_messages"]],
    ["decrypt", ["store", "decrypt", "BACKUP", "--output", "OUT"]],
  ])("refuses store %s and leaves the store file as it was", async (name, argv) => {
    const store = kept(`${name}.db`)
    const backup = kept(`${name}.backup`)
    const output = join(root, `${name}.out`)
    const words = argv.map((word) => (word === "BACKUP" ? backup : word === "OUT" ? output : word))

    const { code, error } = await locked(["ro", ...words], store)

    expect([code, error.code]).toEqual([5, "permission_error"])
    expect(error.message).toBe("this process is read-only (CHAT_READ_ONLY) — it cannot change the message store")
    expect(readFileSync(store, "utf8")).toBe("kept")
    expect(existsSync(output)).toBe(false)
  })

  it.each([
    ["searches delete", ["searches", "delete", "daily"]],
    ["searches clear", ["searches", "clear"]],
    ["contacts notes remove", ["contacts", "notes", "remove", "Alice", "1"]],
    ["contacts aliases remove", ["contacts", "aliases", "remove", "Alice"]],
    ["contacts notes edit", ["contacts", "notes", "edit", "Alice", "1", "--revision", "1"]],
    ["tags remove", ["tags", "remove", "work", "--chat", "7"]],
    ["searches create", ["searches", "create", "daily", "cat"]],
    ["contacts aliases set", ["contacts", "aliases", "set", "Alice", "Al"]],
    ["tags add", ["tags", "add", "work", "--chat", "7"]],
    ["tags rebuild", ["tags", "rebuild"]],
    ["mentions confirm", ["mentions", "confirm", "1"]],
    ["contacts notes add", ["contacts", "notes", "add", "Alice", "--text-file", "/dev/null"]],
    ["contacts link", ["contacts", "link", "Alice", "Bob"]],
    ["attachments update", ["attachments", "update", "7", "1", "--text-file", "/dev/null"]],
    ["chats tracking add", ["chats", "tracking", "add", "7"]],
    ["conversations links add", ["conversations", "links", "add", "--batch", "1"]],
    ["conversations consents remove", ["conversations", "consents", "remove"]],
  ])("refuses %s, which writes what the owner keeps", async (name, argv) => {
    const store = kept(`${name}.db`)

    const { code, error } = await locked(["ro", ...argv], store)

    expect([code, error.code]).toEqual([5, "permission_error"])
    expect(error.message).toBe("this process is read-only (CHAT_READ_ONLY) — it cannot change the message store")
    expect(readFileSync(store, "utf8")).toBe("kept")
  })

  it("previews tags add with --dry-run and leaves the store as it was", async () => {
    const store = kept("dry.db")

    const { code } = await locked(["ro", "tags", "add", "work", "--chat", "7", "--dry-run"], store)

    expect(code).toBe(0)
    expect(readFileSync(store, "utf8")).toBe("kept")
  })

  it.each([
    ["store export", ["store", "export", "--output", "OUT"]],
    ["stats charts", ["stats", "charts", "7", "--output", "OUT"]],
    ["messages sync", ["messages", "sync", "7"]],
    ["contacts sync", ["contacts", "sync"]],
    ["review --new", ["review", "--new"]],
  ])("lets %s past the lock: it writes nothing the owner keeps, or it receives", async (_, argv) => {
    const { error } = await locked(
      ["ro", ...argv.map((word) => (word === "OUT" ? join(root, "out.svg") : word))],
      join(root, "absent.db"),
    )

    expect(error?.message ?? "").not.toContain("read-only")
  })

  it("still previews store repair with --dry-run", async () => {
    expect((await locked(["ro", "store", "repair", "--dry-run"], join(root, "preview.db"))).code).toBe(0)
  })

  it("still previews store reset with --dry-run", async () => {
    expect((await locked(["ro", "store", "reset", "--dry-run"], join(root, "preview.db"))).code).toBe(0)
  })
})

describe("reads a pushed history answers from the store", () => {
  it.each([
    ["server", "read"],
    ["store", "none"],
  ] as const)("declares chats list and show for a %s history as remote %s", (history, remote) => {
    const chats = new Command().addCommand(chatsCommand({ ...messenger, history }))

    for (const path of ["chats list", "chats show"])
      expect(metaOf(commandAt(chats, path) as Command).effects).toEqual({ remote, local: "read" })
  })
})
