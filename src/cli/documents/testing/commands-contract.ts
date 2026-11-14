import assert from "node:assert/strict"
import { hasSharedContract, metaOf } from "@wirecat/cli-base/commands"
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
  return JSON.stringify(json(answer.stdout))
}

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
        assert.ok(metaOf(command).effects, `${path} declares its effects`)
      }
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
      assert.match(await ok(fixture, ["documents", "list"]), new RegExp(fixture.document))
      assert.match(await ok(fixture, ["documents", "show", fixture.document]), new RegExp(fixture.word))
      await ok(fixture, ["status"])
      assert.match(await ok(fixture, ["search", fixture.word]), new RegExp(fixture.document))
    },
  },
  {
    name: "tags and notes: what is added to a document is listed on it, and a removed tag is gone",
    async run() {
      const fixture = await make()
      await ok(fixture, ["sync"])
      await ok(fixture, ["tags", "add", fixture.document, "contract-tag"])
      assert.match(await ok(fixture, ["tags", "list", fixture.document]), /contract-tag/)
      await ok(fixture, ["tags", "remove", fixture.document, "contract-tag"])
      assert.doesNotMatch(await ok(fixture, ["tags", "list", fixture.document]), /contract-tag/)
      await ok(fixture, ["notes", "add", fixture.document, "check the contract numbers"])
      assert.match(await ok(fixture, ["notes", "list", fixture.document]), /check the contract numbers/)
    },
  },
]
