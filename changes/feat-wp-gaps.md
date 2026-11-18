### Added

- **`serviceApiWriter`: a write from code through the `api` group's own guard.** A content command that publishes or
  deletes through a generated manifest now checks the same keys as `<cli> api <operation>`: `api.<operation>` and
  every manifest key the call sets off (`posts.publish`, `posts.delete.force`), at the profile's levels, with the same
  question and journal line. `confirmed` names keys the command already asked about in this run, so a person is
  asked once; a `deny` or `readonly` on them still stops the write. The writer checks parameters and the body against
  the schemas as the command does, and refuses a query parameter or header the operation does not declare (a
  method override among them), so it reaches no further than the command.
- **`serviceApiCall(…).withHeaders` gives a read's response headers**, and `nextPage` takes them: a page style with
  `pagesHeader` (WordPress's `X-WP-TotalPages`) stops at the last page instead of asking for one past the end, which
  WordPress refuses. `items: ""` reads the answer itself as the list, and `start` is the first page's number, so
  `api … --all` on such a read needs no `--page`. `nextPage`, `PageStep` and `underBase` are exported.
- **A manifest key can lift itself with `unless`.** WordPress publishes a scheduled post whose `date` moves into the
  past; the generated key on `date` and `date_gmt` applies unless the call itself sets `status` to draft, pending or
  private. Such a field counts once sent, `null` included, as WordPress resets a null date to now. A flag now counts in
  the body or the query, as WordPress reads both.
- **`manifestVerify` checks a sign-in on the owner's own site.** For a service on the owner's site (WordPress), the
  check goes to the site `session start --site` names, and its `fetch` gets that site, as its host is not among the
  CLI's own. A `fetch` that takes one argument still works.
- **`wirecat.config.ts` takes `spec.kind: "wp-json"` and `auth.preset: "app-password"`** for a WordPress CLI made with
  `new --from-config`.

### Security

- **A sign-in never leaves the server's path.** For a site under a path (`host/blog`, a WordPress multisite in
  subfolders), `--all` refuses a next page outside the base URL's path, not only outside its origin, and the `api`
  group, the writer and `serviceApiCall` refuse to sign a request outside it, and a signed request to a site (a server
  with free variables) follows no redirect. `hostsFetch` takes a `credentialScope`
  that refuses a signed request outside it and drops the sign-in on a redirect out of it (cli-base `hostFetch`).

### Changed — may break callers

- **`--all` refuses a next link outside the server's path.** A service whose links point to another path on the same
  host (a `/v2` link from a `/v1` server) now stops with `invalid_response` instead of following it.
- **Requires `@wirecat/cli-base` 0.120.0** for the new page style fields and `unless`.
