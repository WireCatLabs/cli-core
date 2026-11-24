### Fixed

- **`people` and `organizations` `create` and `update` offer only the flags the CRM's write takes.** A CRM CLI made
  from a manifest offered `--owner`, `--position`, `--email`, `--phone` and `--field` on every contact and company
  write, though the manifest may write none of them: Attio's people take no owner, so `--owner` was first refused by
  `crm.assign-others` and then by the writer. `CrmWriteCapabilities.fields` names the fields each kind takes, and
  `crmManifestWriteCapabilities` fills it. A writer that leaves it out keeps every flag.
