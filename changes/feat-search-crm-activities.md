### Added

- **`search all` in a CRM CLI finds a deal or lead by the words of its activities.** The subject and text of each
  stored `crm.activity` (a call, e-mail, meeting, to-do or task) count as the deal's words, beside its title,
  company and contacts: `search all warehouse lease` finds the deal whose e-mail spoke of it. A query that names a
  field is still refused for deals, with the reason now naming activities.
