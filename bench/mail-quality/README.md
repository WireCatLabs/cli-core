# Mail meaning search: how to cut and clean email

Mail was embedded per thread, in pieces of 1,200 characters that overlap by 150, with greetings,
sign-offs, signatures and re-quoted text left out ([mail-text.ts](../../src/conversations/mail-text.ts)).
Those were common practice, not measured; after this measurement mail is cut per email, cleaning kept. This benchmark compares them with the alternatives on an
entirely synthetic mail set: [corpus.json](corpus.json), invented people and companies only.

## Variants

36 variants, every combination of:

- **unit** — `thread`: a thread cut greedily from its oldest email, as the store does; `email`: each
  email alone, with its subject.
- **size** — 600, 1,200 or 2,000 characters a piece.
- **overlap** — 0, 150 or 300 characters: how much of the previous email opens the next piece of a
  thread, and how much the pieces of one long email share. Per email, only the second applies.
- **cleaning** — `rules`: production `mailCore`; `off`: the body as stored.

A model-based line classifier, the third cleaning option the backlog names, is not measured: it means
building and training one first, a separate task.

## Method

One real e5-small session on eight threads; the model files are checked against the pinned catalogue.
No account is opened and no network request is made. Each query ranks every piece by cosine, then:

- **email** — pieces map to emails as the store's `nearest` maps them: a piece stands for the newest
  email in it. A thread piece that holds the answer in an earlier email therefore counts as a miss
  for that email; this is the cost thread pieces can have.
- **thread** — threads by their best piece.

Recall@5 and MRR are averages over the queries of one split; every query has an answer. The runner
asserts that the production variant (email, 1,200, 150, rules; thread until the switch) cuts exactly
the pieces the store cuts for the same mail, so the benchmark cannot drift from production unnoticed.

Pieces, characters and pieces longer than the model's 512 tokens (whose end the model never reads)
are counted per variant. Vector bytes are calculated, pieces × 384 × 4, not measured. Vectors are
cached across variants, so embedding time is reported once, as characters per second.

**Decision rule, fixed before the first run:** the defaults change only if a variant beats the
production variant on email recall@5 by at least three queries on dev **and** on test, without a
lower email MRR on either. A smaller difference is within what one or two queries can swing, and
the defaults stay.

## Reproduce

At the repository root, with the shared model already installed:

```sh
pnpm build
pnpm exec tsc -p bench/mail-quality/tsconfig.json
node bench/mail-quality/run.ts > bench/mail-quality/results.json
```

The store check leaves a temporary store in the system temp directory; removing it is a separate
cleanup step.

### On a real mailbox

[export-store.ts](export-store.ts) turns one mailbox of a store, read from a copy, and its owner's questions into a
corpus of the same shape; `MAIL_CORPUS` points the runner at it and `MAIL_VARIANTS` narrows the 36 variants, since a
mailbox of thousands of emails takes hours to embed every way:

```sh
node bench/mail-quality/export-store.ts --store <db> --account <address> --queries <questions.json> > <corpus.json>
MAIL_CORPUS=<corpus.json> MAIL_VARIANTS=email/1200/150/rules,thread/1200/150/rules \
  node bench/mail-quality/run.ts > <results.json>
```

The corpus holds the mail's text and the questions say what the owner looks for: both stay private, as do the
results, which name the questions by id.

## Measured results

2026-10-11, AMD Ryzen AI 9 HX 470, 24 threads, Node 24.19; corpus hash and every rank are in
[results.json](results.json). 39 threads, 130 emails (30 threads of more than one email), 86 queries
in English, Russian and Spanish, 43 dev and 43 test. The store check passed: the production variant
cuts the same pieces the store cuts. Embedding ran at about 15,000 characters a second.

Hits in the top five, out of 43 queries per split, with cleaning by rules:

| Unit | Size | Overlap | Pieces | Email dev | Email test | Email MRR dev / test | Thread dev | Thread test |
|---|---|---|---|---|---|---|---|---|
| thread | 1,200 | 150 | 62 | **24** | **25** | 0.529 / 0.538 | 41 | 39 |
| thread | 600 | 150 | 137 | 30 | 33 | 0.571 / 0.631 | 39 | 41 |
| thread | 2,000 | 150 | 49 | 23 | 22 | 0.484 / 0.482 | 40 | 39 |
| email | 600 | 0 | 163 | **41** | **40** | 0.778 / 0.862 | 43 | 40 |
| email | 1,200 | 150 | 142 | 40 | 39 | 0.759 / 0.830 | 42 | 39 |
| email | 2,000 | 150 | 134 | 40 | 39 | 0.746 / 0.817 | 40 | 39 |

The first row was production when measured; the fifth is production now. All 36 variants are in the
JSON.

**Per email finds the right email far more often; per thread finds the right thread no more often.**
Production found the email that holds the answer for 24 and 25 queries; the same size cut per email
found 40 and 39, with a higher MRR on both splits. That passes the decision rule by a wide margin.
Both units find the right thread for about 39–43 queries, so thread pieces buy nothing there.

The loss is how a thread piece is read back: it stands for its newest email, and an answer in an
earlier email of the piece is reported as a later one. Eight of the 31 queries that production misses
and per email finds were checked by hand: the label is right, the answer is in the email's own text,
not a quote, and none of the eight is the last email of its thread. On the near-duplicate
threads both units find the right thread for all 13 queries, so the subject, which per email repeats
on every piece, is not what decides it.

*After the first run, not part of the decision rule:* crediting every email of a piece instead of
only its newest raises production to 37 and 37, still below per email. Its MRR is not comparable,
since a piece of three emails takes three of the five places.

**Overlap and size barely matter per email.** 600, 1,200 and 2,000 characters are within one query
of each other, and so are overlaps 0, 150 and 300: few emails are long enough to be split. Per thread,
smaller pieces help, because a piece then spans fewer emails.

**Cleaning helps per email.** Rules against the body as stored: 40/39 against 39/39 hits at 1,200,
MRR 0.759/0.830 against 0.709/0.761, with half the characters embedded. Per thread, cleaning *lowers*
email hits, because a cleaned thread packs more emails into a piece.

**Pieces over 512 tokens**, whose end the model never reads, appear only at 2,000 characters: 2 per
thread with cleaning and up to 16 without; 1 per email with cleaning and 3 without.

**Limits.** The corpus is small, synthetic and written knowing what is measured; each query labels one
email. A real mailbox is mostly single-email threads (one measured: 894 of 930), where the two units
cut the same pieces, so the gap on real mail is far smaller than on this corpus, where 30 of 39
threads hold more than one email.
