### Fixed

- **A content `publish` or `unpublish` asks one question, not two.** A CLI that gives its raw update route the
  content command's own key (WC-PERM-22, as wordpress-cli gives `api posts-update` the key `posts.update`) asked
  `posts.publish`, then `posts.update` again when the write went out. Publishing is sent as an update, so a yes to
  `publish` or `unpublish` now counts for that route's `update` key. A yes to `update` still does not count for a
  publish key, so updating a published post asks for it as before.
