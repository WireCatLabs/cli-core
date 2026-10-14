# Reviewing a pull request in tg, max or here

The checklist a reviewer runs on every pull request in cli-core, tg-cli and max-cli — a person
or a reviewer agent given this page. Its rules are in [STANDARD.md](STANDARD.md); this page is how
to check them. Paste the verdict into the pull request: each line passed, failed with the reason,
or not applicable.

## A. A docs pull request — before any code

A new command, option or output change starts here and merges before its code.

Apply the [external adoption profile](STANDARD.md#external-references-and-our-adoption-profile)
and [compliance audit](CLI-COMPLIANCE.md). Say whether a cited rule is a protocol requirement,
design guidance or our policy; record justified deviations instead of claiming blanket compliance.

1. **Names and placement.** Run [Before creating a command](STANDARD.md#before-creating-a-command):
   its namespace/resource/subresources explain the user task, statistics start with `stats`,
   and a new root is justified against existing groups. The leaf is an approved verb or noun view,
   arguments have the fixed names, and nothing is an alias. A different report is a nested leaf;
   filters and measures are options. The naming wording has the owner's yes in the pull request.
2. **Options.** Each option is in the [catalogue](STANDARD.md#option-catalogue) with one meaning; a
   new one is added to `parity.json` with its value, meaning and default, and `pnpm parity:render`
   was run.
3. **Output.** A list answers the envelope, a write its `operationId`, an error one JSON object on
   stderr with a code from the table ([Output](STANDARD.md#output)).
4. **MCP.** The command is found through `tools_search`, its arguments are the options in snake_case,
   it says whether it writes, and its permission key decides who may run it — no flag of its own
   ([MCP](STANDARD.md#mcp)).
5. **Both CLIs' pages.** The user page of each CLI says the same thing at the same depth, max's in
   Russian and tg's in English ([Documents](STANDARD.md#documents)).
6. **Manifest row.** `parity.json` has the command and its options as `planned`, with who builds them.
7. **Relocations.** The plan lists affected CLI/MCP paths, permissions, saved records, completion,
   skills and generated pages. It preserves output semantics, migrates stored paths explicitly,
   and names the old/new paths in breaking release notes.

## B. A code pull request

1. **Layers.** The command and the MCP tool call one service method; the service calls a port group;
   no command calls an adapter method for a use case a service owns, and no messenger type crosses
   the adapter ([Layers and sharing](STANDARD.md#layers-and-sharing)).
   Check coherent responsibilities, narrow injected ports and explicit resource ownership against
   the [modularity standard](https://github.com/WireCatLabs/cli-base/blob/main/docs/dev/MODULARITY.md).
   Review production modules around 300 lines for separable responsibilities; above 500, split
   them or explain why cohesion warrants their size. Do not apply these guidelines mechanically
   to generated registries or cohesive test cases.
2. **Shared by default.** Code that names no messenger is here, in cli-core, not in a CLI. A
   CLI-local feature is one the other messenger cannot have, and the manifest row says why.
3. **Parity.** The manifest row moves the CLI from `planned` into `in` (or gives the reason it lacks
   it) in the next cli-core release; `pnpm parity:check` is green in the CLI.
4. **Tests.** A test drives the new behaviour through the command, and a failure path is tested;
   max-cli's test matrix lists every new command and option.
5. **Changelog.** An entry under `## Unreleased` with the fixed headings, saying what changed for a
   user or a caller and what to do if it breaks them; no internal ids.
6. **Safety.** Nothing sends, marks read or deletes unless the command asked for it; in machine
   mode stdout carries data alone; the process exits on every path; no message, token or phone
   number reaches a log, a fixture or a document.
7. **Command tree.** The implemented hierarchy matches the approved naming PR. Parent commands
   show help, the leaf is discoverable in both CLIs, and a relocated path/MCP name is removed in
   the same adoption release with its configuration and saved-record migrations.
