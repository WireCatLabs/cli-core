### Fixed

- **A CRM's own address field is copied.** A typed entry of type `location` (Attio) was skipped, so the field never
  reached the store. It is now one line of the parts present, street to country, and a search finds the record by its
  city. See [CRM.md](../docs/dev/CRM.md).
