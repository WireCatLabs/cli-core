# Stemming vs trigrams for word forms — results

Published result, with the setup and the gate: [cli-testing, performance/search/stemming](https://github.com/WireCatLabs/cli-testing/blob/main/performance/search/stemming/README.md).

Does a Snowball stem index (S) find Russian and Spanish word forms better than the trigram approaches?
Ground truth: UD treebanks with human lemmas, one sentence = one message, relevant = holds a token with the
same (lemma, UPOS). Run: `./run.sh` (downloads pinned data into `data/`, keeps the generated corpus in `data/corpus/` for the next run, rewrites everything below the marker).
Every number is measured [run]; the generated sections below hold the details.

## Summary

Recall / precision / F1 / gain. Gain = extra relevant messages found per query vs Exact. 102 lemmas per
language in 3 bands, each queried as the lemma and as an attested form (204 queries). Precision is the
mean over queries that returned anything.

**Russian (SynTagRus, 87k sentences)** [run]

| row | recall | precision | F1 | gain |
|---|---|---|---|---|
| Exact | 0.260 | 0.992 | 0.411 | 0.0 |
| Prefix | 0.916 | 0.739 | 0.818 | 43.9 |
| T0 | 0.311 | 0.955 | 0.469 | 0.3 |
| T1 | 0.686 | 0.518 | 0.590 | 36.1 |
| T2 | 0.315 | 0.883 | 0.465 | 2.9 |
| **S** | **0.881** | **0.839** | **0.860** | 37.8 |
| S+T1 | 0.913 | 0.522 | 0.664 | 46.9 |

Russian GSD (5k sentences) agrees: Exact 0.245 / 0.993, T1 0.771 / 0.654, S 0.862 / 0.874 (F1 0.868) [run].

**Spanish (AnCora, 17k sentences)** [run]

| row | recall | precision | F1 | gain |
|---|---|---|---|---|
| Exact | 0.391 | 0.870 | 0.540 | 0.0 |
| Prefix | 0.984 | 0.620 | 0.761 | 30.5 |
| T0 | 0.408 | 0.867 | 0.555 | 0.0 |
| T1 | 0.854 | 0.440 | 0.581 | 23.2 |
| T2 | 0.563 | 0.799 | 0.661 | 8.4 |
| **S** | **0.956** | **0.693** | **0.804** | 25.8 |
| S+T1 | 0.980 | 0.397 | 0.565 | 30.5 |

Spanish Exact precision is only 0.870 [run]: many words are written the same with a different part of
speech (parte NOUN / VERB), and the ground truth counts those as wrong for every row.

**Cost** — synthetic corpus, databases on tmpfs (RAM), node 24, SQLite 3.53.3 [run]

| index | build 100k | disk 100k | build 1M | disk 1M | query p50 / p95 ms, 1M, ~1% df word | rare word |
|---|---|---|---|---|---|---|
| Exact (today) | 3.5 s | 22 MB | 40 s | 170 MB | 5.3 / 17.8 | 0.31 / 1.24 |
| S | 9.3 s (6.4 s Snowball) | 15 MB | 142 s (93 s Snowball) | 97 MB | 5.3 / 18.9 | 0.34 / 1.45 |
| T1 vocabulary (exists today) | 4.2 s | 34 MB | 26 s | 203 MB | 14.0 / 47.0 (correction + search) | 8.3 / 12.6 |
| T2 (normalized text) | 8.5 s | 58 MB | 66 s | 538 MB | 10.7 / 24.2 | 2.4 / 7.3 |

## Gate §S12 through the store (2026-10-05)

`gate.ts` runs the plan's gate on the product code: migration 15, `fillStems`, the write drain of
`saveMessages`, and the planned exact-first query written as SQL (the compiler is work item 5). Quality
through the store is the "S via store" row in each treebank section.

- **Pass, 6 of 7.** At 1M: fill 28.0 s (≤ 75), of which Snowball 7.6 s (≤ 25); disk 101 MB (≤ 140); ingest
  +22 % with the drain on, the median of 5 rounds (≤ +25; one round moves between +9 and +30 %); 0 exact
  hits missing. Through the store, Russian recall / precision is 0.881 / 0.839 and Spanish 0.956 / 0.691,
  within 0.002 of S [run].
- **Miss: query p95 43.3 ms (≤ 30).** Today's exact query over the same words is already 26.5 ms p95, so the
  target sits just above today's search. Stemmed search costs about 1.6× today's, in line with its larger
  result sets [run].
- **Through the compiler (work item 5, 2026-10-07):** the owner replaced the 30 ms target with "at most 2×
  today's exact search". At 1M a stemmed search takes 39.5 ms p95 against 51.3 ms for `exact:` on the same
  words, and words in over 3 % of messages 347 ms against 351 ms: exact forms fill the first page, so the
  stems are read only when they run out (it was 770 ms before) [run].
- **For the compiler:** the stems set and its bm25 must be computed once. Joined row by row, the same query
  took 420 ms p95 at 100k; materialized, 5 ms [run].

## Recommendation

- **Ship S.** It has the best F1 in both languages [run]. In Russian it raises recall from 0.26 to 0.88 and
  precision stays at 0.84. T1 reaches only 0.69 recall, with precision 0.52 [run]. Today's search, which
  also adds `word*` matches, reaches 0.315 recall in Russian and 0.563 in Spanish [run]. The net-new cost
  at 1M, on top of `message_words` (170 MB, 40 s): +97 MB (about +57%) and +142 s of build, 93 s of it
  Snowball in JS. Query time does not change [run]. S replaces nothing: the T1 vocabulary stays for typos,
  and `messages_fts` (trigram) stays for substrings.
- **T0 does not help word forms.** On lemma queries it gains 0.0–1.2 messages per query, and only when the
  dictionary form never occurs in the corpus [run]. On attested forms the gain is 0.0 in every band [run],
  because a known word is never corrected. T1 (trigram neighbours always on) does find forms, but it also
  pulls in look-alike words, so its precision drops to 0.44–0.65 [run]. S+T1 gains a few points of recall
  over S, but precision falls to the T1 level [run], so do not union them. Keep T1 for typos only.
- **Stem before folding: yes, for Russian.** If the text is folded first (й→и, ё→е) and then stemmed,
  Russian recall drops from 0.881 to 0.785 on SynTagRus and from 0.862 to 0.756 on GSD [run]. Spanish
  barely changes (0.956 → 0.945) [run]. A corollary: query-time expansion through today's vocabulary
  cannot stem before folding, because that vocabulary holds only folded words. So the separate index is
  the right shape. The cost-only expansion row was skipped for this reason.
- **Choosing the language by script is acceptable.** On English (EWT), the Spanish stemmer for Latin
  script still beats Exact on F1 (0.711 vs 0.596): recall 0.462 → 0.648, precision 0.838 → 0.787 [run].
  It does merge more English words that are different: groups of word forms holding more than one lemma
  rise from 352 (2.7%) to 745 (6.5%) [run].
  An English stemmer would do better (F1 0.794) [run], but that needs language detection, not just script.
- **Library:** use the official Snowball 3.1.1 JavaScript, generated from snowballstem/snowball. It has 0
  mismatches on the official Russian and Spanish test vocabularies, and it folds ё itself [run].
  snowball-stemmers 0.6.0 (last release 2016) gets every ё word wrong (112 mismatches), and natural's
  PorterStemmerRu gets 569 wrong [run]. Build cost to fix: Snowball in JS is 65% of the S build
  (93 s of 142 s at 1M) [run]. I think a stem cache per distinct word would remove most of it, because
  1M messages hold only 523k distinct words (not measured).

## Caveats

- Exact is the strict step-1 behaviour. Today's search also adds `word*` matches when step 1 returns fewer
  than a page. That is the extra row "Exact+beginnings" (Russian recall 0.315) [run].
- T0 calls the real `correctWords` with the real `knownTerms` and `termCandidates` (src/store/sqlite/words.ts).
  These run against a database built with the migration's tables. T1 reuses the same `termCandidates`,
  which keeps its built-in limit of 200 trigram candidates. That limit stays in "T1 (no cap)" too.
- T2 here searches the normalized text. Today's `messages_fts` is a trigram index over the raw text and runs
  only as the last step, so in practice it does no better than T2 here.
- In the cost runs the synthetic words are random syllables, so their stems measure only cost.
  Latency is measured on the full-text index alone (`ORDER BY rank LIMIT 20`), without the messages join.
- Some "false merges" are only a difference in how the treebank writes lemmas, not a real error. For example,
  главное/главный, больше/большой, europea/europeo and estados (a proper-noun plural) have separate lemmas,
  but a user would want them merged. So the precision of S (and of Prefix) is a lower bound.
- The SynTagRus licence is CC BY-NC-SA 4.0. It was used locally, and only aggregate numbers and a few short
  words are committed. AnCora is CC BY 4.0; GSD and EWT are CC BY-SA 4.0.

<!-- generated by run.sh below this line -->

## Environment [run]

- AMD Ryzen AI 9 HX 470 w/ Radeon 890M (24 threads), 30 GB RAM, Linux 7.0.0-34-generic.
- node v24.19.0, SQLite 3.53.3 (node:sqlite).
- Stemmer: official Snowball 3.1.1 JavaScript, generated by download.sh from snowballstem/snowball cd195b5 (BSD-3-Clause).
- Treebanks at UD r2.18 commits pinned in download.sh; only aggregates and a few short words are committed.

## Stemmer library check [run]

Official expected output: snowball-data a0ec0d0 `voc.txt` → `output.txt`.

| language | library | words | mismatches | mismatch % | of them with ё |
|---|---|---|---|---|---|
| russian | official Snowball 3.1.1 JS | 49785 | 0 | 0.00% | 0 |
| russian | snowball-stemmers 0.6.0 | 49785 | 112 | 0.22% | 112 — e.g. актёр→актёр (want актер); актёрский→актёрск (want актерск); берёза→берёз (want берез) |
| russian | natural 8.1.1 PorterStemmerRu | 49785 | 569 | 1.14% | 0 — e.g. апельсинничаешь→апельсинича (want апельсиннича); арестуют→арестуют (want арест); ась→ас (want а) |
| spanish | official Snowball 3.1.1 JS | 28378 | 0 | 0.00% | 0 |
| spanish | snowball-stemmers 0.6.0 | 28378 | 9 | 0.03% | 0 — e.g. alineacion→alineacion (want alin); constitucion→constitucion (want constitu); coronacion→coronacion (want coron) |
| spanish | natural 8.1.1 PorterStemmerEs | 28378 | 10 | 0.04% | 0 — e.g. alineacion→alineacion (want alin); constitucion→constitucion (want constitu); coronacion→coronacion (want coron) |

Known words — `stem(lower(word))`, then `normalize()` of that stem (what the index stores):

| russian word | official Snowball 3.1.1 JS | snowball-stemmers 0.6.0 | natural 8.1.1 PorterStemmerRu | official → normalize() |
|---|---|---|---|---|
| квартира | квартир | квартир | квартир | квартир |
| квартиру | квартир | квартир | квартир | квартир |
| квартиры | квартир | квартир | квартир | квартир |
| квартирант | квартирант | квартирант | квартирант | квартирант |
| ёлка | елк | ёлка | елк | елк |
| елка | елк | елк | елк | елк |
| ёлки | елк | ёлки | елк | елк |
| стали | стал | стал | стал | стал |
| сталь | стал | стал | стал | стал |

| spanish word | official Snowball 3.1.1 JS | snowball-stemmers 0.6.0 | natural 8.1.1 PorterStemmerEs | official → normalize() |
|---|---|---|---|---|
| alquilar | alquil | alquil | alquil | alquil |
| alquilo | alquil | alquil | alquil | alquil |
| alquilaron | alquil | alquil | alquil | alquil |
| piso | pis | pis | pis | pis |
| pisos | pis | pis | pis | pis |
| canción | cancion | cancion | cancion | cancion |
| canciones | cancion | cancion | cancion | cancion |
| cancion | cancion | cancion | cancion | cancion |
| año | año | año | año | ano |
| ano | ano | ano | ano | ano |

## Quality — Russian: UD_Russian-SynTagRus r2.18 (CC BY-NC-SA 4.0) [run]

- 87,337 sentences = messages; 790,009 content tokens.
- Tokenizer parity: fts5vocab holds 138,414 terms, the JS tokenizer 138,414.
- Bands by document frequency (sentences holding the lemma), of 37,749 eligible lemmas (content UPOS, ≥ 3 letters, an attested form other than the lemma): rare: df 2–4 (11365 lemmas); medium: df 5–49 (12293 lemmas); common: df 50–5867 (2666 lemmas).
- 34 lemmas per band (seed 42), each asked twice: as the lemma and as a random attested other form.

| row | recall | precision | F1 | gain (relevant msgs/query vs Exact) | retrieved/query | empty answers |
|---|---|---|---|---|---|---|
| Exact | 0.260 | 0.992 | 0.411 | 0.0 | 10.8 | 24/204 |
| Exact+beginnings | 0.315 | 0.945 | 0.473 | 2.9 | 17.3 | 21/204 |
| Prefix | 0.916 | 0.739 | 0.818 | 43.9 | 99.2 | 4/204 |
| T0 | 0.311 | 0.955 | 0.469 | 0.3 | 11.6 | 4/204 |
| T1 | 0.686 | 0.518 | 0.590 | 36.1 | 129.0 | 1/204 |
| T1 (no cap) | 0.830 | 0.512 | 0.634 | 44.0 | 158.1 | 1/204 |
| T2 | 0.315 | 0.883 | 0.465 | 2.9 | 27.9 | 19/204 |
| S | 0.881 | 0.839 | 0.860 | 37.8 | 61.4 | 4/204 |
| S via store (migration 15, fillStems, OR exact) | 0.881 | 0.839 | 0.860 | 37.8 | 61.4 | 4/204 |
| S (fold, then stem) | 0.785 | 0.854 | 0.818 | 29.7 | 51.2 | 9/204 |
| S+T1 | 0.913 | 0.522 | 0.664 | 46.9 | 149.2 | 1/204 |

By band × query type — recall / precision / F1 / gain:

| row | rare lemma | rare form | medium lemma | medium form | common lemma | common form | all lemma | all form |
|---|---|---|---|---|---|---|---|---|
| Exact | 0.22 / 1.00 / 0.36 / 0.0 | 0.48 / 1.00 / 0.65 / 0.0 | 0.30 / 1.00 / 0.46 / 0.0 | 0.21 / 0.99 / 0.35 / 0.0 | 0.29 / 0.99 / 0.44 / 0.0 | 0.06 / 0.98 / 0.11 / 0.0 | 0.27 / 1.00 / 0.42 / 0.0 | 0.25 / 0.99 / 0.40 / 0.0 |
| Exact+beginnings | 0.29 / 0.91 / 0.44 / 0.2 | 0.48 / 0.98 / 0.64 / 0.0 | 0.42 / 0.94 / 0.58 / 1.6 | 0.23 / 0.99 / 0.37 / 0.1 | 0.40 / 0.89 / 0.55 / 14.3 | 0.07 / 0.95 / 0.12 / 1.0 | 0.37 / 0.91 / 0.53 / 5.4 | 0.26 / 0.97 / 0.41 / 0.4 |
| Prefix | 0.91 / 0.80 / 0.85 / 1.9 | 0.97 / 0.78 / 0.87 / 1.4 | 0.91 / 0.72 / 0.81 / 10.6 | 0.96 / 0.77 / 0.85 / 12.4 | 0.91 / 0.67 / 0.77 / 111.8 | 0.84 / 0.70 / 0.76 / 125.4 | 0.91 / 0.73 / 0.81 / 41.4 | 0.92 / 0.75 / 0.83 / 46.4 |
| T0 | 0.47 / 0.83 / 0.60 / 0.7 | 0.48 / 1.00 / 0.65 / 0.0 | 0.36 / 0.94 / 0.52 / 1.0 | 0.21 / 0.99 / 0.35 / 0.0 | 0.29 / 0.99 / 0.44 / 0.0 | 0.06 / 0.98 / 0.11 / 0.0 | 0.37 / 0.92 / 0.53 / 0.6 | 0.25 / 0.99 / 0.40 / 0.0 |
| T1 | 0.64 / 0.50 / 0.56 / 1.2 | 0.77 / 0.56 / 0.64 / 0.8 | 0.70 / 0.42 / 0.52 / 7.5 | 0.77 / 0.58 / 0.66 / 9.0 | 0.65 / 0.44 / 0.52 / 83.6 | 0.59 / 0.61 / 0.60 / 114.6 | 0.66 / 0.45 / 0.54 / 30.8 | 0.71 / 0.58 / 0.64 / 41.5 |
| T1 (no cap) | 0.77 / 0.50 / 0.61 / 1.6 | 0.85 / 0.56 / 0.67 / 1.1 | 0.89 / 0.42 / 0.57 / 9.9 | 0.86 / 0.56 / 0.68 / 10.1 | 0.88 / 0.45 / 0.60 / 110.1 | 0.73 / 0.59 / 0.65 / 131.5 | 0.85 / 0.46 / 0.59 / 40.5 | 0.81 / 0.57 / 0.67 / 47.6 |
| T2 | 0.29 / 0.85 / 0.44 / 0.2 | 0.48 / 0.94 / 0.63 / 0.0 | 0.42 / 0.83 / 0.56 / 1.6 | 0.23 / 0.94 / 0.37 / 0.1 | 0.40 / 0.82 / 0.54 / 14.4 | 0.07 / 0.90 / 0.12 / 1.0 | 0.37 / 0.83 / 0.51 / 5.4 | 0.26 / 0.93 / 0.40 / 0.4 |
| S | 0.90 / 0.87 / 0.88 / 1.9 | 0.96 / 0.85 / 0.90 / 1.4 | 0.87 / 0.81 / 0.84 / 10.2 | 0.90 / 0.85 / 0.87 / 11.3 | 0.86 / 0.84 / 0.85 / 81.0 | 0.80 / 0.83 / 0.81 / 121.2 | 0.88 / 0.84 / 0.86 / 31.0 | 0.88 / 0.84 / 0.86 / 44.6 |
| S via store (migration 15, fillStems, OR exact) | 0.90 / 0.87 / 0.88 / 1.9 | 0.96 / 0.85 / 0.90 / 1.4 | 0.87 / 0.81 / 0.84 / 10.2 | 0.90 / 0.85 / 0.87 / 11.3 | 0.86 / 0.84 / 0.85 / 81.0 | 0.80 / 0.83 / 0.81 / 121.2 | 0.88 / 0.84 / 0.86 / 31.0 | 0.88 / 0.84 / 0.86 / 44.6 |
| S (fold, then stem) | 0.68 / 0.90 / 0.78 / 1.3 | 0.87 / 0.84 / 0.85 / 1.2 | 0.84 / 0.82 / 0.83 / 9.7 | 0.88 / 0.85 / 0.87 / 11.0 | 0.71 / 0.88 / 0.78 / 40.8 | 0.73 / 0.84 / 0.78 / 114.1 | 0.74 / 0.86 / 0.80 / 17.3 | 0.83 / 0.84 / 0.84 / 42.1 |
| S+T1 | 0.91 / 0.50 / 0.64 / 1.9 | 0.96 / 0.54 / 0.69 / 1.4 | 0.90 / 0.42 / 0.58 / 10.5 | 0.93 / 0.58 / 0.71 / 11.8 | 0.92 / 0.46 / 0.62 / 113.9 | 0.88 / 0.63 / 0.73 / 141.8 | 0.91 / 0.46 / 0.61 / 42.1 | 0.92 / 0.58 / 0.71 / 51.7 |

False merges over content tokens — classes (folded form or stem) that hold more than one lemma:

| key | classes | classes with >1 lemma | share |
|---|---|---|---|
| no stemming (folded surface form) | 134,062 | 2,586 | 1.9% |
| Snowball by script (stem, then fold) | 47,163 | 6,679 | 14.2% |

False-merge examples (stem: form (lemma) + form (lemma)), most frequent first: `пот`: потому (потому) + потом (потом); `част`: часть (часть) + часто (часто); `больш`: больше (больше) + большой (большой); `прав`: право (право) + правило (правило); `ряд`: рядом (рядом) + ряд (ряд); `главн`: главное (главное) + главный (главный); `нача`: начала (начало) + начал (начать); `ран`: ран (ран) + ранее (ранее).

Store row: exact hits the stems alone miss 0 of 2193 (the OR with the word index returns them) [run].

## Quality — Russian: UD_Russian-GSD r2.18 (CC BY-SA 4.0) [run]

- 5,030 sentences = messages; 53,412 content tokens.
- Tokenizer parity: fts5vocab holds 29,453 terms, the JS tokenizer 29,453.
- Bands by document frequency (sentences holding the lemma), of 11,029 eligible lemmas (content UPOS, ≥ 3 letters, an attested form other than the lemma): rare: df 2–4 (3077 lemmas); medium: df 5–49 (1879 lemmas); common: df 50–1186 (70 lemmas).
- 34 lemmas per band (seed 42), each asked twice: as the lemma and as a random attested other form.

| row | recall | precision | F1 | gain (relevant msgs/query vs Exact) | retrieved/query | empty answers |
|---|---|---|---|---|---|---|
| Exact | 0.245 | 0.993 | 0.393 | 0.0 | 4.9 | 30/204 |
| Exact+beginnings | 0.347 | 0.926 | 0.505 | 7.0 | 14.0 | 23/204 |
| Prefix | 0.909 | 0.747 | 0.820 | 29.2 | 48.8 | 2/204 |
| T0 | 0.300 | 0.958 | 0.457 | 0.6 | 5.8 | 8/204 |
| T1 | 0.771 | 0.654 | 0.708 | 25.6 | 47.3 | 1/204 |
| T1 (no cap) | 0.841 | 0.630 | 0.720 | 27.7 | 54.9 | 1/204 |
| T2 | 0.348 | 0.853 | 0.494 | 7.1 | 17.8 | 21/204 |
| S | 0.862 | 0.874 | 0.868 | 28.3 | 37.2 | 3/204 |
| S via store (migration 15, fillStems, OR exact) | 0.862 | 0.874 | 0.868 | 28.3 | 37.2 | 3/204 |
| S (fold, then stem) | 0.756 | 0.879 | 0.813 | 24.3 | 32.5 | 8/204 |
| S+T1 | 0.916 | 0.650 | 0.761 | 30.3 | 54.6 | 0/204 |

By band × query type — recall / precision / F1 / gain:

| row | rare lemma | rare form | medium lemma | medium form | common lemma | common form | all lemma | all form |
|---|---|---|---|---|---|---|---|---|
| Exact | 0.19 / 0.98 / 0.32 / 0.0 | 0.53 / 0.98 / 0.69 / 0.0 | 0.30 / 1.00 / 0.46 / 0.0 | 0.18 / 1.00 / 0.31 / 0.0 | 0.20 / 1.00 / 0.34 / 0.0 | 0.07 / 1.00 / 0.13 / 0.0 | 0.23 / 0.99 / 0.37 / 0.0 | 0.26 / 0.99 / 0.41 / 0.0 |
| Exact+beginnings | 0.43 / 0.83 / 0.57 / 0.5 | 0.54 / 0.97 / 0.69 / 0.0 | 0.45 / 0.92 / 0.61 / 1.5 | 0.23 / 0.95 / 0.37 / 1.4 | 0.35 / 0.88 / 0.51 / 38.3 | 0.07 / 0.96 / 0.13 / 0.0 | 0.41 / 0.88 / 0.56 / 13.4 | 0.28 / 0.96 / 0.43 / 0.5 |
| Prefix | 0.89 / 0.71 / 0.79 / 1.8 | 0.99 / 0.79 / 0.88 / 1.2 | 0.95 / 0.73 / 0.82 / 9.9 | 0.95 / 0.71 / 0.81 / 11.2 | 0.86 / 0.75 / 0.80 / 72.8 | 0.82 / 0.79 / 0.80 / 78.5 | 0.90 / 0.73 / 0.81 / 28.2 | 0.92 / 0.76 / 0.83 / 30.3 |
| T0 | 0.43 / 0.78 / 0.56 / 0.6 | 0.53 / 0.98 / 0.69 / 0.0 | 0.37 / 1.00 / 0.54 / 1.6 | 0.18 / 1.00 / 0.31 / 0.0 | 0.22 / 0.97 / 0.35 / 1.4 | 0.07 / 1.00 / 0.13 / 0.0 | 0.34 / 0.92 / 0.50 / 1.2 | 0.26 / 0.99 / 0.41 / 0.0 |
| T1 | 0.77 / 0.46 / 0.58 / 1.5 | 0.89 / 0.55 / 0.68 / 0.9 | 0.76 / 0.67 / 0.71 / 7.0 | 0.75 / 0.69 / 0.72 / 8.0 | 0.75 / 0.76 / 0.76 / 65.2 | 0.71 / 0.79 / 0.74 / 71.1 | 0.76 / 0.63 / 0.69 / 24.6 | 0.78 / 0.68 / 0.72 / 26.7 |
| T1 (no cap) | 0.84 / 0.46 / 0.59 / 1.6 | 0.93 / 0.54 / 0.69 / 1.0 | 0.85 / 0.65 / 0.74 / 8.4 | 0.82 / 0.67 / 0.74 / 8.9 | 0.84 / 0.71 / 0.77 / 71.0 | 0.77 / 0.75 / 0.76 / 75.4 | 0.84 / 0.61 / 0.70 / 27.0 | 0.84 / 0.65 / 0.73 / 28.4 |
| T2 | 0.43 / 0.78 / 0.56 / 0.5 | 0.54 / 0.94 / 0.69 / 0.0 | 0.45 / 0.83 / 0.59 / 1.5 | 0.23 / 0.90 / 0.36 / 1.4 | 0.36 / 0.78 / 0.49 / 38.4 | 0.08 / 0.85 / 0.14 / 0.4 | 0.41 / 0.80 / 0.55 / 13.5 | 0.28 / 0.90 / 0.43 / 0.6 |
| S | 0.82 / 0.80 / 0.81 / 1.6 | 0.92 / 0.86 / 0.89 / 1.0 | 0.94 / 0.89 / 0.91 / 9.7 | 0.89 / 0.85 / 0.87 / 10.5 | 0.82 / 0.90 / 0.86 / 70.4 | 0.79 / 0.93 / 0.86 / 76.8 | 0.86 / 0.86 / 0.86 / 27.3 | 0.86 / 0.88 / 0.87 / 29.4 |
| S via store (migration 15, fillStems, OR exact) | 0.82 / 0.80 / 0.81 / 1.6 | 0.92 / 0.86 / 0.89 / 1.0 | 0.94 / 0.89 / 0.91 / 9.7 | 0.89 / 0.85 / 0.87 / 10.5 | 0.82 / 0.90 / 0.86 / 70.4 | 0.79 / 0.93 / 0.86 / 76.8 | 0.86 / 0.86 / 0.86 / 27.3 | 0.86 / 0.88 / 0.87 / 29.4 |
| S (fold, then stem) | 0.74 / 0.80 / 0.77 / 1.4 | 0.88 / 0.86 / 0.87 / 0.9 | 0.80 / 0.89 / 0.84 / 7.1 | 0.80 / 0.85 / 0.83 / 9.0 | 0.67 / 0.92 / 0.78 / 60.3 | 0.65 / 0.94 / 0.77 / 67.3 | 0.74 / 0.87 / 0.80 / 22.9 | 0.78 / 0.89 / 0.83 / 25.7 |
| S+T1 | 0.89 / 0.46 / 0.61 / 1.8 | 0.96 / 0.53 / 0.69 / 1.1 | 0.96 / 0.68 / 0.79 / 9.8 | 0.93 / 0.66 / 0.77 / 10.9 | 0.90 / 0.76 / 0.83 / 77.1 | 0.86 / 0.80 / 0.83 / 81.1 | 0.92 / 0.63 / 0.75 / 29.6 | 0.91 / 0.67 / 0.77 / 31.0 |

False merges over content tokens — classes (folded form or stem) that hold more than one lemma:

| key | classes | classes with >1 lemma | share |
|---|---|---|---|
| no stemming (folded surface form) | 26,580 | 149 | 0.6% |
| Snowball by script (stem, then fold) | 15,197 | 1,272 | 8.4% |

False-merge examples (stem: form (lemma) + form (lemma)), most frequent first: `част`: часть (часть) + часто (часто); `прав`: права (право) + правило (правило); `сам`: сам (сам) + самых (самый); `друг`: других (другой) + друг (друг); `основн`: основном (основное) + основной (основной); `ряд`: ряд (ряд) + рядом (рядом); `нача`: начал (начать) + начала (начало); `цел`: целью (цель) + целом (целое).

Store row: exact hits the stems alone miss 0 of 994 (the OR with the word index returns them) [run].

## Quality — Spanish: UD_Spanish-AnCora r2.18 (CC BY 4.0) [run]

- 17,662 sentences = messages; 130,133 content tokens.
- Tokenizer parity: fts5vocab holds 37,623 terms, the JS tokenizer 37,623.
- Bands by document frequency (sentences holding the lemma), of 7,260 eligible lemmas (content UPOS, ≥ 3 letters, an attested form other than the lemma): rare: df 2–4 (1867 lemmas); medium: df 5–49 (3364 lemmas); common: df 50–1640 (720 lemmas).
- 34 lemmas per band (seed 42), each asked twice: as the lemma and as a random attested other form.

| row | recall | precision | F1 | gain (relevant msgs/query vs Exact) | retrieved/query | empty answers |
|---|---|---|---|---|---|---|
| Exact | 0.391 | 0.870 | 0.540 | 0.0 | 20.6 | 14/204 |
| Exact+beginnings | 0.563 | 0.869 | 0.683 | 8.4 | 31.3 | 5/204 |
| Prefix | 0.984 | 0.620 | 0.761 | 30.5 | 91.6 | 0/204 |
| T0 | 0.408 | 0.867 | 0.555 | 0.0 | 20.7 | 9/204 |
| T1 | 0.854 | 0.440 | 0.581 | 23.2 | 150.4 | 0/204 |
| T1 (no cap) | 0.941 | 0.431 | 0.592 | 26.1 | 181.4 | 0/204 |
| T2 | 0.563 | 0.799 | 0.661 | 8.4 | 38.8 | 4/204 |
| S | 0.956 | 0.693 | 0.804 | 25.8 | 67.8 | 0/204 |
| S via store (migration 15, fillStems, OR exact) | 0.956 | 0.691 | 0.802 | 25.8 | 67.8 | 0/204 |
| S (fold, then stem) | 0.945 | 0.687 | 0.796 | 24.7 | 66.5 | 0/204 |
| S+T1 | 0.980 | 0.397 | 0.565 | 30.5 | 170.3 | 0/204 |

By band × query type — recall / precision / F1 / gain:

| row | rare lemma | rare form | medium lemma | medium form | common lemma | common form | all lemma | all form |
|---|---|---|---|---|---|---|---|---|
| Exact | 0.23 / 0.61 / 0.34 / 0.0 | 0.59 / 0.94 / 0.73 / 0.0 | 0.47 / 0.80 / 0.59 / 0.0 | 0.36 / 0.96 / 0.52 / 0.0 | 0.49 / 0.90 / 0.64 / 0.0 | 0.20 / 0.89 / 0.33 / 0.0 | 0.40 / 0.80 / 0.53 / 0.0 | 0.38 / 0.93 / 0.54 / 0.0 |
| Exact+beginnings | 0.63 / 0.74 / 0.68 / 1.1 | 0.63 / 0.94 / 0.76 / 0.1 | 0.77 / 0.83 / 0.80 / 4.7 | 0.38 / 0.91 / 0.53 / 0.3 | 0.72 / 0.87 / 0.79 / 28.7 | 0.24 / 0.90 / 0.38 / 15.5 | 0.71 / 0.82 / 0.76 / 11.5 | 0.42 / 0.92 / 0.57 / 5.3 |
| Prefix | 0.99 / 0.63 / 0.77 / 2.1 | 0.99 / 0.64 / 0.77 / 1.1 | 1.00 / 0.53 / 0.70 / 8.7 | 0.97 / 0.54 / 0.70 / 11.3 | 1.00 / 0.68 / 0.81 / 71.6 | 0.97 / 0.70 / 0.81 / 88.0 | 0.99 / 0.61 / 0.76 / 27.5 | 0.98 / 0.63 / 0.76 / 33.5 |
| T0 | 0.34 / 0.64 / 0.44 / 0.3 | 0.59 / 0.94 / 0.73 / 0.0 | 0.47 / 0.80 / 0.59 / 0.0 | 0.36 / 0.96 / 0.52 / 0.0 | 0.49 / 0.90 / 0.64 / 0.0 | 0.20 / 0.89 / 0.33 / 0.0 | 0.43 / 0.79 / 0.56 / 0.1 | 0.38 / 0.93 / 0.54 / 0.0 |
| T1 | 0.83 / 0.39 / 0.53 / 1.7 | 0.95 / 0.46 / 0.62 / 1.0 | 0.88 / 0.38 / 0.53 / 6.8 | 0.84 / 0.40 / 0.55 / 9.5 | 0.82 / 0.45 / 0.58 / 50.5 | 0.81 / 0.55 / 0.66 / 69.6 | 0.84 / 0.41 / 0.55 / 19.7 | 0.86 / 0.47 / 0.61 / 26.7 |
| T1 (no cap) | 0.99 / 0.39 / 0.56 / 2.1 | 0.96 / 0.46 / 0.62 / 1.1 | 0.98 / 0.38 / 0.55 / 8.5 | 0.92 / 0.40 / 0.56 / 10.6 | 0.96 / 0.44 / 0.60 / 61.7 | 0.84 / 0.52 / 0.65 / 72.6 | 0.97 / 0.40 / 0.57 / 24.1 | 0.91 / 0.46 / 0.61 / 28.1 |
| T2 | 0.63 / 0.68 / 0.66 / 1.1 | 0.63 / 0.93 / 0.75 / 0.1 | 0.77 / 0.76 / 0.77 / 4.7 | 0.38 / 0.83 / 0.52 / 0.3 | 0.72 / 0.77 / 0.75 / 28.8 | 0.24 / 0.80 / 0.37 / 15.6 | 0.71 / 0.74 / 0.72 / 11.5 | 0.42 / 0.85 / 0.56 / 5.4 |
| S | 0.97 / 0.67 / 0.79 / 2.1 | 0.97 / 0.68 / 0.80 / 1.1 | 0.98 / 0.63 / 0.77 / 8.6 | 0.93 / 0.67 / 0.78 / 10.9 | 0.97 / 0.75 / 0.84 / 60.9 | 0.91 / 0.75 / 0.82 / 71.4 | 0.97 / 0.68 / 0.80 / 23.9 | 0.94 / 0.70 / 0.80 / 27.8 |
| S via store (migration 15, fillStems, OR exact) | 0.97 / 0.67 / 0.79 / 2.1 | 0.97 / 0.68 / 0.80 / 1.1 | 0.98 / 0.63 / 0.77 / 8.6 | 0.93 / 0.66 / 0.77 / 10.9 | 0.97 / 0.75 / 0.84 / 60.9 | 0.91 / 0.75 / 0.82 / 71.4 | 0.97 / 0.68 / 0.80 / 23.9 | 0.94 / 0.70 / 0.80 / 27.8 |
| S (fold, then stem) | 0.97 / 0.66 / 0.78 / 2.1 | 0.97 / 0.67 / 0.80 / 1.1 | 0.96 / 0.62 / 0.76 / 8.2 | 0.93 / 0.66 / 0.77 / 11.0 | 0.95 / 0.75 / 0.84 / 57.5 | 0.89 / 0.75 / 0.82 / 68.0 | 0.96 / 0.68 / 0.79 / 22.6 | 0.93 / 0.70 / 0.80 / 26.7 |
| S+T1 | 0.99 / 0.34 / 0.50 / 2.1 | 0.99 / 0.40 / 0.56 / 1.1 | 1.00 / 0.34 / 0.50 / 8.7 | 0.93 / 0.35 / 0.51 / 10.9 | 0.99 / 0.46 / 0.63 / 71.5 | 0.98 / 0.50 / 0.66 / 88.5 | 0.99 / 0.38 / 0.55 / 27.4 | 0.97 / 0.41 / 0.58 / 33.5 |

False merges over content tokens — classes (folded form or stem) that hold more than one lemma:

| key | classes | classes with >1 lemma | share |
|---|---|---|---|
| no stemming (folded surface form) | 26,274 | 1,276 | 4.9% |
| Snowball by script (stem, then fold) | 14,215 | 2,851 | 20.1% |

False-merge examples (stem: form (lemma) + form (lemma)), most frequent first: `part`: partido (partido) + parte (parte); `cas`: caso (caso) + casa (casa); `estad`: estado (estado) + estados (estados); `mayor`: mayor (mayor) + mayoría (mayoría); `pas`: pasado (pasado) + paso (paso); `europe`: europea (europea) + europeo (europeo); `mar`: maría (maría) + mar (mar); `plaz`: plazo (plazo) + plaza (plaza).

Store row: exact hits the stems alone miss 2 of 4205 (the OR with the word index returns them) [run].

## Quality — English: UD_English-EWT r2.18 (CC BY-SA 4.0) [run]

- 16,622 sentences = messages; 66,750 content tokens.
- Tokenizer parity: fts5vocab holds 18,711 terms, the JS tokenizer 18,711.
- Bands by document frequency (sentences holding the lemma), of 3,477 eligible lemmas (content UPOS, ≥ 3 letters, an attested form other than the lemma): rare: df 2–4 (959 lemmas); medium: df 5–49 (1539 lemmas); common: df 50–1542 (261 lemmas).
- 34 lemmas per band (seed 42), each asked twice: as the lemma and as a random attested other form.

| row | recall | precision | F1 | gain (relevant msgs/query vs Exact) | retrieved/query | empty answers |
|---|---|---|---|---|---|---|
| Exact | 0.462 | 0.838 | 0.596 | 0.0 | 28.3 | 8/204 |
| Exact+beginnings | 0.681 | 0.811 | 0.740 | 5.8 | 62.3 | 1/204 |
| Prefix | 0.787 | 0.698 | 0.740 | 9.2 | 68.6 | 0/204 |
| T0 | 0.462 | 0.838 | 0.596 | 0.0 | 28.3 | 8/204 |
| T1 | 0.818 | 0.363 | 0.503 | 12.7 | 237.1 | 1/204 |
| T1 (no cap) | 0.865 | 0.349 | 0.498 | 13.5 | 270.1 | 1/204 |
| T2 | 0.678 | 0.773 | 0.722 | 5.3 | 54.3 | 1/204 |
| S | 0.648 | 0.787 | 0.711 | 5.6 | 50.9 | 6/204 |
| S via store (migration 15, fillStems, OR exact) | 0.648 | 0.787 | 0.711 | 5.6 | 50.9 | 6/204 |
| S (fold, then stem) | 0.648 | 0.787 | 0.711 | 5.6 | 50.9 | 6/204 |
| S+T1 | 0.843 | 0.363 | 0.507 | 13.2 | 238.7 | 1/204 |
| S (English stemmer) | 0.899 | 0.711 | 0.794 | 12.7 | 52.9 | 0/204 |

By band × query type — recall / precision / F1 / gain:

| row | rare lemma | rare form | medium lemma | medium form | common lemma | common form | all lemma | all form |
|---|---|---|---|---|---|---|---|---|
| Exact | 0.32 / 0.55 / 0.40 / 0.0 | 0.66 / 0.88 / 0.76 / 0.0 | 0.54 / 0.79 / 0.64 / 0.0 | 0.34 / 0.95 / 0.50 / 0.0 | 0.69 / 0.88 / 0.77 / 0.0 | 0.22 / 0.90 / 0.36 / 0.0 | 0.51 / 0.76 / 0.61 / 0.0 | 0.41 / 0.91 / 0.57 / 0.0 |
| Exact+beginnings | 0.93 / 0.64 / 0.76 / 1.7 | 0.66 / 0.87 / 0.75 / 0.0 | 0.93 / 0.75 / 0.83 / 6.4 | 0.34 / 0.94 / 0.50 / 0.0 | 0.94 / 0.79 / 0.86 / 21.9 | 0.28 / 0.87 / 0.42 / 5.0 | 0.93 / 0.73 / 0.82 / 10.0 | 0.43 / 0.89 / 0.58 / 1.7 |
| Prefix | 0.98 / 0.60 / 0.74 / 1.8 | 0.73 / 0.75 / 0.74 / 0.2 | 0.97 / 0.63 / 0.76 / 6.9 | 0.62 / 0.72 / 0.67 / 3.8 | 0.95 / 0.75 / 0.83 / 22.3 | 0.48 / 0.74 / 0.59 / 20.4 | 0.96 / 0.66 / 0.78 / 10.3 | 0.61 / 0.74 / 0.67 / 8.1 |
| T0 | 0.32 / 0.55 / 0.40 / 0.0 | 0.66 / 0.88 / 0.76 / 0.0 | 0.54 / 0.79 / 0.64 / 0.0 | 0.34 / 0.95 / 0.50 / 0.0 | 0.69 / 0.88 / 0.77 / 0.0 | 0.22 / 0.90 / 0.36 / 0.0 | 0.51 / 0.76 / 0.61 / 0.0 | 0.41 / 0.91 / 0.57 / 0.0 |
| T1 | 0.79 / 0.22 / 0.34 / 1.3 | 0.90 / 0.33 / 0.48 / 0.7 | 0.82 / 0.37 / 0.51 / 4.2 | 0.78 / 0.48 / 0.59 / 9.0 | 0.88 / 0.36 / 0.51 / 18.6 | 0.73 / 0.41 / 0.53 / 42.0 | 0.83 / 0.32 / 0.46 / 8.1 | 0.81 / 0.41 / 0.54 / 17.2 |
| T1 (no cap) | 0.91 / 0.22 / 0.35 / 1.7 | 0.94 / 0.32 / 0.48 / 0.9 | 0.88 / 0.36 / 0.51 / 5.1 | 0.81 / 0.47 / 0.59 / 9.2 | 0.91 / 0.34 / 0.50 / 21.5 | 0.75 / 0.38 / 0.50 / 42.9 | 0.90 / 0.31 / 0.46 / 9.4 | 0.83 / 0.39 / 0.53 / 17.7 |
| T2 | 0.93 / 0.62 / 0.74 / 1.7 | 0.67 / 0.85 / 0.75 / 0.0 | 0.93 / 0.70 / 0.80 / 6.4 | 0.34 / 0.89 / 0.49 / 0.0 | 0.94 / 0.74 / 0.83 / 22.0 | 0.25 / 0.83 / 0.39 / 2.0 | 0.93 / 0.69 / 0.79 / 10.0 | 0.42 / 0.86 / 0.57 / 0.7 |
| S | 0.52 / 0.62 / 0.57 / 0.6 | 0.72 / 0.80 / 0.76 / 0.2 | 0.79 / 0.78 / 0.79 / 3.6 | 0.60 / 0.85 / 0.71 / 3.6 | 0.81 / 0.82 / 0.81 / 8.5 | 0.44 / 0.81 / 0.57 / 17.4 | 0.71 / 0.75 / 0.73 / 4.2 | 0.59 / 0.82 / 0.69 / 7.0 |
| S via store (migration 15, fillStems, OR exact) | 0.52 / 0.62 / 0.57 / 0.6 | 0.72 / 0.80 / 0.76 / 0.2 | 0.79 / 0.78 / 0.79 / 3.6 | 0.60 / 0.85 / 0.71 / 3.6 | 0.81 / 0.82 / 0.81 / 8.5 | 0.44 / 0.81 / 0.57 / 17.4 | 0.71 / 0.75 / 0.73 / 4.2 | 0.59 / 0.82 / 0.69 / 7.0 |
| S (fold, then stem) | 0.52 / 0.62 / 0.57 / 0.6 | 0.72 / 0.80 / 0.76 / 0.2 | 0.79 / 0.78 / 0.79 / 3.6 | 0.60 / 0.85 / 0.71 / 3.6 | 0.81 / 0.82 / 0.81 / 8.5 | 0.44 / 0.81 / 0.57 / 17.4 | 0.71 / 0.75 / 0.73 / 4.2 | 0.59 / 0.82 / 0.69 / 7.0 |
| S+T1 | 0.82 / 0.22 / 0.35 / 1.4 | 0.90 / 0.33 / 0.48 / 0.7 | 0.90 / 0.37 / 0.53 / 6.0 | 0.81 / 0.48 / 0.60 / 9.1 | 0.89 / 0.36 / 0.52 / 19.9 | 0.73 / 0.41 / 0.53 / 42.0 | 0.87 / 0.32 / 0.47 / 9.1 | 0.81 / 0.41 / 0.54 / 17.3 |
| S (English stemmer) | 0.97 / 0.67 / 0.79 / 1.8 | 0.97 / 0.64 / 0.77 / 0.9 | 0.95 / 0.68 / 0.80 / 6.6 | 0.91 / 0.70 / 0.79 / 11.4 | 0.91 / 0.80 / 0.86 / 19.9 | 0.69 / 0.78 / 0.73 / 35.6 | 0.94 / 0.72 / 0.82 / 9.4 | 0.86 / 0.70 / 0.77 / 16.0 |

False merges over content tokens — classes (folded form or stem) that hold more than one lemma:

| key | classes | classes with >1 lemma | share |
|---|---|---|---|
| no stemming (folded surface form) | 12,804 | 352 | 2.7% |
| Snowball by script (stem, then fold) | 11,407 | 745 | 6.5% |
| English Snowball (reference) | 8,904 | 1,200 | 13.5% |

False-merge examples (stem: form (lemma) + form (lemma)), most frequent first: `car`: car (car) + care (care); `are`: area (area) + are (be); `indi`: india (india) + indian (indian); `form`: form (form) + former (former); `cle`: clean (clean) + clear (clear); `lead`: leader (leader) + lead (lead); `sit`: site (site) + sit (sit); `liv`: live (live) + lives (life).

Store row: exact hits the stems alone miss 0 of 5764 (the OR with the word index returns them) [run].

## Cost — synthetic corpus (bench/search/gen.ts, seed 42) [run]

### N = 100,000 [run]

- Databases on `tmpfs` (RAM); 11465 MB available RAM at query time; node v24.19.0.
- Peak RSS of this process 323 MB.

| index | build | disk | notes |
|---|---|---|---|
| message_words (Exact, today) | 1.38 s | 22 MB | product DDL, optimize included |
| T1 vocabulary (search_terms + trigrams, today) | 1.53 s | 34 MB | 143,516 terms |
| S: message_stems | 3.55 s | 15 MB | of which Snowball in JS 2.49 s |
| T2: message_trigrams (normalized, contentless) | 3.09 s | 58 MB | |

| query | words | p50 ms | p95 ms | avg rows (LIMIT 20) |
|---|---|---|---|---|
| Exact (today) | ~1% df (0.3–3%) | 0.30 | 1.13 | 20.0 |
| S | ~1% df (0.3–3%) | 0.35 | 1.11 | 20.0 |
| T1 (correction + search) | ~1% df (0.3–3%) | 2.91 | 5.41 | 20.0 |
| T2 | ~1% df (0.3–3%) | 0.85 | 1.71 | 20.0 |
| Exact (today) | rare (0.01–0.1% df) | 0.02 | 0.06 | 15.5 |
| S | rare (0.01–0.1% df) | 0.04 | 0.09 | 15.8 |
| T1 (correction + search) | rare (0.01–0.1% df) | 2.43 | 22.61 | 18.0 |
| T2 | rare (0.01–0.1% df) | 0.25 | 0.82 | 16.0 |

### N = 1,000,000 [run]

- Databases on `tmpfs` (RAM); 9356 MB available RAM at query time; node v24.19.0.
- Peak RSS of this process 1036 MB.

| index | build | disk | notes |
|---|---|---|---|
| message_words (Exact, today) | 15.78 s | 170 MB | product DDL, optimize included |
| T1 vocabulary (search_terms + trigrams, today) | 11.09 s | 203 MB | 522,924 terms |
| S: message_stems | 37.11 s | 97 MB | of which Snowball in JS 25.12 s |
| T2: message_trigrams (normalized, contentless) | 40.42 s | 538 MB | |

| query | words | p50 ms | p95 ms | avg rows (LIMIT 20) |
|---|---|---|---|---|
| Exact (today) | ~1% df (0.3–3%) | 5.05 | 30.90 | 20.0 |
| S | ~1% df (0.3–3%) | 4.62 | 13.73 | 20.0 |
| T1 (correction + search) | ~1% df (0.3–3%) | 9.90 | 26.30 | 20.0 |
| T2 | ~1% df (0.3–3%) | 8.75 | 25.86 | 20.0 |
| Exact (today) | rare (0.01–0.1% df) | 0.23 | 1.00 | 20.0 |
| S | rare (0.01–0.1% df) | 0.19 | 0.73 | 20.0 |
| T1 (correction + search) | rare (0.01–0.1% df) | 5.23 | 8.64 | 20.0 |
| T2 | rare (0.01–0.1% df) | 1.66 | 4.50 | 20.0 |

## Gate §S12 — through the store code (gate.ts) [run]

### N = 100,000 [run]

- Store on `tmpfs` (RAM); 10868 MB available RAM; node v24.19.0; peak RSS 337 MB.
- Archive written at version 14 in 11.5 s (messages, word and trigram triggers), then migrated to snowball-3.1.1 cyrillic=russian latin=spanish.

| metric | target | measured | verdict |
|---|---|---|---|
| stem fill (`fillStems`, batches of 5,000) | ≤ 75 s | 2.0 s | pass |
| of which Snowball with the cache (one stemmer over every text, timed apart) | ≤ 25 s | 0.9 s | pass |
| disk, `message_stems` | ≤ 140 MB | 12 MB (dbstat); file grew 12 MB | pass |
| query p95, ~1% df word, page 20, exact tier first (§S7–S8 as hand-written SQL) | ≤ 30 ms, replaced 2026-10-06 by ≤ 2× exact (the compiler row) | 4.9 ms (p50 1.2, 20.0 rows) | — |
| ingest of 5,000 messages via `saveMessages`, pages of 100, drain on vs off, median of 5 rounds | ≤ +25 % | +21 % (rounds: +21 %, +28 %, +24 %, +12 %, +8 %; first round 0.8 s vs 0.7 s) | pass |
| through the compiler (`prepareLucene` + `matchQuery`): p95, ~1% df, stemmed text vs exact: | ≤ 2× exact (owner, 2026-10-06) | 4.8 ms vs 4.3 ms, 1.10× (p50 2.0 vs 1.9) | pass |
| for scale, not gated: through the compiler, words above 3% df | — | p95 36.2 ms vs 33.9 ms exact | — |
| for scale, not gated: today's exact query, same words, page 20 | — | p95 2.9 ms (p50 0.7) | — |
| exact hits the stems alone miss, 20 query words | 0 with the §S7 OR | 0 of 14790 | pass |

### N = 1,000,000 [run]

- Store on `tmpfs` (RAM); 9628 MB available RAM; node v24.19.0; peak RSS 419 MB.
- Archive written at version 14 in 152.8 s (messages, word and trigram triggers), then migrated to snowball-3.1.1 cyrillic=russian latin=spanish.

| metric | target | measured | verdict |
|---|---|---|---|
| stem fill (`fillStems`, batches of 5,000) | ≤ 75 s | 23.7 s | pass |
| of which Snowball with the cache (one stemmer over every text, timed apart) | ≤ 25 s | 8.8 s | pass |
| disk, `message_stems` | ≤ 140 MB | 101 MB (dbstat); file grew 101 MB | pass |
| query p95, ~1% df word, page 20, exact tier first (§S7–S8 as hand-written SQL) | ≤ 30 ms, replaced 2026-10-06 by ≤ 2× exact (the compiler row) | 47.8 ms (p50 14.6, 20.0 rows) | — |
| ingest of 5,000 messages via `saveMessages`, pages of 100, drain on vs off, median of 5 rounds | ≤ +25 % | +21 % (rounds: +24 %, +21 %, +26 %, +17 %, +9 %; first round 0.8 s vs 0.7 s) | pass |
| through the compiler (`prepareLucene` + `matchQuery`): p95, ~1% df, stemmed text vs exact: | ≤ 2× exact (owner, 2026-10-06) | 39.5 ms vs 51.3 ms, 0.77× (p50 11.0 vs 10.6) | pass |
| for scale, not gated: through the compiler, words above 3% df | — | p95 347.4 ms vs 350.7 ms exact | — |
| for scale, not gated: today's exact query, same words, page 20 | — | p95 29.6 ms (p50 8.2) | — |
| exact hits the stems alone miss, 20 query words | 0 with the §S7 OR | 0 of 136181 | pass |

