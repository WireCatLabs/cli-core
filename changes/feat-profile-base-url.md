### Added

- **One CLI can serve a service that runs on each owner's own site, a profile per site.** `tokenSessionCommand` takes
  `site: { example }`: `session start --site blog.example.com` checks the token on that site and keeps the site in
  the token's own keyring entry, written and forgotten with it, so a token only goes to the site it signed in to.
  `session status` shows the site. `<PREFIX>_TOKEN` needs `<PREFIX>_TOKEN_SITE` beside it. `serviceApiCommand` takes
  `serverVariables`, read when a call is sent, so `api list` and `api show` work before sign-in; give it
  `signedInSite(app, resolveSettings)`, and give `serviceApiCall` that function's value for the command. Build the
  fetch per run with the site's host in `hostFetch`. A site is https only, a host with a port or a path, never a user
  name, query or fragment. A free variable inside a host (`{subdomain}.example.com`) takes one name only.
- **`ProfileTokenStore.write` takes named secrets to keep in the same write, and `readWith` reads the token and one
  named secret from the same place:** both from the environment, or both from the profile's entry.
