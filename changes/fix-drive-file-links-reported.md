### Fixed

- **A file's own relationship, such as a Drive document's owner, no longer waits for review.** `replaceFileLinks`
  writes an unconfirmed relationship from a document with the document's account, so it is `reported` (what the
  source says) instead of `proposed`. Before, every Drive document's owner and last editor stood in the owner's review
  list. Links the file states that are not relationships, and the owner's own links, are unchanged. A source re-writes
  its links on its next import: `drive <profile> catalog import --offline` moves the stored ones.
