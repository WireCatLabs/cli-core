### Fixed

- **A report's `reply` item no longer needs `since`.** A morning digest whose agent could not date one message was
  refused whole: memo kept no `.report.json`, and the delivery said the digest did not come together. Such a reply is
  now kept and shown without "waiting N days"; a `since` that is not a date is still refused.
