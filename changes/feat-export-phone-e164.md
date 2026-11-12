### Added

- **`e164Of`, `PHONE_COUNTRIES` and `PhoneCountry` are exported from the root entry.** A tool that reads phone numbers
  from a source with a known country (a PBX's call records, a CRM) turns `89161234567` with region `ru` into
  `+79161234567`, the same `phone:` identity the messengers and CRMs give that person. `e164Of(phone, region)` gives
  `null` for a national number when no region is given and nothing for text that is no phone.
