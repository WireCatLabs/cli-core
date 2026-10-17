# CLI conventions and agent compatibility audit

How the CLIs meet the conventions and agent-compatibility profile, and what is checked. This page
does not claim third-party certification or full POSIX conformance.

No real session, keyring, messenger, browser login or account data was used by the audit,
regression suite or agent evaluations. Tests use isolated synthetic fixtures.

## Adoption profile and references

The handbook's [WC-CMD-28](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-28--use-the-external-command-line-references-as-a-baseline-and-keep-the-projects-choices-where-they-differ) holds the external
references and the project's chosen profile: POSIX utility conventions, GNU interfaces, CLIG,
MCP tools, Agent Skills, JSON Schema and agent tool-design guidance. The independent
[CLI Agent Spec](https://cli-agent-spec.github.io/requirements/) is a checklist, not an industry
standard; its conformance kit was researched, not executed. Our answer envelopes and error taxonomy are the
handbook's ([output](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md)), and we do not claim its Level 1/2/3 labels.

The current POSIX page returned HTTP 403 during research; official indexed conventions and
rationale were consulted. Other references were read directly or through official indexed
content. [ACP](https://agentclientprotocol.com/get-started/introduction) connects editors and
coding agents and is outside this messenger CLI's role. The
[Google Workspace CLI example](https://github.com/googleworkspace/cli/blob/main/CONTEXT.md)
informed schema lookup, previews and field selection; it is not an officially supported
Google product and was not installed or exercised in this audit.

## Implemented controls

| Control | Evidence | Result and limits |
|---|---|---|
| Machine errors | `src/cli/program.ts`, `src/errors/failures.ts`, shell and consumer integration tests | Commander usage errors become validation_error/exit 2. Explicit JSON/JSONL overrides TTY error rendering; one JSON error goes to stderr without appended help. |
| Discovery purity | shared shell tests, consumer update hooks | Requested help/version and scoped discovery run without business preparation or update/network notices. Help/version remain successful text output. |
| Command hierarchy | `src/cli/messenger/stats-command.ts`, STANDARD command checklist | Statistics use `stats messages show`, `stats chats show`, `stats tasks show`; charts remain `stats charts`. Old resource stats paths have no aliases. Permission migration is explicit and fails closed on stale keys. |
| Headless input | `src/cli/input-policy.ts`, `src/terminal/prompt.ts`, consumer login/setup seams | `--no-input`, JSON/JSONL, CI and off-TTY execution suppress terminal prompts and interactive browser login. Explicit piped input remains available. Setup may verify existing credentials; provider-specific noninteractive login requires explicit inputs. |
| Input bounds | shared input and secret tests | Buffered stdin defaults to 16 MiB; secret input is capped at 64 KiB. UTF-8 bytes, EOF, cancellation and listener cleanup are checked. Streaming file export retains its own contract. |
| Execution and cleanup | `src/cli/execution.ts`, `scripts/check-agent-process.ts`, lifecycle tests | One-shot default is 30 seconds; explicit timeout overrides it. Persistent commands and an interactive login at a terminal have no default deadline; an interactive command without a terminal gets 5 minutes; `untilStopped()` ends the deadline for a phase that Ctrl-C ends with 0. Interrupted one-shot commands use 130, SIGTERM uses 143; Ctrl-C normally stops persistent commands with 0. EPIPE closes quietly, during the run and after it, and ends a relayed run with 0. |
| Schema/effect discovery | `src/cli/command-contract.ts`, `commands schema` tests | Versioned JSON Schema 2020-12 describes argv, defaults, choices, constraints, permissions, effects and conservative retry guidance. Result coverage is explicit: representative domain schemas are precise, remaining results use open schemas. JSONL coverage is described separately. |
| Output bounds/projection | execution and projection tests | Machine output defaults to 4 MiB, configurable or disabled with 0. `--json=<fields>` projects safe paths, including `items.id`, while retaining envelope metadata and operation ids. Oversize output fails before malformed JSON; JSONL reports earlier complete rows. |
| Write previews | `src/cli/preview.ts`, consumer integration tests | General dry-run validates parsing and permissions before preparation/action/reservation, hides payloads and states that targets remain unresolved and business validation has not run. Specialized command previews retain their existing semantics. |
| Retry and unknown writes | send guard/journal and execution tests | `operation_id` correlates a write; it is not an idempotency guarantee. Unknown outcomes carry conservative retry metadata. Aborted work cannot reserve a new write; inspect the journal/provider before any retry. |
| MCP surface/results | `src/mcp/surface.ts`, personal/bot server tests | Three discovery/read/write tools replace per-command tools. Actual object results have structured content and advertised open-object output schemas; response and argument bytes are bounded. No server confirmation forms; deny/readonly still block writes. Separate moderation rule consent remains authoritative. |
| Portable skills | `src/skills/validate.ts`, consumer `check:agent-docs` | YAML frontmatter, local references, installed version and literal command paths are checked against the consumer program. Full arbitrary shell examples and every operand are not statically proven. |
| Synthetic agent evaluation | evaluation report | Two independent agent passes used synthetic discovery, ambiguity, paging, validation recovery, compact reads and unknown-write tasks. Final pass: 6/6 tasks, 14 calls, 14,846 output bytes, no write replay. Fixture differences prevent a causal before/after claim. |

## Verification and intentional limits

Shared checks include lint, typecheck, the full sandboxed test/coverage suite, documentation
checks, Node/Bun CI and real child-process signal/stdin/EPIPE probes. Consumer adoption additionally
requires their full tests, generated command/matrix checks, parity, public documentation checks,
skill/key-reference validation and CI at the exact PR head.

This is a selected adoption profile. Immediate breaking relocation without deprecation is an
owner-approved divergence from CLIG guidance. There is no blanket ANSI-free promise for help,
QR or trace output. Preview does not resolve a remote target or guarantee future remote state.
Open result schemas honestly report incomplete static coverage. The synthetic agent evaluation
measures six representative tasks, not every provider command or every model.

## Queue status

1. Machine error consistency: implemented and published; consumer integration verified.
2. Headless execution and bounds: implemented; native consumer login seams verified.
3. Statistics relocation: implemented without aliases; consumer docs and generated references updated.
4. Schema/effect discovery: implemented with explicit result coverage and separately versioned discovery.
5. Bounded output and previews: implemented; consumer integration tests cover the exposed controls.
6. Guidance and evaluations: implemented; portable consumer skills pass validation and the independent report is public.

## Consumer source adoption

| Consumer | Adopted runtime | Validation |
|---|---|---|
| [MAX PR438](https://github.com/WireCatLabs/max-cli/pull/438), [PR441](https://github.com/WireCatLabs/max-cli/pull/441) | SDK 0.161.0, core 0.17.2 | 1,473 tests passed, 2 skipped; 92.15% line coverage; matrix 700 tested / 100 justified / 0 missing. |
| [Telegram PR309](https://github.com/WireCatLabs/tg-cli/pull/309) | SDK 0.161.0, core 0.17.2 | 1,158 tests passed, 1 skipped; 95.05% line coverage; matrix 2,086 tested / 51 justified / 0 missing. |

Both consumer changes passed lint/typecheck, generated references, parity, public docs and
skill/configuration-reference checks. Exact PR-head CI includes Linux, macOS, Windows,
Bun and package checks. Native MAX cancellation tracks and closes its connection; its bot
transport reports in-flight writes to the shared execution scope. Native Telegram login and
optional setup questions respect the input policy, including explicit QR-file login.

User documentation now separates the short configuration guide from the complete key/type/
default/scope/environment reference, and links a public CLI contract from navigation. Their
architecture pages link the shared standards profile. The parity manifest marks the adopted
controls and canonical statistics paths as implemented; the separate rankings feature remains planned.

Live account checks and consumer binary publication are outside this audit.
