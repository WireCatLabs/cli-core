import assert from "node:assert/strict"
import { hasSharedContract, metaOf, sharedContractOverrides } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import type { ContractCase } from "../../../meetings/index.js"
import type { DocumentWords } from "../words.js"

/** The CLI's commands over its own fakes, with a fresh store and a fresh provider for each case. */
export interface DocumentCommandsFixture {
  /** The CLI's whole command tree, as `run` builds it. */
  program: Command
  words: DocumentWords
  /**
   * Runs one command against the fakes, the words after the profile (`["tags", "list", "a"]`), with the profile chosen
   * and `--json` added by the CLI. Answers the exit code and what it printed as data.
   */
  run(argv: string[]): Promise<{ exit: number; stdout: string }>
  /** A document the fake provider holds, by an id `documents show` takes once `sync` imported it. */
  document: string
  /** A word of that document's text, which `search` finds. */
  word: string
  /** The CLI mounts `mirrors`. */
  mirrors?: boolean
}

/** Every path the shared builders add, as `<group> <command>`. */
export const SHARED_DOCUMENT_PATHS = [
  "folders add",
  "folders list",
  "folders remove",
  "sync",
  "status",
  "documents list",
  "documents show",
  "documents export",
  "documents context",
  "search",
  "catalog import",
  "catalog show",
  "catalog list",
  "catalog search",
  "catalog tree",
  "catalog tags list",
  "catalog tags add",
  "catalog tags remove",
  "tags list",
  "tags add",
  "tags remove",
  "relationships list",
  "relationships add",
  "relationships remove",
  "notes add",
  "notes list",
  "notes show",
  "notes edit",
  "notes remove",
  "memories add",
  "memories list",
  "memories show",
  "memories confirm",
  "memories stale",
  "memories search",
  "memories extract",
  "facts add",
  "facts list",
  "facts show",
  "facts confirm",
  "facts reverse",
  "identities list",
  "identities link",
] as const

export const SHARED_MIRROR_PATHS = [
  "mirrors add",
  "mirrors list",
  "mirrors remove",
  "mirrors status",
  "mirrors sync",
  "mirrors watch",
] as const

type Effect = { remote: "none" | "read" | "write"; local: "none" | "read" | "write" }
const READ: Effect = { remote: "none", local: "read" }
const WRITE: Effect = { remote: "none", local: "write" }
const FETCH: Effect = { remote: "read", local: "write" }
const PUSH: Effect = { remote: "write", local: "write" }

/** What each shared path reads and writes: the MCP server offers or holds back a tool by it. */
export const SHARED_EFFECTS: Record<
  (typeof SHARED_DOCUMENT_PATHS)[number] | (typeof SHARED_MIRROR_PATHS)[number],
  Effect
> = {
  "folders add": FETCH,
  "folders list": READ,
  "folders remove": WRITE,
  sync: FETCH,
  status: READ,
  "documents list": READ,
  "documents show": READ,
  "documents export": WRITE,
  "documents context": READ,
  search: READ,
  "catalog import": WRITE,
  "catalog show": READ,
  "catalog list": READ,
  "catalog search": READ,
  "catalog tree": READ,
  "catalog tags list": READ,
  "catalog tags add": WRITE,
  "catalog tags remove": WRITE,
  "tags list": READ,
  "tags add": WRITE,
  "tags remove": WRITE,
  "relationships list": READ,
  "relationships add": WRITE,
  "relationships remove": WRITE,
  "notes add": WRITE,
  "notes list": READ,
  "notes show": READ,
  "notes edit": WRITE,
  "notes remove": WRITE,
  "memories add": WRITE,
  "memories list": READ,
  "memories show": READ,
  "memories confirm": WRITE,
  "memories stale": WRITE,
  "memories search": READ,
  "memories extract": PUSH,
  "facts add": WRITE,
  "facts list": READ,
  "facts show": READ,
  "facts confirm": WRITE,
  "facts reverse": WRITE,
  "identities list": READ,
  "identities link": WRITE,
  "mirrors add": FETCH,
  "mirrors list": READ,
  "mirrors remove": WRITE,
  "mirrors status": READ,
  "mirrors sync": PUSH,
  "mirrors watch": PUSH,
}

const find = (program: Command, path: string): Command | undefined => {
  let at: Command | undefined = program
  for (const name of path.split(" ")) at = at?.commands.find((command) => command.name() === name)
  return at
}

const json = (stdout: string): unknown => {
  const lines = stdout.trim().split("\n")
  try {
    return JSON.parse(stdout)
  } catch {
    return lines.map((line) => JSON.parse(line))
  }
}

const ok = async (fixture: DocumentCommandsFixture, argv: string[]) => {
  const answer = await fixture.run(argv)
  assert.equal(answer.exit, 0, `${argv.join(" ")} exits 0`)
  return json(answer.stdout) as Record<string, unknown>
}

/** Every value under `key` anywhere in an answer, so a check does not depend on one CLI's envelope. */
const valuesOf = (value: unknown, key: string): unknown[] => {
  if (Array.isArray(value)) return value.flatMap((one) => valuesOf(one, key))
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([name, one]) => [...(name === key ? [one] : []), ...valuesOf(one, key)])
}
const items = (answer: Record<string, unknown>) =>
  (Array.isArray(answer.items) ? answer.items : []) as Record<string, unknown>[]

/** What every documents CLI's shared commands are and answer: run each case in the CLI's tests. */
export const documentCommandsContract = (
  make: () => DocumentCommandsFixture | Promise<DocumentCommandsFixture>,
): ContractCase[] => [
  {
    name: "tree: every shared path is there, still cli-core's, and says what it reads and writes",
    async run() {
      const fixture = await make()
      const paths = [...SHARED_DOCUMENT_PATHS, ...(fixture.mirrors ? SHARED_MIRROR_PATHS : [])]
      for (const path of paths) {
        const command = find(fixture.program, path)
        assert.ok(command, `${path} is mounted`)
        assert.ok(hasSharedContract(command), `${path} is the shared definition`)
        const { remote, local } = metaOf(command).effects ?? {}
        assert.deepEqual({ remote, local }, SHARED_EFFECTS[path], `${path} reads and writes what cli-core says`)
      }
      const name = fixture.program.name()
      const overridden = sharedContractOverrides(fixture.program)
        .map((override) => (override.command[0] === name ? override.command.slice(1) : override.command).join(" "))
        .filter((path) =>
          paths.some((shared) => shared === path || shared.startsWith(`${path} `) || path.startsWith(`${shared} `)),
        )
      assert.deepEqual(overridden, [], "the CLI overrides no shared contract")
    },
  },
  {
    name: "words: the remote side is the CLI's word in --keep and in identities link",
    async run() {
      const fixture = await make()
      const link = find(fixture.program, "identities link")
      assert.ok(
        link?.registeredArguments.some((argument) => argument.name() === `${fixture.words.remote}-id`),
        `identities link takes <${fixture.words.remote}-id>`,
      )
      if (!fixture.mirrors) return
      const keep = find(fixture.program, "mirrors sync")?.options.find((option) => option.long === "--keep")
      assert.deepEqual(keep?.argChoices, ["local", fixture.words.remote, "both"])
    },
  },
  {
    name: "sync, then documents list, documents show, status and search answer the imported document",
    async run() {
      const fixture = await make()
      await ok(fixture, ["sync"])
      const listed = items(await ok(fixture, ["documents", "list"])).map((item) => item.id)
      assert.ok(listed.includes(fixture.document), `documents list answers ${fixture.document} by its id`)
      const shown = await ok(fixture, ["documents", "show", fixture.document])
      assert.ok(valuesOf(shown, "id").includes(fixture.document), `documents show answers ${fixture.document}`)
      assert.ok(
        valuesOf(shown, "text").some((text) => typeof text === "string" && text.includes(fixture.word)),
        `documents show gives the text with "${fixture.word}"`,
      )
      await ok(fixture, ["status"])
      const found = await ok(fixture, ["search", fixture.word])
      assert.ok(valuesOf(found, "id").includes(fixture.document), `search "${fixture.word}" finds ${fixture.document}`)
    },
  },
  {
    name: "tags and notes: what is added to a document is listed on it, and a removed tag is gone",
    async run() {
      const fixture = await make()
      await ok(fixture, ["sync"])
      await ok(fixture, ["tags", "add", fixture.document, "contract-tag"])
      const tags = async () => items(await ok(fixture, ["tags", "list", fixture.document])).map((item) => item.tag)
      assert.deepEqual(await tags(), ["contract-tag"])
      await ok(fixture, ["tags", "remove", fixture.document, "contract-tag"])
      assert.deepEqual(await tags(), [])
      await ok(fixture, ["notes", "add", fixture.document, "check the contract numbers"])
      const notes = items(await ok(fixture, ["notes", "list", fixture.document])).map((item) => item.text)
      assert.deepEqual(notes, ["check the contract numbers"])
    },
  },
]
