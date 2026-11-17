### Fixed

- `--source documents` names every documents account (Google Drive, Notion) beside the imports that hold documents.
  Drive and Notion accounts are stored and searched as notes folders, so the word missed them before.
- A search whose `--source` is one word that names no account in the store fails with the words that do name
  something. Beside other entries, or in a group, the word stays a skipped entry the answer reports, as before.
