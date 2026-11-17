### Added

- **One CLI can serve a service that runs on each owner's own site, a profile per site.** `tokenSessionCommand` takes
  `site: { example }`: `session start --site blog.example.com` checks the token on that site and keeps the site
  beside the profile's account, so a token only goes to the site it signed in to; `session status` shows it.
  `serviceApiCommand` takes `serverVariables`, read when a call is sent, and `serviceApiCall` takes it too: give both
  `signedInSite(app, resolveSettings)`, and the manifest's free `{site}` becomes the profile's site. `api list` and
  `api show` work before sign-in. Build the fetch per run with the site's host in `hostFetch`. `recalledSite`,
  `rememberSite` and `siteValue` are exported. A site is https only, a host with a port or a path, never a user name,
  query or fragment.
