### Added

- **"This is the company's mailbox" can close every pair on the address at once.** `people.decideLink` with
  `company: { all: true }` turns down every open proposal on the same shared mailbox in one decision, gives the
  address to the one organization, and lists the proposals it closed as `closed` in the decided proposal's result.
  Without `all` it closes only the pair asked about, as before ([ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md)).

- **Every rule's people proposal has a score on one scale**, so `linkProposals({ order: "score" })` lists the
  strongest first. 0.7: a phone two people alone have that does not join them (a CRM's or a card's), one name with a
  phone or an address only they hold, or a rejected pair met on new evidence. 0.5: one name with a chat or a company
  domain in one source, or a meeting guest's typed address. 0.4: each pair on a phone or a personal address three to
  six people share. A shared mailbox stays 0.1 to 0.8. An agent's proposal keeps the agent's own score or none, and an
  account under another name has none. The first people scan after the upgrade reads everything once and fills in the
  score of open proposals made before; decided ones stay as they are ([ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md)).
