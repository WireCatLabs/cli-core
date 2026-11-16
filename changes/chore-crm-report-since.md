### Changed — may break callers

- **`store.deals.pipeline()` no longer returns `since`**, the UTC day of `window.since`. Read `window.since` (an ISO
  time) instead; memo, the last reader, stopped using it in cli-memo#862.

### Fixed

- **The CRM digest writes its own few words in Spanish too** ("ganada", "nuevo responsable", "contactos nuevos"). It
  had only English and Russian, so an owner in Spanish read English words in a Spanish digest.
