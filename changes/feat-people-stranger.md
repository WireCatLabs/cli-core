### Changed — may break callers

- **`people.list` has a `stranger` kind**: a named person with no tie to the owner, such as an author seen only in a
  big group. `unsorted` now holds only people with nothing to show as a name. `kind: "stranger"` lists them, `all`
  includes them, and `counts` counts them.
