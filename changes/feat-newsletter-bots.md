### Changed — experimental

- **A sender of a newsletter only is a bot, a human author too.** The owner's ruling of 25.11.2026, in place of the
  earlier one that kept a human-written newsletter a person. A person all of whose mail came from a list (List-Id,
  List-Unsubscribe, a one-click unsubscribe, a Feedback-ID, bulk `Precedence` or the bulk box), with no tie to the
  owner, no messenger identity and no discussion list among their mail, moves to a bot with the reason
  `newsletter-only` on the next people list; `kindSignals` names `newsletter-only`. Its mail stays typed `newsletter`:
  a newsletter's bot is not a program for the mail types. A rule's newsletter bot goes back to a person once the owner
  writes to it, as before, and also once a mail written to the owner alone (no list headers, at most a small group in
  To and Cc) comes from it; the newsletter's own mail keeps reach `broadcast`. The owner's `moveToPerson` and
  `moveToBot` and the sorting rules still win. The people list works out every kind again once after the upgrade.
