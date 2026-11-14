import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { defineQuery } from "@wirecat/cli-base/query"
import { type Command, Option } from "commander"
import { type Complete, type DocumentKnowledge, extractDocumentMemories, type ImportedSource } from "../../documents.js"
import { FACT_TYPES, MEMORY_KINDS } from "../../domain/knowledge.js"
import type { Author, Decider, Fact, Memory } from "../../store/index.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { LOCAL_READ, LOCAL_WRITE, REMOTE_WRITE } from "../effects.js"
import { type Body, itemOf, listOf } from "../envelope.js"
import { queryHelp, queryTerms, withQuery } from "../list-query.js"
import {
  bindQuery,
  documentQueries,
  FACT_QUERY,
  factItem,
  identityRow,
  linkRow,
  MEMORY_QUERY,
  MEMORY_SEARCH_QUERY,
  memoryItem,
  memorySearch,
  tagRow,
  termsOf,
} from "./queries.js"
import { allOf, type DocumentWords, documentsGroup, examples, positive, wordsOf } from "./words.js"

/** The shared knowledge port, and what only the provider knows: a document's context and the accounts seen on it. */
export interface DocumentKnowledgePort extends DocumentKnowledge {
  context(principal: string, ref: string): Promise<unknown>
  /**
   * The accounts seen on the document, as `identity` rows (`remote_id`, `provider`, `role`, `person`), filtered by
   * `role` and `remote_id` as `identities list` names them.
   */
  people(principal: string, ref: string, filter?: Record<string, string>): Promise<unknown>
  linkPerson(principal: string, ref: string, remoteId: string, personRef: string): Promise<unknown>
}

export interface DocumentKnowledgeCommands {
  words: DocumentWords
  /** Prints one answer: the CLI's own envelope, keys and `--fields`. */
  output(body: Body): void
  /**
   * Resolves the command's document to its ref and runs `fn` with the selected profile's knowledge. The CLI opens the
   * store and holds the lock its sync takes, so a write never races a sync.
   */
  run<T>(
    input: string,
    fn: (knowledge: DocumentKnowledgePort, principal: string, ref: string) => Promise<T>,
  ): Promise<T>
  /** The imported document `memories extract` reads, with the hash it checks before saving. */
  document(input: string): ImportedSource
  complete(): Complete
  /** Who writes or decides in this run: the owner at a terminal, an agent over MCP. */
  author(): Author
  decider(): Decider
}

const addDocumentKnowledgeCommandsDefinition = (program: Command, helpers: DocumentKnowledgeCommands) => {
  const { run, output, author, decider } = helpers
  const wording = wordsOf(helpers.words)
  const { prefix, text } = wording
  const queries = documentQueries()
  const documentArgument = text.knowledgeArgument
  const scopes = ["personal", "work"]
  const documents = documentsGroup(program, wording)
  examples(
    annotate(documents.command("context"), { effects: LOCAL_READ })
      .argument("<document>", documentArgument)
      .description("show a document with its tags, relationships, notes, memories and editors"),
    [`${prefix} documents context DOC_ID`],
  ).action(async (doc: string) => output(itemOf(await run(doc, (k, p, ref) => k.context(p, ref)))))
  const tags = annotate(program.command("tags"), { effects: LOCAL_READ }).description(
    "label imported documents; labels survive a sync",
  )
  for (const action of ["list", "add", "remove"] as const) {
    const command = examples(
      annotate(tags.command(action), { effects: action === "list" ? LOCAL_READ : LOCAL_WRITE })
        .description(
          action === "list" ? "list a document's tags" : action === "add" ? "tag a document" : "untag a document",
        )
        .argument("<document>", documentArgument),
      [`${prefix} tags ${action} DOC_ID${action === "list" ? "" : " budget q3"}`],
    )
    if (action === "list") {
      bindQuery(command, queries.tags, tagRow).action(async (doc: string, words: string[]) => {
        const filter = termsOf(words, queries.tags, "tags list")
        output(allOf((await run(doc, (k, p, ref) => k.tags(p, ref, "list", [], filter))).map((tag) => ({ tag }))))
      })
    } else
      command
        .argument("<tags...>", "one or more tags")
        .action(async (doc: string, values: string[]) =>
          output(itemOf({ tags: await run(doc, (k, p, ref) => k.tags(p, ref, action, values)) })),
        )
  }
  const relationships = annotate(program.command("relationships"), { effects: LOCAL_READ }).description(
    "connect a document to people, projects, notes and other references",
  )
  bindQuery(
    examples(
      annotate(relationships.command("list"), { effects: LOCAL_READ }).description("list a document's relationships"),
      [`${prefix} relationships list DOC_ID`],
    ).argument("<document>", documentArgument),
    queries.links,
    linkRow,
  ).action(async (doc: string, words: string[]) => {
    const { confirmed, ...filter } = termsOf(words, queries.links, "relationships list")
    output(
      allOf(
        await run(doc, (k, p, ref) =>
          k.links(p, ref, { ...filter, ...(confirmed === undefined ? {} : { confirmed: confirmed === "true" }) }),
        ),
      ),
    )
  })
  examples(
    annotate(relationships.command("add"), { effects: LOCAL_WRITE }).description(
      "connect a document to another reference",
    ),
    [
      `${prefix} relationships add DOC_ID project:PROJECT_ID --kind about`,
      `${prefix} relationships add DOC_ID person:PERSON_UID --kind assigned-to --role reviewer`,
    ],
  )
    .argument("<document>", documentArgument)
    .argument("<reference>", "what it connects to, such as person:<uid>, project:<id> or note:<id>")
    .addOption(
      new Option("--kind <kind>", "how the two relate")
        .choices(["links-to", "about", "evidence", "created-from", "related-to", "assigned-to"])
        .default("related-to"),
    )
    .option("--role <role>", "the part the reference plays, in a word or two")
    .option("--reason <text>", "why the two are connected")
    .action(async (doc: string, to: string, { reason, ...args }) =>
      output(
        itemOf(
          await run(doc, (k, p, ref) =>
            k.addLink(p, ref, { to, ...args, by: decider(), ...(reason ? { evidence: reason } : {}) }),
          ),
        ),
      ),
    )
  examples(
    annotate(relationships.command("remove"), { effects: LOCAL_WRITE }).description(
      "remove one of a document's relationships",
    ),
    [`${prefix} relationships remove DOC_ID LINK_ID`],
  )
    .argument("<document>", documentArgument)
    .argument("<relationship-id>", "id, as relationships list prints it")
    .action(async (doc: string, id: string) =>
      output(itemOf(await run(doc, (k, p, ref) => k.removeLink(p, ref, id, decider())))),
    )
  const notes = annotate(program.command("notes"), { effects: LOCAL_READ }).description(
    "write notes about an imported document",
  )
  const noteArgument = "note:<id> reference, as notes list prints it"
  examples(
    annotate(notes.command("add"), {
      effects: LOCAL_WRITE,
      output: { entity: "note" },
      literal_after_dashes: true,
    }).description("write a note about a document"),
    [`${prefix} notes add DOC_ID "Check the numbers" --title Review`],
  )
    .argument("<document>", documentArgument)
    .argument("<text>", "the note's text")
    .option("--title <title>", "a title for the note")
    .action(async (doc: string, text: string, args) =>
      output(itemOf(await run(doc, (k, p, ref) => k.addNote(p, ref, text, args.title)))),
    )
  withQuery(
    examples(annotate(notes.command("list"), { effects: LOCAL_READ }).description("list a document's notes"), [
      `${prefix} notes list DOC_ID`,
      `${prefix} notes list DOC_ID text:review --limit 10`,
    ]).argument("<document>", documentArgument),
    queries.notes,
  )
    .option("--limit <n>", "how many notes to return", positive, 50)
    .option("--page <n>", "which page to return", positive, 1)
    .action(async (doc: string, words: string[], { page, limit }: { limit: number; page: number }) => {
      const query = termsOf(words, queries.notes, "notes list").text
      const found = await run(doc, (k, p, ref) =>
        k.notes(p, ref, { ...(query ? { search: query } : {}), limit, offset: (page - 1) * limit }),
      )
      output(
        listOf("notes list", {
          items: found.items,
          limit,
          has_more: found.hasMore,
          page,
          args: { document: doc, query: words.join(" ") },
        }),
      )
    })
  examples(
    annotate(notes.command("show"), { effects: LOCAL_READ, output: { entity: "note" } }).description("show one note"),
    [`${prefix} notes show DOC_ID note:NOTE_ID`],
  )
    .argument("<document>", documentArgument)
    .argument("<note>", noteArgument)
    .action(async (doc: string, noteRef: string) =>
      output(itemOf(await run(doc, (k, p, ref) => k.note(p, ref, noteRef)))),
    )
  examples(
    annotate(notes.command("edit"), {
      effects: LOCAL_WRITE,
      output: { entity: "note" },
      literal_after_dashes: true,
    }).description("replace a note's text"),
    [`${prefix} notes edit DOC_ID note:NOTE_ID "Numbers checked" --revision 2`],
  )
    .argument("<document>", documentArgument)
    .argument("<note>", noteArgument)
    .argument("<text>", "the note's new text")
    .requiredOption("--revision <n>", "revision from notes show; a newer note is not overwritten", positive)
    .action(async (doc: string, noteRef: string, text: string, args) =>
      output(itemOf(await run(doc, (k, p, ref) => k.editNote(p, ref, noteRef, text, args.revision)))),
    )
  examples(annotate(notes.command("remove"), { effects: LOCAL_WRITE }).description("delete one note"), [
    `${prefix} notes remove DOC_ID note:NOTE_ID`,
  ])
    .argument("<document>", documentArgument)
    .argument("<note>", noteArgument)
    .action(async (doc: string, noteRef: string) =>
      output(itemOf(await run(doc, (k, p, ref) => k.removeNote(p, ref, noteRef)))),
    )
  const memories = annotate(program.command("memories"), { effects: LOCAL_READ }).description(
    "keep what was learned from a document, with evidence; an agent's stay proposed",
  )
  const memoryArgument = "memory:<id> reference, as memories list prints it"
  const scope = (description: string) => new Option("--scope <scope>", description).choices(scopes)
  examples(
    annotate(memories.command("add"), { effects: LOCAL_WRITE }).description("record a memory about a document"),
    [`${prefix} memories add DOC_ID "The team prefers async reviews" --scope work --kind preference`],
  )
    .argument("<document>", documentArgument)
    .argument("<text>", "what to remember")
    .addOption(scope("whose memory it is: personal or work").makeOptionMandatory())
    .addOption(new Option("--kind <kind>", "what kind of memory it is").choices(MEMORY_KINDS).default("summary"))
    .option("--supersedes <ref>", "a memory:<id> about the same document that this one replaces")
    .action(async (doc: string, body: string, args) =>
      output(
        itemOf(
          memoryItem(
            await run(doc, (k, p, ref) => k.addMemory(p, ref, { body, ...args, status: "proposed", author: author() })),
          ),
        ),
      ),
    )
  withQuery(
    examples(annotate(memories.command("list"), { effects: LOCAL_READ }).description("list a document's memories"), [
      `${prefix} memories list DOC_ID scope:work`,
      `${prefix} memories list DOC_ID kind:preference status:confirmed`,
    ]).argument("<document>", documentArgument),
    MEMORY_QUERY,
  )
    .option("--limit <n>", "how many memories to return", positive, 50)
    .action(async (doc: string, words: string[], { limit }: { limit: number }) => {
      const terms = queryTerms(words, MEMORY_QUERY, "memories list")
      const filters = {
        ...(terms.has("kind") ? { kind: terms.get("kind") as Memory["kind"] } : {}),
        ...(terms.has("status") ? { status: terms.get("status") as Memory["status"] } : {}),
        ...(terms.has("scope") ? { scope: terms.get("scope") as Memory["scope"] } : {}),
      }
      output(allOf((await run(doc, (k, p, ref) => k.memories(p, ref, { ...filters, limit }))).items.map(memoryItem)))
    })
  const memoryActions = {
    show: "show one memory",
    confirm: "confirm a proposed memory as true",
    stale: "mark a memory as out of date",
  } as const
  for (const [action, description] of Object.entries(memoryActions) as [keyof typeof memoryActions, string][])
    examples(
      annotate(memories.command(action), { effects: action === "show" ? LOCAL_READ : LOCAL_WRITE }).description(
        description,
      ),
      [`${prefix} memories ${action} DOC_ID memory:MEMORY_ID`],
    )
      .argument("<document>", documentArgument)
      .argument("<memory>", memoryArgument)
      .action(async (doc: string, memoryRef: string) =>
        output(
          itemOf(
            memoryItem(
              await run(doc, (k, p, ref) =>
                action === "show" ? k.memory(p, ref, memoryRef) : k.memory(p, ref, memoryRef, action, decider()),
              ),
            ),
          ),
        ),
      )
  const search = examples(
    annotate(memories.command("search"), { effects: LOCAL_READ }).description("search a document's memories by words"),
    [`${prefix} memories search DOC_ID reviews scope:work`, `${prefix} memories search DOC_ID "async reviews"`],
  )
    .argument("<document>", documentArgument)
    .argument("<query...>", "words to look for, and scope:personal or scope:work — the fields are below")
    .allowUnknownOption()
    .addHelpText("after", queryHelp(MEMORY_SEARCH_QUERY))
    .action(async (doc: string, words: string[]) => {
      const { text, scope } = memorySearch(words)
      const found = await run(doc, (k, p, ref) => k.searchMemories(p, ref, text, scope))
      output({
        ...allOf(found.items.map(memoryItem)),
        ...(found.hasMore ? { meta: { truncated: true } } : {}),
      })
    })
  annotate(search, { query: defineQuery(MEMORY_SEARCH_QUERY), output: { entity: "memory" } })
  examples(
    annotate(memories.command("extract"), { effects: REMOTE_WRITE })
      .argument("<document>", documentArgument)
      .description("send a document's text to the model and show the memories it proposes"),
    [`${prefix} memories extract DOC_ID --scope work`, `${prefix} memories extract DOC_ID --scope work --yes`],
  )
    .addOption(scope("whose memories they become: personal or work").makeOptionMandatory())
    .option("--tab <id>", "send only this tab of the document")
    .option("--yes", "save the proposals, each with its quote and the document's version")
    .action(async function (this: Command, doc: string) {
      // The root --yes takes the flag wherever it is typed; this one only lists it for help and MCP.
      const args = this.optsWithGlobals<{ scope: Memory["scope"]; tab?: string; yes?: boolean }>()
      await run(doc, async () => undefined)
      const result = await extractDocumentMemories({
        read: () => helpers.document(doc),
        complete: helpers.complete(),
        scope: args.scope,
        author: `${wording.app}-memory`,
        tab: args.tab,
        save: args.yes,
        withWrite: (write) => run(doc, write),
      })
      output(
        itemOf({ ...result, saved: result.saved.map((item) => ("type" in item ? factItem(item) : memoryItem(item))) }),
      )
    })
  const facts = annotate(program.command("facts"), { effects: LOCAL_READ }).description(
    "what happened, as a document shows it; an agent's stay proposed until confirmed",
  )
  const factArgument = "fact:<id> reference, as facts list prints it"
  examples(annotate(facts.command("add"), { effects: LOCAL_WRITE }).description("record a fact a document shows"), [
    `${prefix} facts add DOC_ID "Budget approved" --type decision --scope work`,
  ])
    .argument("<document>", documentArgument)
    .argument("<statement>", "the fact, in one sentence")
    .addOption(new Option("--type <type>", "what kind of fact it is").choices(FACT_TYPES).default("fact"))
    .addOption(scope("whose fact it is: personal or work"))
    .option("--supersedes <ref>", "a decision only: the decision this one replaces")
    .option(
      "--occurred-time <time>",
      "when it happened, as the evidence shows, ISO 8601; a time without a zone is read in this computer's zone, a date alone as its midnight",
    )
    .action(
      async (
        doc: string,
        statement: string,
        {
          occurredTime,
          ...args
        }: { type: (typeof FACT_TYPES)[number]; scope?: Memory["scope"]; supersedes?: string; occurredTime?: string },
      ) =>
        output(
          itemOf(
            factItem(
              await run(doc, (k, p, ref) =>
                k.addFact(p, ref, {
                  statement,
                  ...args,
                  by: author(),
                  ...(occurredTime === undefined ? {} : { occurredAt: occurredTime }),
                }),
              ),
            ),
          ),
        ),
    )
  withQuery(
    examples(annotate(facts.command("list"), { effects: LOCAL_READ }).description("list a document's facts"), [
      `${prefix} facts list DOC_ID status:proposed`,
      `${prefix} facts list DOC_ID kind:decision`,
    ]).argument("<document>", documentArgument),
    FACT_QUERY,
  )
    .option("--limit <n>", "how many facts to return", positive, 50)
    .action(async (doc: string, words: string[], { limit }: { limit: number }) => {
      const terms = queryTerms(words, FACT_QUERY, "facts list")
      const filters = {
        ...(terms.has("kind") ? { type: terms.get("kind") as Fact["type"] } : {}),
        ...(terms.has("status") ? { status: terms.get("status") as Fact["status"] } : {}),
      }
      output(allOf((await run(doc, (k, p, ref) => k.facts(p, ref, { ...filters, limit }))).items.map(factItem)))
    })
  const factActions = {
    show: "show one fact",
    confirm: "confirm a proposed fact; a decision it supersedes stops holding",
    reverse: "an accepted decision no longer holds, and nothing replaced it",
  } as const
  for (const [action, description] of Object.entries(factActions) as [keyof typeof factActions, string][])
    examples(
      annotate(facts.command(action), { effects: action === "show" ? LOCAL_READ : LOCAL_WRITE }).description(
        description,
      ),
      [`${prefix} facts ${action} DOC_ID fact:FACT_ID`],
    )
      .argument("<document>", documentArgument)
      .argument("<fact>", factArgument)
      .action(async (doc: string, factRef: string) =>
        output(
          itemOf(
            factItem(
              await run(doc, (k, p, ref) =>
                action === "show" ? k.fact(p, ref, factRef) : k.fact(p, ref, factRef, action, decider()),
              ),
            ),
          ),
        ),
      )
  const identities = annotate(program.command("identities"), { effects: LOCAL_READ }).description(text.identities)
  bindQuery(
    examples(annotate(identities.command("list"), { effects: LOCAL_READ }).description(text.identitiesList), [
      `${prefix} identities list DOC_ID`,
    ]).argument("<document>", documentArgument),
    queries.identities,
    identityRow,
  ).action(async (doc: string, words: string[]) => {
    const filter = termsOf(words, queries.identities, "identities list")
    output(itemOf(await run(doc, (k, p, ref) => k.people(p, ref, filter))))
  })
  examples(annotate(identities.command("link"), { effects: LOCAL_WRITE }).description(text.identitiesLink), [
    `${prefix} identities link DOC_ID ${wording.remote.toUpperCase()}_ID person:PERSON_UID`,
  ])
    .argument("<document>", documentArgument)
    .argument(`<${wording.remote}-id>`, text.identityArgument)
    .argument("<person>", "person:<uid> reference of someone already known")
    .action(async (doc: string, remoteId: string, personRef: string) =>
      output(itemOf(await run(doc, (k, p, ref) => k.linkPerson(p, ref, remoteId, personRef)))),
    )
}

/**
 * `documents context`, `tags`, `relationships`, `notes`, `memories`, `facts` and `identities` over one imported
 * document of the selected profile: the same commands, options and answers in every documents CLI.
 */
export const addDocumentKnowledgeCommands = honoursDryRun(sharedCommand(addDocumentKnowledgeCommandsDefinition))
