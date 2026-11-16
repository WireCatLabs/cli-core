# The setup flow: how a CLI describes its connection

A CLI describes how a profile connects (which questions, in which order, which check) as one document in the WireCat
setup format, version 1. WireCat Desktop draws it, the terminal asks the same questions, and the docs can render the
same text. Desktop runs no command and opens no link from the document: it only runs `setup show`, `setup apply` and
`setup run apply`, and it checks the document against the JSON Schema first.

## Define the flow

`defineSetup` from `@wirecat/cli-core/cli` takes the CLI's identity, its `settingsFor` configuration, the steps, the
texts and the check. It builds the document and checks it at once, so a wrong flow fails the CLI's own tests:

```ts
import { defineSetup, setupCommand } from "@wirecat/cli-core/cli"
import en from "../setup/texts.en.json" with { type: "json" }
import ru from "../setup/texts.ru.json" with { type: "json" }

export const setup = defineSetup({
  app: IDENTITY,
  configuration,
  requires: ["run"],
  start: "database",
  steps: {
    database: {
      title: "db.title",
      blocks: [
        { type: "input", id: "db_host", setting: "db_host", input: "text", label: "db.host" },
        { type: "input", id: "db", secret: "token", input: "password", label: "db.password" },
      ],
      next: "check",
    },
    check: {
      kind: "run",
      title: "check.title",
      action: "apply",
      next: [{ when: { result: "check", is: "ok" }, to: "done" }, { to: "database" }],
    },
    done: { kind: "done", title: "done.title" },
  },
  texts: { en, ru },
  check: async ({ settings, secrets }) => ({ calls_last_hour: await readNewestHour(settings, secrets.token) }),
})

// in the program's commands, beside configCommand:
setupCommand(setup)
```

`defineSetup` refuses:

- a step that cannot be reached from `start`, a `next` or `to` that names no step, a form or run step with no `next`;
- a setting the configuration does not declare, and `permissions` (the owner sets it with `config set`);
- an input bound to both or neither of `setting` and `secret`, a `password` input without a `secret`;
- a text id that `en` lacks, and an id in another language that `en` lacks;
- a `role` the block type does not have, a `class` outside the reserved names, an unknown `requires` feature;
- a run action other than `apply`, and `options_from` (both are reserved for a later version);
- more than 60 steps, groups or conditions nested deeper than 8, a document over 256 KB.

Image files are checked from the CLI's own test, never at start, so a packaging slip cannot stop every command:

```ts
import { setupFileProblems } from "@wirecat/cli-core/testing"

expect(setupFileProblems(setup, new URL("..", import.meta.url))).toEqual([])
```

Each asset must be a PNG, JPEG or WebP by its first bytes, at most 2 MB, inside the package (links followed).

## The check, and what is saved

`check` is the CLI's own proof that the answers work, the same one its `session start` runs. It gets the profile, the
settings with the answers laid over the file's values, the secrets the path gave, and the sign-in events to report
`progress` on. It must not read the settings from the file: nothing is written before it succeeds. A throw saves
nothing, and a `CliError` it throws is the step's result, which the flow's `result` conditions read by its code.

After the check succeeds, cli-core writes each setting with `config set`'s own path, and keeps each secret in the
profile's keyring entry: the secret named `token` is the profile's token (what `session start` keeps and
`ProfileTokenStore.need` reads); any other name is a named secret beside it (`readSecret(profile, name)`).

A CLI whose `session start` keeps more than the typed secret returns `keep` from the check: `keep.secrets` gives the
value kept for a secret the answers gave (amo keeps the account address and its user beside the token), and
`keep.account` the account the profile is, which `session start` would remember (the profile's name when left out).
`keep` is taken out of the result and never printed. Keeping a secret the answers did not give is a bug in the CLI,
and nothing is written.

Only answers on steps the path visits, on inputs shown there, are checked and saved. An answer on a branch the owner
left is dropped and listed in `dropped`.

A dry run walks as far as the answers go and stops at the first step with a problem; `at` names that step. When Desktop
sends the answers up to the step on screen, a stop past that step means the step passed, and only errors for inputs on
the step on screen are the owner's to fix now. Leaving a saved secret alone sends no secret: the check then uses the one
already kept.

## The commands

| Command | What it does |
|---|---|
| `<cli> setup show --json` | The document. Needs no profile. |
| `<cli> <profile> setup show --json` | The same with `values`: the profile's settings, a kept secret only as `{ "set": true }`. Each input bound to a setting carries that setting's JSON Schema as `schema`. |
| `<cli> <profile> setup apply --dry-run --json` | The answers on stdin, one JSON object (input id → value): the path, `errors` per input id from each setting's own schema, `dropped`. Saves nothing. |
| `<cli> <profile> setup apply --json` | The same, then the check, then the save. |
| `<cli> <profile> setup run apply --json --answer-stdin` | What Desktop runs: the answers are stdin's first line, `progress` and `needs` go to stderr as JSON lines, the result to stdout. |
| `<cli> <profile> setup` | The flow in the terminal, question by question, in the system's language. |

## The format

The document's JSON Schema and three example documents are the fixture Desktop copies with its sha:
[`test/fixtures/setup-v1/`](../test/fixtures/setup-v1/schema.json). `setupJsonSchema()` gives the schema,
`setupDocumentSchema` the valibot one, `setupProblems(document, { settings, v1 })` the checks above as lines.
Unknown keys pass everywhere but in conditions, and a block type from a newer format passes with its `fallback`
text, so an older Desktop still draws the rest.
