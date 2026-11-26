### Added

- **`messages sync` picks the threads to read again, for a messenger with `ThreadRefresh`** (experimental). A
  messenger whose history leaves thread replies out, as Slack's does, no longer decides itself which threads to read.
  It answers three questions, with all three methods or none: which messages on a history page are roots
  (`threadRootsIn`, from the page alone and not paced), which roots it lists cheaply that may have new replies however
  old the root, such as those sent in the last days (`recentThreadRoots`), and one root's replies after a time
  (`rootReplies`). The sync reads every root it saw on the chat's first read. After that it reads a root from an older
  history page whole, and any other root only from the last read on, when the root's `lastReplyAt` is later. The last
  read's time is taken before the history pages and a minute early, so a reply sent while they are read, or while the
  two clocks differ, is not lost. Each thread is saved as it comes, and a stopped sync reads from the same point
  again. A messenger with `ThreadReplies` alone works as before.
