### Fixed

- **A conversation rebuild no longer spends minutes dropping the old build's vectors.** For each old chunk text the
  check for a current chunk with the same text read every conversation chunk in the store, and the delete that follows
  read the whole vector key; both now use their index. A rebuild of a forum of about 112,000 messages took 889 s and now
  takes 52 s, on the same store and load.
