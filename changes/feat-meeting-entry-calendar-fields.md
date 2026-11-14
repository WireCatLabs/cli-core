### Added

- **`meeting_entry` carries what the calendar knows about the invitation.** Each calendar source has the copy's own
  page (`page_url`, Google's `htmlLink`, `https` only), the owner's answer in that calendar (`own_response`) and the
  conference's product (`conference`). Each participant has their `response` (`null` for a meeting's participant).
  A row has `series_id` and `recurrence` (the series' `RRULE:` line), and `meeting_entry_details` lists the calendar's
  Drive files under `attachments`. memo's `meetings list|show` and WireCat Desktop's meeting card read them.
