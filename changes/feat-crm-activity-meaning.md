### Added

- **`search all` in a CRM CLI finds deals and leads by the meaning of their notes, calls, meetings and tasks.**
  «кто ругался что мы опять затягиваем с запуском» finds the deal whose note says the launch slipped again, in other
  words or another language, with the note's excerpt in the hit, merged by rank with the word hits. An agent no longer
  has to list every note and grep it (cli-testing `performance/crm/hubspot-agents`, round 2). `sync --embed` builds
  the vectors with a model already downloaded, as the tracker's sync does; until then `search all` says it searched
  by words only and names `sync --embed`. A limited profile finds only its own deals, and a profile that denies
  `activities.list` searches by words only. Activities on contacts or companies alone are not found by meaning yet
  ([CRM](../docs/dev/CRM.md#activities-changes-and-the-digest), #3285).
