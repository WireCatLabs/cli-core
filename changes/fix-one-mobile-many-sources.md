### Fixed

- **One mobile number a CRM contact, a WhatsApp account and a call each have now joins them into one person**, with
  no proposal for the owner. Before, three holders of a number counted as three people on a shared line, so
  the scan proposed each pair at 0.4 and an agent's `people.agentLink` answered `weak: "shared"`. Holders that each come
  from a different source are one person's number; two holders from one source, such as two contacts of one CRM,
  still make it a shared line.
- **A proposal still open for a pair no longer stops the scan joining it** when the pair now meets a join rule
  (the join settles the proposal). The first scan after upgrading reads every number again, so pairs left as
  proposals before join now.
