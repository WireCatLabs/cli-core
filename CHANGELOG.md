# Changelog

Notable changes to `@wirecat/cli-core` (`@wirecat/cli-messaging` up to 0.261.0, `@leemour/cli-messaging` up to
0.214.0), one section per version, newest first. Versions follow [semver](https://semver.org/); before `1.0.0` a
minor version may break callers, and says how under "Changed — may break callers". `pnpm docs:check` checks the
shape of this file.

## Unreleased

### Changed — may break callers

- **`--compact` says a day once above its rows in a list in time order.** When a list's rows are sorted by time and
  a day holds three rows on average, a `# YYYY-MM-DD` line opens each day and its rows print only `HH:MM`. A
  1,000-message `messages list` drops from 43 % to 41 % of JSON's tokens (53 % to 52 % of its bytes). A reader that
  parsed `MM-DD HH:MM` from such a row reads the day from the line above it. Searches and other unsorted lists are
  unchanged.
- **An item answer's compact sections share one span line.** The days and zone are printed once, as
  `# <first>…<last> · <zone>` above the first section, not on every section's header (`projects status`,
  `projects evidence`).
- **`projects status` leaves out what the answer already says.** `item.window` is gone (it is `meta.window`). A
  listed item drops `chat` when its `ref` is a message of that chat, drops `basis` when it is `store`, and a promise
  drops `data.source`, which equals its `basis`. `who.name` and a chat row's `role` are left out instead of `null`.
  The promise row of `--compact` prints `basis`. On the E7 fixture JSON goes from 3,998 to 3,676 bytes and compact
  from 1,511 to 1,387.

### Added

- **`knowledge.updateOrganization(organization, { name })` renames an organization**, given as `organization:<id>` or
  by its id; its kind and scope stay. An agent's rename is a proposal for the owner: the `organization_rename`
  proposal kind and `proposeOrganizationRename(store, { organization, name }, by, reason?)`. It shows in `review` as
  an `organization` row (`rename organization:3 to ...`); confirming it renames, rejecting it changes nothing. No
  schema change.

### Fixed

- **`knowledge.organizations` answers a `name:` term.** `ORGANIZATIONS_QUERY` listed `name`, but the store had no
  column for it, so `organizations list name:acme` failed. The match ignores case in any script, and `name:*acme*`
  finds a name that holds a word.