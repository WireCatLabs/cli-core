### Fixed

- A CRM CLI whose live `people list` and `organizations list` are the service's own search (a source from a manifest)
  passes `liveQuery: "words"` to `addCrmCommands`: the lists then take words, and their help no longer promises
  field terms and a Fields table the search cannot take.
- `people show` and `organizations show` read a word as a name when the CRM refuses it as an id with a validation
  error. Attio answered HTTP 400 to `people show "Anna Example"`, and the command failed.
