### Changed — may break callers

- **`activities create --subject person:<n>` and `organization:<n>` name the copy's record, as `deals show` gives it
  and `people show` reads it.** They named the CRM's id, so in a CRM that numbers its records a reference taken from
  `deals show` put the note on someone else's contact or company. A contact or company by the CRM's id, as
  `people list` prints it, is now `person:crm:<id>`. An id that cannot be a reference, such as Attio's UUIDs, works
  as before. A reference that stands for more than one CRM record is refused with `crm.record-ambiguous`, one the
  copy does not hold with `not_found` naming the `crm:` form.
