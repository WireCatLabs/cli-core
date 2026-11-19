### Fixed

- **The shared CRM help fits every CRM.** The `create` and `update` examples set a field by its label
  (`--field Source=web`), not by Bitrix24's own `UF_CRM_SOURCE`. A CRM mounted with `leads: false`, such as amoCRM, no
  longer mentions leads in the descriptions of `sync`, `store status`, `store apply`, `changes`, `fields list` and
  `search all`, nor shows `kind:lead` in its examples.
