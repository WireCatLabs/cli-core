### Fixed

- **One bad part no longer costs the whole report.** A section, item or health entry that fails the check is left
  out, and the rest is delivered with a last line saying how many were left out ("⚠️ Не показано из-за ошибки
  формата: 2"). `last.json` names them under `report.dropped`, with the reason `report.items-dropped`. Only the
  document's own fields (the JSON, `kind`, `date`, the `sections` list, `tasks`, `scope`) still refuse it. The owner's
  morning digest was lost whole on 2026-11-17 (two meetings) and 2026-11-21..24 (one reply).
- **A time without an offset is read as local time.** An agent writes a meeting's hour as `2026-11-17T10:00:00`; that
  was refused.
