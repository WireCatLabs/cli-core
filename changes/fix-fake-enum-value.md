### Fixed

- **`crmManifestFake` keeps a written value at a place whose schema lists the values it takes.** It dropped every
  value there and kept its sample, the list's first: a deal written in EUR read back in ARS from Attio's real
  `currency_code`, so `crmManifestWriteContract` failed on Attio's own API description.
