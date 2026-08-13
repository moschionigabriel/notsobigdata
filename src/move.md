# move.js — private notes

> Working notes, not user documentation. docs/move.md is the public
> reference for `move`'s config shape; this file is about the code's
> internals and the rules you have to keep if you change it. Gitignored.

## What this module owns

The whole "EL" of ELT: read from a source, optionally write to a target.
Five connectors, each with a read side and a write side:

| `type`      | extract              | load                                    |
| ----------- | -------------------- | --------------------------------------- |
| `sheets`    | `extractSheets`      | `loadSheets`                            |
| `drive`     | `extractDrive`       | `loadDrive` → csv / json / xlsx         |
| `bigquery`  | `extractBigQuery`    | `loadBigQuery`                          |
| `api`       | `extractApi`         | `loadApi`                               |
| `custom`    | `extractCustom`      | `loadCustom`                            |

Two dispatchers (`extract`, `load`) are plain `switch` statements over
`source.type` / `target.type`. `move()` is only fifteen lines: extract,
optionally load, return the rows.

## The one invariant that holds everything together

**Every extractor returns a 2D array** — an array of row arrays, the shape
Apps Script's `Range.getValues()` already speaks. That is the library's
"dataframe": because every source produces it and every target consumes it,
any source can feed any target without an N×M matrix of converters.

`assertRows()` enforces it at the end of *every* extractor, so a broken
connector fails with a clear message at the point of the bug instead of
producing a confusing error deep inside a loader.

If you add a connector, the read side must end in `assertRows()`.

## Shared helpers, and why they exist

- `objectsToRows` / `rowsToObjects` — the JSON⇄2D-array bridge. Note
  `objectsToRows` takes the **union** of every element's keys, not the first
  element's: API payloads routinely have optional fields that only appear on
  some records, and taking the first record's keys would silently drop them.
- `rowsToCsv` — used by both the Drive CSV target and the BigQuery load job
  (BigQuery loads are literally a CSV upload).
- `readDriveFileText` — Drive CSV/JSON reads and BigQuery's `queryFileId`.
- `assertHttpOk` — every `UrlFetchApp` response, both the `api` connector and
  the xlsx export URL.
- `resolveDriveWriteTarget` / `writeDriveText` / `isEmptyDriveOverwrite` —
  the three Drive write modes share target resolution and the
  "don't destroy an existing file with an empty extract" guard.
- `resolvePath` — dot-path lookup into a parsed JSON value (`'items'`,
  `'data.results'`). Shared by `source.envelope` and
  `source.pagination.tokenPath` on the `api` connector — both are "find a
  value somewhere inside a nested object", just pointed at different paths.
- `extractPaginated` — walks a cursor-paginated API: `fetchPage(token)` is
  supplied by the caller and knows nothing beyond "return one page's parsed
  body"; this function owns the loop, the envelope unwrap, the stop
  condition, and the final single `objectsToRows()` call across every page's
  accumulated objects (so the header row is the union across *all* pages,
  not just the first). Written HTTP-agnostic on purpose, even though
  `extractApi` below is currently its only caller — **it is not reachable
  from a `custom` source's `fn`.** `cli.js`'s IIFE returns only `{ cli: cli
  }`; every other function in this module, `extractPaginated` included,
  is private to that closure. This was tried the other way first (assuming
  a `custom` `fn` could call `extractPaginated` directly, since `eval()`'s
  own scoping rules put the library and the user's config in the same file)
  and shipped broken - it conflated "where `eval()`'s own var/function
  declarations land" with "what's reachable inside the IIFE they define",
  which are different questions. A `custom` source wrapping a native
  Advanced Service call (`YouTube.Search.list()` and friends) has to walk
  its own pages by hand; see docs/move.md's api-source section. This is the
  same shape of loop `extractBigQuery` already had (`pageToken` do/while,
  above) — pulled out as its own function once a second connector needed the
  same pattern with a different token field name and fetch mechanism, rather
  than copy-pasted.
- `appendQueryParam` — attaches a resolved pagination token to the next
  page's URL as a query param, URI-encoding both since a token is opaque
  server-generated data.
- `promoteStagedTable` (added 2026-08-11, code-review fix) — the copy-job
  promotion step of "stage, test, promote", shared with `model.js`'s
  `modelTableStaged`. `loadBigQueryStaged` and `modelTableStaged` had each
  hand-written their own `configuration.copy` call, which meant a future
  BigQuery copy-job quirk (`widenDestinationTableForPromotion`, below, was
  exactly this kind of quirk once) fixed against one caller had no reason
  to reach the other. `widenFirst` (a bool, not inferred) is the one place
  the two callers still diverge: `loadBigQueryStaged` passes it only for
  `allowSchemaEvolution && WRITE_APPEND`; `modelTableStaged` always passes
  `false`, since a model's promotion is always a full `WRITE_TRUNCATE`
  replace with no schema-evolution concept of its own.

## Things that will bite you

- **`resolvePath` checks `hasOwnProperty` before indexing, not a plain
  `value[key]`.** Same lesson as `CELL_CHECKS`/`KNOWN_CHECKS` below, applied
  a second time: a `tokenPath`/`envelope` string is config, and a path
  segment that happens to match an inherited `Object.prototype` member
  (`constructor`, `toString`, ...) must resolve to `undefined` like any
  other missing key — not fall through to the inherited value. Don't drop
  the `hasOwnProperty` guard back to a bare property access.
- **`extractPaginated`'s loop stops on `token === undefined` or
  `token === null`, not on falsy in general.** A legitimate cursor can be
  `0` or `''`; treating those as "no more pages" would silently truncate
  a paginated extract, so only these two specific values stop the loop.
  `undefined` means `resolvePath` didn't find the key at all (the field
  was omitted); `null` means the field was present but the API
  explicitly set it to `null` - the other common way a cursor-paginated
  REST API says "no more pages" alongside omitting the field entirely.
  Caught in release/7's independent review: the original version only
  checked `undefined`, so an API using the `null` convention (Google's
  own APIs' `nextPageToken` among them) kept looping with `token: null`,
  which `extractApi`'s `fetchOnePage` then treated as "has a token" -
  `token === undefined` was false - and sent a bogus request with a
  literal `&pageToken=null` query param.
- **XLSX has no native parser in Apps Script.** Both directions go through a
  temporary Google Sheet (`extractDriveXlsx`, `loadDriveXlsx`) which is
  *always* deleted, including on the error path. Keep that guarantee.
- **`assertReadOnlySelect`** gates BigQuery SQL to a single `SELECT`. It runs
  under the script owner's live OAuth, so weakening it means a config typo
  can drop a table. Don't relax it without a very good reason.
- **`assertReadOnlySelect`/`runSqlTests` now take an explicit `messagePrefix`
  instead of hardcoding `'move(): '` (and, for `runSqlTests`, "the staged
  table") into their own thrown text** - `model.js`'s new `tests` feature
  (2026-08-09) reuses both directly for a model's own test queries, the
  same "run this SQL, zero rows means pass" primitive `target.sqlTests`
  already was, just previously only reachable from this file. Both of this
  file's own call sites (`extractBigQuery`, `loadBigQueryStaged`) now pass
  their own `'move(): ...'` prefix explicitly, matching the convention
  `assertSingleStatement` already used. If you touch either function's
  error wording again, `model.js` is a second caller to check, not just
  this file's own two call sites.
- **Empty extracts are treated as "protect the target", not "write
  nothing"** — `loadSheets` and `loadBigQuery` skip a destructive overwrite
  when there is nothing to write, and `isEmptyDriveOverwrite` does the same
  for Drive. A flaky API returning `[]` should not wipe yesterday's data.
- **`rows.loadResult`** is an extra *property* on the returned array, not an
  element — so `rows.length`, indexing and `JSON.stringify(rows)` are all
  unaffected.
- **`objectsToRows` JSON.stringifies a nested object/array cell value; it
  does not flatten it into dotted sub-columns.** A YouTube Data API-shaped
  `snippet`/`statistics` field lands as one cell holding JSON text, not
  `snippet.title`/`snippet.description`/... columns. Deliberate, not a
  stopgap: dotted flattening needs a stance on a separator, arrays-of-
  objects (which can't dot-flatten cleanly the way a plain nested object
  can), and a name collision between a flattened dotted key and an
  existing top-level key of the same name — none of which has a real user
  yet.
- **That stringify happens at extract time, before any target sees the
  row — which trades away round-trip fidelity for the `drive-json`/`api`
  targets specifically.** Before this fix, an `api` source's nested value
  flowed through `loadDriveJson`/`loadApi` (`rowsToObjects` +
  `JSON.stringify`) and came out as real nested JSON, since those two
  targets never touch `rowsToCsv`/`String()`. After this fix, the same
  round trip re-encodes an already-stringified cell, so the nested field
  comes out as a JSON string holding escaped JSON text
  (`"{\"title\":...}"`) rather than a nested object. Not data loss — a
  second `JSON.parse` recovers it — but it's a real fidelity change in a
  path that worked losslessly before. Avoiding it would mean moving the
  stringify out of `objectsToRows` and duplicating it at each write
  boundary (`rowsToCsv`, and wherever `loadSheets`/`loadDriveXlsx` call
  `setValues`) instead of once upstream — not worth it unless a real user
  hits the round-trip case.
- **`target.allowSchemaEvolution` only ever attaches `schemaUpdateOptions`
  when `mode === 'append'`.** `mode: 'overwrite'` (`WRITE_TRUNCATE`)
  already replaces the destination schema wholesale every run, so the
  option would be a no-op there — deliberately not attached rather than
  thrown on as a harmless combination. It's also additive-only by BigQuery's
  own design (`ALLOW_FIELD_ADDITION`, `ALLOW_FIELD_RELAXATION`) - a type
  change or a renamed/dropped column still fails the load job with the
  flag on, same as with it off. Don't expand this to try to cover those;
  BigQuery itself has no schema-evolution option for them.
- **`target.sqlTests`/`target.schema`/`target.allowSchemaEvolution` are
  all silently ignored (dead config, no error) on a target whose
  `type` isn't `"bigquery"` - none of the three has a validation guard
  in `move()` or `load()`.** An earlier version of `sqlTests` *did* throw
  from `move()` when attached to the wrong target type, which the
  `release/7` independent review flagged as inconsistent (the other two
  bigquery-only keys don't) and architecturally wrong (`move()`/`load()`
  are the one kind-agnostic layer in this file; that guard was the only
  place either function referenced a specific `target.type` string or
  connector-specific option name). Removed rather than adding the same
  guard to the other two - `move()` staying fully target-type-agnostic
  is worth more than one extra thrown error for a config mistake that
  already fails a different way (the option quietly does nothing).
- **`target.sqlTests` (`loadBigQueryStaged`) sets the staging table's
  `expirationTime` before any data lands, via an explicit
  `BigQuery.Tables.insert` rather than letting the load job auto-create
  it.** This is the real reason it's a separate call instead of just
  loading straight into a table name that doesn't exist yet: Apps
  Script's own execution-timeout kill doesn't guarantee the `finally`
  block that normally deletes the staging table ever runs, and this
  project already paid for that exact failure mode once (see
  CLAUDE.md's "About testing" — Drive load-test fixtures piling up to 30
  files before anyone noticed, 2026-08-06). `expirationTime` is the
  backstop for that scenario specifically; the `finally` block is still
  the primary cleanup path and should keep firing on every normal
  success/failure.
- **That `finally` block's own cleanup call (`BigQuery.Tables.remove`) is
  not wrapped in its own try/catch, so if it throws, it masks whatever
  error `runSqlTests`/`runBigQueryJob` was already raising** — the same
  ambiguity `extractDriveXlsx`/`loadDriveXlsx`'s plain `finally { Drive.Files.remove(...) }`
  already carries (`src/move.js:145`, `:635` at the time this was
  written) and never resolved either. Left this way on purpose for
  consistency rather than fixing it in one spot and not the other, but
  it's a real, deliberate loose end - a `Tables.remove` failure hiding a
  genuine failing sql test would be a worse surprise than the Drive
  case, since it swaps out a data-quality error for an unrelated cleanup
  one. Worth a real fix (log-and-continue instead of letting the second
  error win) if it ever actually bites someone, in both places at once
  rather than just here.
- **`runBigQueryJob`, `resolveBigQueryWriteDisposition`,
  `buildBigQueryLoadConfig`, `runBigQueryQueryJob`, and
  `resolveBigQuerySchemaUpdateOptions` all exist because
  `loadBigQueryStaged` needed logic `loadBigQuery`/`extractBigQuery`
  already had, under a different shape.** `runBigQueryJob` (insert a
  load/copy job, poll it with backoff since `Jobs.get` doesn't block)
  and `buildBigQueryLoadConfig` (a load job's `configuration.load` body)
  were extracted once a third call site needed them - two tolerated the
  duplication inline. `runBigQueryQueryJob` (run a query job via
  `Jobs.query`, no backoff needed since `getQueryResults` already
  long-polls server-side unlike `Jobs.get`) is shared by
  `extractBigQuery` and `runSqlTests` - found and fixed in `release/7`'s
  independent review, which is also why `runBigQueryQueryJob` accepts an
  optional `maxResults` on its `queryRequest` and threads it through
  every poll call, not just the first: `runSqlTests` only wants a
  bounded first page (5 example rows), and a `maxResults` that stopped
  applying the moment a job needed more than one poll would silently
  stop capping the response. `resolveBigQuerySchemaUpdateOptions` started
  as the same "one decision, two job kinds" shape
  `resolveBigQueryWriteDisposition` already established (found
  copy-pasted verbatim at both the direct-load and promotion-copy call
  sites, in the same independent review) - but stopped being genuinely
  shared once GAS testing showed a copy job doesn't actually honor
  `schemaUpdateOptions` the way a load job does (see the entry below on
  `widenDestinationTableForPromotion`). It's kept anyway, used only by
  `loadBigQuery`'s direct path now, rather than inlined back - the name
  and one-decision shape are still worth the function even at a single
  call site.
- **One of the two BigQuery API behaviors flagged here as
  "reasoned through, not run" has since been resolved, both by hand
  against a real project.** `BigQuery.Tables.insert` with only
  `expirationTime`/`tableReference` set (no schema) being a valid
  destination for a later `autodetect: true` load job - confirmed
  working, via the `target.sqlTests` feature's own GAS tests
  (`testLoadBigQuerySqlTestsPass`/`...Fail`), which exercise exactly
  that path. Whether a copy job (`configuration.copy`) accepts
  `schemaUpdateOptions` the same way a load job does - **confirmed NOT
  working**: `testLoadBigQuerySqlTestsWithSchemaEvolution` (added
  specifically to check this combination) failed with `Provided Schema
  does not match Table ... Cannot add fields`, meaning
  `schemaUpdateOptions` on a copy job is silently ineffective, not just
  unverified. Fixed by `widenDestinationTableForPromotion` (above
  `loadBigQueryStaged`): patch the real destination table's schema
  directly before the copy job runs, rather than trust the copy job to
  do it. Left genuinely unverified still: `ALLOW_FIELD_RELAXATION`
  (REQUIRED→NULLABLE) on either job kind - neither GAS test exercises a
  REQUIRED column, only field addition. Don't assume relaxation works
  just because addition now does on both paths.
- **`rowsToCsv` does NOT re-check for object cells** — it trusts
  `objectsToRows` already turned every non-primitive value into a string.
  A `custom` source that hands back a raw object in a cell still degrades
  to the literal text `"[object Object]"` in the bigquery/drive-csv
  targets. Deliberately not guarded a second time: `custom` sources are
  documented as owning their own row shape ("its return value is used
  directly"), and duplicating the same typeof check here with no real
  custom-source bug report behind it is exactly the kind of preemptive
  defensiveness this project avoids.

## Data tests (`config.tests`)

`runTests()` sits between `extract()` and `load()` inside `move()` -
schema-contract-style validation, scoped to a plain grid instead of a
typed schema. `CELL_CHECKS` is the per-cell check table (`not_null`,
`accepted_values`, `min`, `max`); `unique` and `regex` aren't in it -
`unique` needs cross-row state (a `seen` map), `regex` only needs its
pattern compiled once - so `runOneTest` special-cases both instead of
forcing a stateful/one-time-setup check into a one-cell-at-a-time shape.

**`CELL_CHECKS`/`TEST_CHECK_REQUIRES` are `Object.create(null)`, not `{}`,
and `validateTest` checks a check name's validity via `KNOWN_CHECKS.indexOf()`
rather than `CELL_CHECKS[test.check]` truthiness - on purpose, found the
hard way in the release/6 review.** `test.check` is a string straight from
the pipeline author's config; on a plain `{}`, a value like `"constructor"`
resolves to an inherited `Object` property (truthy), which used to pass
validation and then make `runOneTest` call `Object(value, test)` - always
truthy, so the check always reported every row as passing. Don't put
either map back to a plain object literal, and don't swap the
`isKnownCheck`/`KNOWN_CHECKS.indexOf()` guard back to an object-property
truthiness check - both were the actual bug, not defensive overkill.

`validateTest` runs unconditionally for every declared test - including
when `rows.length === 0` - before `runTests` does anything else. That's
deliberate too: the first version skipped validation entirely on an empty
extract, so a bad test could stay silent indefinitely on a source that
just hadn't produced data yet. Only the *execution* (`resolveTestColumn`/
`runOneTest` against real rows) short-circuits on empty data.

`min`/`max` fail a blank cell instead of comparing it - `Number('')` and
`Number(null)` are both `0` in JS, and without the `isBlankCell()` guard a
blank cell silently satisfied `min: 0` as if it held an actual zero.
`isBlankCell()` is the one shared definition of "no value" for this whole
section - `not_null`, `unique`'s blank-skip, and `min`/`max` all use it.

Every test runs before any decision is made - failures are collected, not
thrown on first sight - so `raise` can report every violation in one
error instead of one run per fix. `discard_row` never throws; it filters
`dataRows` and returns a new `[headers].concat(kept)` array, so the
`rows` array `move()` started with is never mutated in place.
`discardedCount` is derived (`dataRows.length - kept.length`) rather than
tracked incrementally - don't reintroduce a counter that has to stay in
sync with the filter by hand.

Deliberately not built (no real user yet, same call the `model` kind's
`dependsOn` hook already made): dropping just one bad cell instead of the
whole row (there's no obvious "null" for an arbitrary cell in a plain
grid) and referential (cross-table) checks, which would need to query
another table. Also considered and deliberately deferred: giving
`discard_row` its own status in `cli()`'s run report instead of plain
`'success'` - right now a caller has to know to check `result.testResults`
to see that rows were silently dropped, which `cli()`'s own `Logger.log`
output never mentions. That's a real gap, but it means changing `cli()`'s
status vocabulary (`success`/`failed`/`skipped`/`planned`), which is a
bigger, separate decision than this feature's first version should make
on its own.

Kept self-contained in this file rather than reusing `cli.js`'s
`has()`/`emptyMap()` - CLAUDE.md states "no helper crosses the move/cli
boundary" as a fact about the current split, and this didn't need to be
the change that makes that stop being true. `seen`/`discardedRows` use
`Object.create(null)` directly instead.

## The `url` source

`url` is a sibling of `drive`, not of `api`: `api` expects a JSON
array/envelope in the response body, `url` expects a raw file body (csv,
json, or xlsx) — the same three shapes `drive` already parses. So
`extractUrlCsv`/`extractUrlJson`/`extractUrlXlsx` are built by copying
`extractDriveCsv`/`extractDriveJson`/`extractDriveXlsx`'s logic and
swapping the read: `readUrlText` (fetch + `assertHttpOk` +
`getContentText`) stands in for `readDriveFileText`. No third
implementation of the actual parsing exists anywhere — only the "how do I
get the bytes" half differs.

`extractUrlXlsx` still needs its own temp-Google-Sheet conversion, same as
`extractDriveXlsx`, because Apps Script has no native XLSX parser either
way. Getting there took one wrong turn worth recording: the first version
called `Drive.Files.insert(metadata, blob)` to upload-and-convert a fetched
blob in one step, mirroring how `extractDriveXlsx` passes an existing file
id straight to `Drive.Files.copy`. That broke in the companion test
project with `Drive.Files.insert is not a function` — `insert` is Drive
API v2 only, renamed `Files.create` in v3, and a newly-enabled Advanced
Drive Service defaults to v3 today. Unlike the name/title split
`extractDriveXlsx`'s own comment already documents (both fields set, the
unused one ignored — a metadata *shape* difference), there's no such
both-and-ignore trick for a method name that plain doesn't exist on the
other version's object. Rather than feature-detect which method exists (an
untested-by-anyone-else code path either way), `extractUrlXlsx` now does
the upload as a plain `DriveApp.createFile` (no Advanced Service involved,
no version to guess at) and only reaches for `Drive.Files.copy` —
`extractDriveXlsx`'s already-proven method — to do the conversion, same as
`loadDriveXlsx` already proves the "plain create, then let the Advanced
service transform it" split works project-wide (there it's
`SpreadsheetApp.create` doing the plain half). Two temp files exist now
instead of one — the raw upload and the converted sheet — and both are
removed in nested `finally` blocks, including on error, so a failure at
either step never leaves an orphan behind.

`rewriteGithubBlobUrl` is intentionally one regex, one host. The trigger
for building it at all was a real UX gap: the URL you get from GitHub's
"view file" UI (`github.com/.../blob/...`) is an HTML page, not the raw
file, and that mismatch is surprising enough (and GitHub common enough as
a source) to be worth papering over. It does not generalize to "resolve
any dataset host's share link" — that's a slippery slope with Kaggle at
the bottom, and Kaggle specifically needs their authenticated API (a
`kaggle.json` credential, dataset slug resolution, zip extraction) to get
a file at all, not a URL rewrite. That's a materially bigger feature, and
one that cuts against this library's whole "no external credentials to
manage" posture (BigQuery/Drive/Sheets access all ride Apps Script's own
OAuth) — so it's staying out, and docs/move.md tells a Kaggle user to
download once and use `drive` instead.

**The path capture strips a trailing `?query`/`#fragment` (2026-08-11
code-review fix).** The original regex's `(.+)$` capture was greedy all
the way to end of string, so a URL copied straight out of the GitHub UI
with `?raw=true` appended, or a line-range link ending `#L10-L20`, carried
that suffix verbatim into the rewritten `raw.githubusercontent.com` URL —
a host that doesn't understand either one, and a query string in
particular could produce a different or unexpected response than the
plain file body this function exists to fetch. Fixed by splitting the
captured path on the first `?`/`#` and using only what comes before it
(`match[3].split(/[?#]/)[0]`) — a real GitHub blob path never legitimately
contains either character unescaped, so this can't clip a genuine path
segment.

No `url` target: `api` already covers "send this data to a URL" (POST/PUT
with a JSON body, `loadApi`). A "PUT a raw csv/xlsx file to a URL" target
would be new surface with no concrete use case driving it — add one if a
real pipeline needs it, not speculatively.

**`extractDriveXlsx`/`extractUrlXlsx` share one helper now
(2026-08-12, ponytail audit).** Both used to duplicate the same "copy a
file id to a temp Google Sheet, read it, delete the copy" block —
`extractDriveXlsx` starting from a real Drive file id, `extractUrlXlsx`
from a freshly-uploaded temp copy of a fetched blob. Pulled the shared
part into `readXlsxFileIdAsGrid(fileId, tempFileName)`; each caller now
only does the part that's actually different (nothing, and
upload-then-cleanup, respectively).

## Adding a connector

1. Write `extractX` (ending in `assertRows`) and `loadX` here.
2. Add a `case` to `extract` and to `load`.
3. Document the config in docs/move.md.
4. Add a fixture node + test to `notsobigdata-tests/`.

No change to `cli.js` — it never learns about connectors, only about kinds.
If this file gets unwieldy, the next split is `src/move/` with a file per
connector; `build.sh`'s manifest is the only thing that would need to know.
