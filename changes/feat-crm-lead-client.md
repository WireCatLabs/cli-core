### Added

- **A deal or a lead keeps the person and company its CRM holds on the item itself.** A lead often has no contact or
  company linked yet; its own name and company were all it said of who it is, and they were dropped. `CrmItem` takes
  `contactName` and `companyName`, the store keeps them, `deals show` and `leads show` answer them as `contact_name`
  and `company_name` (marked untrusted, as a CRM's users or a web form wrote them), the CSV export has both columns, and
  `search all` finds the item by them, the name as a contact and the company as a company. See
  [ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md).
