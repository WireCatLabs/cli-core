### Fixed

- **A deal or lead that enters a stage in the same second its `stage-tasks` rules were set now opens its task.** A
  CRM's stage history keeps whole seconds, so such a move read as made before the rules and opened none; the rules
  now count from the start of the second they were set. Bitrix24's live check hit it when it set the rules and moved
  a deal within a second.
