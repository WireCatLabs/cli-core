# Releasing a messenger CLI

The steps max-cli and tg-cli release by, written once. Each CLI's `release` and `test-live` skills
(`.claude/skills/` in that repository) link here and add what is theirs: their changelog headings,
their pages and their live accounts. A messenger CLI is released after the owner says yes (WC-REL-10).

A release is reliable when two halves agree: **`pnpm release:check`**, everything a program can
decide, and **the judgement half**, the steps below. The automatic half is
[`@wirecat/cli-base/release`](https://github.com/WireCatLabs/cli-base#readme). Both CLIs run the same
checks from it and add their own.

## What changed

```sh
prev=$(git describe --tags --abbrev=0)                  # the last released tag
git log --oneline "$prev"..origin/main
gh pr list --state merged --base main --search "merged:>=$(git log -1 --format=%cs "$prev")" --json number,title,body
git diff "$prev"..origin/main -- docs/commands.md       # generated: the exact commands and options that changed
```

The last diff drives everything below. A dependency release (cli-core, cli-base) can change
commands without touching this repository's code. The `docs/commands.md` diff shows it, and
`release:check` fails "tree unchanged" until the page is regenerated.

## The automatic checks

```sh
pnpm release:check
```

One `ok` / `FAIL` line per check. On a branch before the changelog is dated, "version not on npm"
and "changelog" are expected to fail; everything else must pass. **Fix nothing on your own judgement
here.** Report each failure and what it means, then fix it in the release pull request.

## The changelog

Draft the top section from the merged pull requests, by the CLI's changelog rules (its
`docs/dev/CONVENTIONS.md`). Each entry says **what changed as the user sees it, why (unless
obvious), and what to watch for**: who is affected, what can break, what to do. Read each pull
request's body and diff. The title is not enough, and a fix can hide in a pull request titled as
something else. Anything that changes a command's output, an exit code, an option or a config key
goes under the "Changed — may break callers" heading.

## The docs against the diff

For every command and option in the `docs/commands.md` diff, the pages a person reads must describe
it as it now is: the README, `docs/*.md`, and the agent skill in `skills/<cli>/SKILL.md`, which
agents read through `<cli> skill show`.

- Split the pages into groups and give each group to a **read-only** subagent. Give it the changed
  commands, the pages, and the rule "report doc `file:line`, what it says, what is true, the source
  `path:line`; mark CERTAIN or LIKELY".
- **Confirm every finding with a grep or a read of the source before editing.** Drop a LIKELY
  finding you cannot confirm.
- Every page is rewritten in place to the current fact: no correction marks, no struck-out text, no dated trail
  ([WC-DOC-3](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/docs.md#wc-doc-3--every-document-states-current-facts-rewrite-a-wrong-sentence-in-place)). User pages
  carry no internal ids either.
- `docs/commands.md` is generated: never edit it; `pnpm generate`.

## Live checks

The suites never contact a messenger. Live checks are the other half: by hand, on the owner's real
accounts, before a release. **A mistake sends a message to a person.**

- **Only with the owner's yes, in this session**, for the list of checks shown to them. A check not
  on the approved list is not run.
- **Only the checkout's own wrapper**: `bin/tg` or `bin/max`, never `node dist/bin/<cli>.js`. The
  wrapper keeps config, state, cache and the message store inside the checkout. The bare build opens
  the owner's real store, and a branch's schema can migrate it. The wrapper reuses a copied login;
  `session start` would be a new device on the real account.
- **Only the test chats in the CLI's private cast.** Never a real person's chat, not even to read it
  for a check.
- **The shape, never the content.** Record the exit code, whether stdout is exactly one JSON value,
  whether stderr is empty or one diagnostic, and the keys and item counts. Never record message
  text, names or phone numbers:

  ```sh
  live() {
    out=$(mktemp) err=$(mktemp)
    timeout 90 bin/<cli> "$@" --json >"$out" 2>"$err"
    echo "exit=$? stdout_lines=$(wc -l <"$out") stderr_lines=$(wc -l <"$err")"
    jq -c 'if type == "object" then {keys: keys, items: (.items | length?)} else {type: type} end' "$out" 2>/dev/null
    jq -c '.error.code?' "$err" 2>/dev/null
    rm -f "$out" "$err"
  }
  ```

- **A write is proven on the other side.** A message sent from one account is read back, by id, from
  the other. Pacing matters: a burst of writes gets the account rate-limited.
- **A command that does not exit is a failure.** Start a long-running one (`watch`, `serve`, `mcp serve`)
  in the background, take its PID at start (`$!`), and stop that PID, never by name.
- **Snapshot before a change, restore the exact value after, and read it back.** Keep the value in a
  shell variable, not a file. What cannot be put back exactly is not run.
- **Messages a check sent are deleted after.**
- `pnpm smoke:live` is one write of each kind in Saved Messages, cleaned up after. It needs the same
  yes. Any `FAIL` stops the release until the owner rules on it, even one caused by the account's
  state rather than the build. To show the code did not change, run
  `git diff --stat v<prev>..HEAD -- <the paths that step exercises>`.

## Reviewing against the rules

Read the changed code against the CLI's own constraints in its `CLAUDE.md`. Constraints with a
mechanical guard (stdout carries data only, no library type above the adapter, the test sandbox)
passed in `release:check`. Review the rest by reading: nothing sends unless the typed command asked
for it, every exit path closes what it opened, no message, token or phone number reaches a log, a
fixture or a document. Mark each one **holds** or **broken**, with `path:line`. A broken one stops the
release.
