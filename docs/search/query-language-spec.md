# Lucene query profile v1 — техническая спецификация

Implementation A1; runtime TypeScript/SQLite, Java только для development conformance.
Canonical guide/spec по явному требованию владельца — на русском; остальные shared documents
сохраняют английский. [Пользовательская справка](query-language.md) — поддержка/limits/recipes.

## Normative baseline

Apache Lucene tag `releases/lucene/9.12.3`, commit
`f965e930673c1f5cb478dc6a8907f5fc4ef7b539`. StandardSyntaxParser.jj и официальный
BooleanModifiersQueryNodeProcessor из PrecedenceQueryParser, `defaultOperator=AND`, default field `text`.

Grammar/config отличаются от classic QueryParser. Query = DisjQuery*, DisjQuery = ConjQuery OR*,
ConjQuery = ModClause AND*. Adjacency применяется отдельно, не как conventional AND precedence.
Boolean clauses сохраняют MUST/SHOULD/MUST_NOT; optional nodes при наличии required не обязательны.
Pure-negative query даёт пустое множество, не SQL complement universe.

Upstream source/Apache license/NOTICE находятся в `scripts/search-reference/`;
[THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES) входят в npm artifact вместе с портом.
[Официальная grammar](https://github.com/apache/lucene/blob/f965e930673c1f5cb478dc6a8907f5fc4ef7b539/lucene/queryparser/src/java/org/apache/lucene/queryparser/flexible/standard/parser/StandardSyntaxParser.jj),
[Boolean processor](https://github.com/apache/lucene/blob/f965e930673c1f5cb478dc6a8907f5fc4ef7b539/lucene/queryparser/src/java/org/apache/lucene/queryparser/flexible/precedence/processors/BooleanModifiersQueryNodeProcessor.java),
[RegExp grammar](https://github.com/apache/lucene/blob/f965e930673c1f5cb478dc6a8907f5fc4ef7b539/lucene/core/src/java/org/apache/lucene/util/automaton/RegExp.java).

## Parser decision

Runtime checks 2026-10-03, пять counterexamples на каждой candidate library.
Это rejection corpus, не утверждение о полном покрытии сторонних parsers.
[Outputs](../../scripts/search-reference/parser-candidates.json) содержат версии и synthetic ASTs.

| Candidate | License / maintenance evidence | Проверенный разрыв с baseline |
|---|---|---|
| lucene-query-parser 1.2.0 | Apache-2.0; repo last push 2018-12-06 | `alpha OR beta gamma` → alpha OR (beta implicit gamma); escaped quote отвергается |
| @hyperdx/lucene 3.1.1 | MIT; repo last push 2023-06-17 | Та же несовместимая adjacency grouping |
| liqe 3.8.7 | BSD-3-Clause; repo last push 2026-06-11 | Explicit AND/OR left-associative; +modifier и mixed date range отвергаются |
| lucene-kit 1.3.0 | MIT; repo last push 2026-09-01 | `alpha OR beta gamma` — один literal term; +alpha тоже literal |

Решение: прямой TypeScript port pinned grammar и clause processor; без runtime parser dependency
и без re-association стороннего DSL. Production parser распознаёт профиль и явно отклоняет unsupported
suffix/functions. Не заявляется полная Lucene compatibility для всех analyzers/constructs.

## Configuration и versioned request

`QueryAst = {version:1,language:"lucene-v1",root}`; spans — UTF-16 offsets `[start,end)`.
Predicate nodes: field/operator/value/range endpoints/inclusivity/span. Boolean nodes:
clauses с `must|should|mustNot` и root spans. Raw AST reconstruct/validation отвергает malformed,
unknown fields, illegal combinations, версии и budgets; caller resolution/SQL/authority не доверяются.
Comparison `field>=value` также принимается в записи Elasticsearch `field:>=value` (и `:>`, `:<`, `:<=`) —
тот же range node; это сознательное расширение pinned grammar, другого синтаксиса оно не добавляет.

CLI и MCP явно выбирают language=lucene по умолчанию; exported `MessagesService.search` и
`searchStore` без language сохраняют legacy-v1 semantics для старых SDK consumers. Новые callers
выбирают language явно либо передают versioned AST. Parser не выбирается по содержимому строки.
Explicit legacy mode остаётся до отдельно согласованного breaking window, не снимается этим release.

`FIELD_VERSION=1`, `PRESET_VERSION=1`; registry включает field type/operators/enums/normalization,
example/index/aliases/support. AST text/structured validation одна. Из registry генерируются
operator/field tables, budgets, presets и recipes; `docs:check` проверяет drift.
`SavedQuery` — versioned interface; persistence/migration repository остаётся A2.
`migrateLegacyQuery` — pure preview с explicit grouping/UTC instants и discovery warnings.

## Field mappings

text — существующий SQLite FTS5 `unicode61 remove_diacritics 2` над normalized_text v1.
NFKD/mark stripping/NFC/lowercase/control-whitespace folding не меняются. Literal с несколькими
анализированными tokens сопоставляется как последовательность; несколько query terms — Boolean.
Phrase proximity, boost и fuzzy profile operators отвергаются; discovery никогда не добавляет hits.
`~` после term — alternative про `--language legacy` и prefix `word*`; после phrase — про proximity.
body — исходный case-sensitive keyword. Его empty quoted literal/empty regex выбирают empty body;
empty text literal не совпадает с индексированным token.

Regex анализирует normalized term либо полный raw body. Pattern syntax целиком не нормализуется.
Wildcard и regex literals text нормализуются той же `fold` (NFKD/marks/NFC/lowercase), что и индекс
(`foldRegex`): обычные, экранированные не-ASCII и quoted literals, члены классов и диапазоны
(диапазон до 4096 code points раскрывается и сворачивается; шире — только если концы не меняются).
`\D \W \S` и прочие ASCII escapes не трогаются. Символ без единственной свёрнутой формы →
`query.unsupported-regex` с alternative. Это сознательное отличие от Lucene, где regex не анализируется.
body regex остаётся raw и case-sensitive.
Доказанный prefix лишь сокращает dictionary enumeration; OR/nullable prefix не должен терять terms.
Vocabulary общий для store, без chat/date условия: превышение `expansions` — `query.too-large` с
`budget:"term expansions"`, `term`, `limit`, span; alternative — длиннее prefix или body regex в чате.
Folding v1 сливает разные слова (мой/мои, año/ano); это known limit до смены NORMALIZER_VERSION.
FIELD_VERSION не меняется: поле не переименовано, а regex, молча не находивший ничего, теперь находит;
сохранённые поиски разбираются заново и получают это поведение.

Date endpoints собственные typed mappings над стандартной grammar: calendar day в IANA zone,
exact timestamp с offset, mixed inclusive/exclusive/open bounds. DST вычисляется через календарь,
не через duration +24h. Неизвестные/невозможные dates/zones отвергаются. Relative: today/yesterday — календарный день в zone; Nm/Nh/Nd — момент now−N; term Nd = [now−N TO *].
IDs string; names разрешаются по локальным accounts. topic требует одного обязательного chat.
kind сохраняет dialog mapping; peerKind metadata различает bot/service без догадок по имени.
filename/mime: до основного запроса страницами читаются имена/типы вложений в выбранных аккаунтах,
сравниваются после normalize, найденные сообщения идут в SQL как точное условие (бюджет work и времени);
mime без / совпадает с первой частью типа. size: SQL по attachments.size, единицы 1024. Совпадение —
хотя бы одно вложение. tag: SQL по таблице tags (store version 16) — pk сообщения среди меток
типа message, OR chat_pk среди меток типа chat, OR sender_identity_pk среди меток типа contact;
точное условие, поэтому NOT tag точен.
content: (store version 19) — `m.pk IN (SELECT message_pk FROM attachments WHERE pk IN (SELECT rowid
FROM attachment_words WHERE attachment_words MATCH ?))`; term и phrase, normalize как у text. Фрагмент
не задаёт fts, поэтому слова файлов не входят в bm25-ранжирование (оно AND-ит все обязательные слова
против message_words) и не правятся опечатками. Точное условие, поэтому NOT content точен.
FIELD_VERSION не меняется: новое поле, ничего не переименовано.
Слово без поля (`Predicate.implicit`; `text:` его снимает) — `text`/`exact` term или phrase, к которому
добавлены: `attachment_words` (расшифровки и тексты файлов) и слово имени файла (имена читаются один раз
за запрос). Запрос ведут множества (driver) и ранжирование LEFT JOIN по `message_words`/`message_stems`;
ряды без совпадения в тексте упорядочены tier: расшифровка 1, имя файла 2, текст файла 3. `content:`
теперь только тексты файлов (без `speech:`), `transcript:` — только расшифровки. `matchedIn` считается для
страницы ответа. Legacy (`words.ts`) и `--backend` server search по-прежнему ищут только текст.
FIELD_VERSION не меняется: поле `text` не переименовано, у слова без поля шире охват; сохранённые поиски
разбираются заново и получают это поведение.
Поля почты (to/cc/bcc/subject/mailbox/label/is): поиск без почтового аккаунта отвергает их
(`query.unsupported-field`), в поиске по мессенджерам и почте сразу они совпадают только с почтой. label — синоним
mailbox. is: `unread` — `emails.read = 0`, `read` — `emails.read = 1`, `starred` — `emails.flagged = 1`;
NULL (импорт не знал состояния) не совпадает ни с одним значением, а NOT is:unread его включает (NOT coalesce).
У сообщений мессенджеров нет состояния прочтения по сообщению (только `chats.unread_count` на чат),
поэтому is: для них — поле почты, а не догадка по счётчику. FIELD_VERSION не меняется: поля новые.

## SQL compiler и порядок

Bound SQL/FTS; node field whitelist никогда не становится SQL identifier из запроса.
Boolean occurrence conditions вычисляются до LIMIT. Prohibited nullable predicates используют
NOT coalesce. Account allow-list находится вне AST; negative in не расширяет universe.
Positive in/--source явно выбирают доступные локальные accounts; caller-provided allow-list не расширяется.

Обязательный text candidate, существующий в каждой Boolean ветке, стартует через FTS CROSS JOIN
и `bm25(1.0,0.0)`; scope tokens не влияют на score. Full Boolean predicate остаётся final guard.
Ветви без обязательного text используют newest order; --newest всегда сортирует по времени.
Tie-breaker: sentAt DESC, provider/account/chat ASC, message DESC; qualified locators предотвращают collisions.
Explicit chat-only scan стартует с chat/time index. Index not ready — явная ошибка, не substring fallback;
message называет прогресс (`filledThrough/watermark` либо pendingNormalization) и `<cli> store migrate`.

Postfilter candidate selection — SQL superset без unsafe отрицания bounded predicates; full AST
проверяется на candidates. Row/byte caps проверяются до body loading; bounded batches позволяют abort.
Relevance и pagination не меняют matched set. Охват описывает выбранные accounts/chats даже при нуле.
lastSyncedAt — самый старый `fetched:<chat>` sync_state охвата (null, если чат охвата не скачивался);
inventoryComplete — у каждого account охвата есть `chat_list_complete` (пишет `markChatsLeft`);
wordsReady — `searchIndexState().ready` для любого запроса, не константа.

## Regex safety и compatibility

Lucene RegExp subset port + Thompson NFA без backtracking. State/work budgets ограничивают один
match и суммарную работу. Union/groups/classes/quantifiers/#/@ и ASCII predefined classes
подтверждены reference corpus именно 9.12.3. Intersection/complement/named automata/numeric intervals
и negative predefined class внутри negated class пока unsupported. JS lookaround/backreferences/flags
не предлагаются как Lucene; flag-like suffix даёт отдельную ошибку.

JS legacy mode — `iu` по полному body, отдельный worker с error/exit listeners и terminate в finally.
Source flags/stateful pattern сохраняются для existing programmatic callers; row/byte/time caps новые.
Тексты передаются только in-memory worker data; diagnostics/error paths не содержат pattern/body.
Переданные AbortSignals и command deadline закрывают worker, timers и store; SQL statement сам по себе
не interruptible, но query checks/yields разделяют bounded SQLite batches.

Presets — versioned candidate detectors, с bounded expressions/work и false-positive examples.
Никакого external LLM, секретной второй таблицы или implicit network refresh.

## Проверки

Checked-in query и regex fixtures с development Java harness: baseline config и synthetic 16-message
corpus. Analyzer reference: Whitespace, then Snowball 3.1.1 stems by script, для text (Whitespace без стемов для exact), Keyword для body/from/kind; typed dates/normalization
и SQLite semantics проверяются отдельно. Это не заявляет эквивалентность Lucene StandardAnalyzer.

Проверки: parser acceptance, Boolean ids на двух providers, term/body regex, empty/media-only,
quoted/escaped/repeated/grouped fields, unsupported syntax, SQL parameterization, bounds/abort,
DST/calendar, account isolation, explicit legacy corpus и migration. Real CLI/MCP recipes используют
один [fixture](recipes.json); expected ids и negative error codes/reasons проверяются.

`pnpm search:docs` генерирует reference sections. `bin/verify-query-reference` воспроизводит upstream
fixtures при Java 21/JDK в PATH или SEARCH_REFERENCE_JAVA_DIR; обычные tests Java не требуют.
Shared gates: lint/typecheck/test:coverage/docs:check/build/check:dist/smoke:bun. Consumer gates:
их suites, generate/parity/pages/wording/test-matrix. Все fixtures/stores synthetic и sandboxed.

Benchmarks 100k/1M: [Lucene results](../../bench/search/lucene-results.md) и existing
[legacy chain results](../../bench/search/results.md). Result records содержат executor hash,
first/repeated timings, RSS и EXPLAIN. First request не означает сброс OS cache.
RES-12 legacy path не изменён; размер word-index build измеряется existing fill benchmark.
Live scenarios — отдельное read-only подтверждение известных test chats; не выполнялись без разрешения.

## Интерфейс для Telegram remote work

B использует exported QueryAst/QueryNode/registry/version и тот же validator. Этот release не
добавляет remote search transport. Local store поддерживает declared A1 operators; remote backend
должен объявить supported fields/operators или отказать до fetch. Bounded local postfilter обязан
сообщать fetched coverage и partial/inaccessible history, не обещать server regex/full archive.
Domain ids/peer metadata остаются provider-neutral; provider library не пересекает adapter seam.
