### Changed — may break callers

- **A pair of people the owner rejected is proposed again on new evidence.** It is still never joined
  automatically, and the evidence the owner rejected never proposes it again. New evidence is a signal and pair of
  identities none of its rejected proposals had: a phone-based proposal rejected, and later the same email on both
  people, opens a fresh `identity_link` proposal from `scanMatches`, from `savePeople`'s same-address join, or from
  `proposeLink`. Rejecting that one adds its evidence to the rejected set. A pair the owner separated stays blocked.
  `identity.rejected` now means "rejected on this evidence".
- **A role address (`info@`, `hello@`, `support@`…) never joins people automatically**, at import or in a scan, even
  when only two people have it: `scanMatches` proposes the pair instead, so results move from `merged` to `proposed`.
  A no-reply address (`noreply@`, `mailer-daemon@`, `bounces@`…) neither joins nor proposes anyone. The whole local
  part must be a role word, any case, past a `+tag` and `.`, `-` or `_`. `ROLE_ADDRESS_WORDS`, `isRoleAddress` and
  `isNoReplyAddress` are exported from `@wirecat/cli-core`.
