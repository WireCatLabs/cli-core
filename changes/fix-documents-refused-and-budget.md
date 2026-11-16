### Fixed

- **A document the sign-in may not read (403) is skipped as a gone one (404) is**, listed among the skipped files with
  the provider's reason. Before, it stayed pending with its error on every sync: the pass never completed, the change
  cursor did not move, and later changes were not read.
- **A documents sync takes the start token, each root's own metadata in a full walk and each page of changes from the
  request budget**, as it does a listing. Before, they were free, so under the MCP's 45 s deadline a provider with
  slow reads ended the first run at the deadline itself, with no time to answer. A root's metadata is kept on the walk, so a run stopped before the
  root's listing does not read it again.
- **`documentSourceContract`'s fault cases follow**: the 403 case requires the pass to complete and the next pass to
  run, and the deadline case requires each run to leave the budget's answer reserve.
