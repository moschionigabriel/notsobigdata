# move kind reference

`move` is the "EL" of ELT: it extracts a `source` into a 2D array and,
optionally, loads that array into a `target`. See the main
[README](../README.md) for installation and a worked example, and
[docs/cli.md](cli.md) for how a `move` node is declared and run.

## Extract

A `move` node extracts a `source` into a 2D array — the same shape Apps
Script already uses for Sheets ranges — and, if you also give it a `target`,
loads that array there too. These are the `source` shapes:

```javascript
// Google Sheets — range is optional; omit it to read the whole active sheet
source: { type: 'sheets', spreadsheetId: '...', range: 'Orders!A1:F' }

// Drive file — fileType selects the parser: 'csv', 'xlsx', or 'json'
source: { type: 'drive', fileId: '...', fileType: 'csv' }

// BigQuery — exactly one of table, query, or queryFileId
source: { type: 'bigquery', projectId: '...', dataset: 'staging', table: 'orders' }
source: { type: 'bigquery', projectId: '...', query: 'SELECT customer, SUM(amount) AS total FROM staging.orders GROUP BY 1' }
source: { type: 'bigquery', projectId: '...', queryFileId: '<drive file id of a .sql file>' }

// External API — expects a JSON array of objects in the response body
source: { type: 'api', url: 'https://...', options: { /* UrlFetchApp params */ } }

// External API, enveloped and paginated — e.g. the YouTube Data API v3,
// whose responses look like {"items": [...], "nextPageToken": "..."}.
// "envelope" points at the array inside the body; "pagination" repeats the
// request with the resolved token attached as a query param until the API
// stops returning one, up to "maxPages"
source: {
  type: 'api',
  url: 'https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=UCxxxx&maxResults=50',
  options: { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } },
  envelope: 'items',
  pagination: { param: 'pageToken', tokenPath: 'nextPageToken', maxPages: 10 }
}

// Custom — fn is a function you already defined in your own Apps Script
// project; it's called as fn(source) and its return value is used directly
function myCustomExtract(source) {
  return [['col1', 'col2'], ['a', 1], ['b', 2]];
}
// ...
source: { type: 'custom', fn: myCustomExtract }
```

For `drive` and `api` sources, a JSON array of objects is flattened into a
header row plus data rows using the **union of every object's keys** as the
column list — any object missing a given key just gets a blank cell there.
A value that's itself an object or array — a nested field like the YouTube
Data API's `snippet`/`statistics` — isn't flattened into further columns;
it's `JSON.stringify`'d into that one cell instead, so it survives every
target as readable JSON text rather than silently collapsing to the literal
string `"[object Object]"` once it reaches a CSV-based target (`bigquery`,
drive `csv`). If a table shaped like that also has too little type
contrast between its header and data rows for BigQuery's `autodetect` to
reliably find the header row, pass `target.schema` (see the `bigquery`
target section below) instead of relying on autodetect.
`xlsx` files are converted to a temporary Google Sheet under the hood (Apps
Script has no native XLSX parser), read, and the temporary copy is deleted
immediately after — this requires the Advanced Drive Service enabled in
your Apps Script project.

`api` sources also accept two optional keys for REST APIs that don't hand
back a bare JSON array — both omittable, and omitting both keeps the
behavior above unchanged:

- `envelope`: a dot-path (`'items'`, `'data.results'`) to where the array
  actually lives in the response body, for a payload shaped like
  `{"items": [...]}` instead of a bare `[...]`.
- `pagination`: `{ param, tokenPath, maxPages }` to follow a cursor across
  multiple pages instead of reading just the first one. After each fetch,
  `tokenPath` (another dot-path) is looked up in that page's body; if it
  resolves to something truthy, the next request repeats with that value
  attached to the URL as the `param` query parameter, and so on until
  `tokenPath` comes back empty (the normal end-of-results signal) or
  `maxPages` requests have been made, whichever comes first. `maxPages` is
  required whenever `pagination` is given — there's no default, since a
  paginated request with no cap is a request that can, in principle, never
  stop. Every page's rows are combined into one result, with one header row
  that's the union of every page's keys, same as a non-paginated response.

This is exactly the shape of the YouTube Data API v3 (and most Google
REST APIs): `envelope: 'items'`, `pagination: { param: 'pageToken',
tokenPath: 'nextPageToken', maxPages: N }`, shown above.

For `bigquery` sources, `table`/`query`/`queryFileId` are mutually
exclusive — pick one (`table` also requires `dataset`). `query` and
`queryFileId` must be a single, read-only `SELECT` (a leading `WITH` is
fine, for CTEs) — a multi-statement script (statements separated by `;`)
or anything other than a read is rejected before it reaches BigQuery. This
isn't a hard security boundary, just a keyword/shape check to keep `move`
read-only — declaring transformations that write or modify data is the
`model` kind's job, not `move`'s (see [docs/model.md](model.md)).

For `custom` sources, `fn` is a direct reference to a function you've
already defined elsewhere in your Apps Script project — **not** a function
name for the library to look up. This is worth being precise about now that
`cli()` scans the global scope: that scan reads properties to find *config
objects*, and never calls anything it finds. Executable code only ever
enters the library the way `fn` does — as a reference you handed it
yourself, in a config object you wrote. `fn` is called as `fn(source)`,
passing the whole source object back in case your function needs extra
config keys you attached to it, and the return value is checked to be an
array of arrays — the same 2D-array shape every other extract produces —
but cell types and row lengths aren't checked. Getting that right is on
you, just like getting a `bigquery` `query` string right is.

A `custom` source is also the way to reach a Google **Advanced Service** —
`YouTube.Search.list()`, Analytics, Calendar, and so on — instead of a raw
REST call: those are native Apps Script method calls, not URL fetches, so
they can never go through an `api` source's `url`. Note this library's own
internals (including the pagination-walking logic behind the `api`
source's `pagination` key, above) aren't reachable from a `custom` `fn` —
`cli()` is the library's only exposed function — so an
Advanced-Service-backed source that needs to page through results has to
walk them itself inside `fn`.

## Load

`target` is optional — omit it and the node just extracts, returning the
rows without writing them anywhere. Give it a `target` and those same rows
get loaded there too; the node's `result` in the run report is the extracted
rows either way, so you can inspect or reuse them regardless. When a target
*was* given, whatever that connector's load produced — a file id, a BigQuery
job id, an API response — is attached as `result.loadResult`, an extra
property on the returned array rather than a new element, so `result.length`,
`result[i]`, and `JSON.stringify(result)` all behave exactly as if it weren't
there:

```javascript
// Google Sheets — sheetName is optional (defaults to the active sheet,
// created if it doesn't exist yet); mode defaults to 'overwrite'
target: { type: 'sheets', spreadsheetId: '...', sheetName: 'Orders', mode: 'overwrite' }
// .loadResult -> { spreadsheetId, sheetName, startRow, startColumn, numRows }

// Drive file — fileId overwrites an existing file; folderId + fileName
// creates a new one instead
target: { type: 'drive', fileType: 'csv', folderId: '...', fileName: 'orders.csv' }
// .loadResult -> the resulting file's id (string)

// BigQuery — mode defaults to 'append' (WRITE_APPEND); 'overwrite'
// (WRITE_TRUNCATE) must be opted into explicitly
target: { type: 'bigquery', projectId: '...', dataset: 'staging', table: 'orders', mode: 'append' }
// .loadResult -> { projectId, dataset, table, jobId }
// ...with target.sqlTests set (see below), .loadResult also gets
// { staged: { table, jobId }, sqlTestResults: { ran } }

// External API — rows are POSTed as a JSON array of objects
target: { type: 'api', url: 'https://...', options: { /* UrlFetchApp params */ } }
// .loadResult -> { statusCode, body }

// Custom — fn is a function you already defined; it's called as
// fn(rows, target) and its return value passes through as .loadResult
function myCustomLoad(rows, target) {
  // write rows wherever you want
}
// ...
target: { type: 'custom', fn: myCustomLoad }
```

For `sheets` targets, `mode: 'overwrite'` (the default) clears the target
area before writing; `mode: 'append'` writes after the current last row,
leaving existing content alone. Overwrite is the default here because the
common case is refreshing a sheet to reflect the latest extract, and
undoing an accidental overwrite in a spreadsheet is cheap.

- `target.range` (optional) scopes both modes to part of the sheet instead
  of the whole tab — the same idea as `source.range` on the extract side,
  but *not* the same notation: give it a plain, sheet-relative range like
  `'B2:D10'`, with no `'SheetName!'` prefix — `target.sheetName` above
  already picked the sheet, and re-adding a sheet-qualified `source.range`
  string here will fail. In `overwrite` mode, only that literal range gets
  cleared — not the entire sheet, which might hold other tables or notes —
  and writing starts at the range's top-left cell. In `append` mode it
  only pins the starting *column*; the starting row still always comes
  from the sheet's actual last row. Worth knowing: since only the literal
  given range gets cleared, if a previous run wrote more rows than this
  run does, cells past the range from that earlier run won't get cleared
  — that's the tradeoff for not wiping the rest of the sheet on every
  overwrite.
- `target.includeHeader` (default `true`) only matters in `append` mode:
  set it to `false` to append just the data rows, skipping the header row
  always put at `rows[0]` — otherwise every append duplicates the header
  in the middle of the sheet.

For `drive` targets, `csv` and `json` overwrite an existing file's content
directly by `fileId`. `xlsx` can do the same, but overwriting an existing
file's binary content needs the Advanced Drive Service (the same one the
`xlsx` *source* already depends on) — creating a new file via
`folderId`/`fileName` doesn't. `json` targets write the same
array-of-objects shape `drive`/`api` sources read back in — the header row
becomes each object's keys.

- `target.upsertByName` (default `false`, all three `fileType`s) — when
  `true` and you gave `folderId`+`fileName` instead of `fileId`, it first
  looks for an existing file with that exact name in that folder and
  overwrites it if found, creating a new one only if not. Without this,
  the same `folderId`+`fileName` config creates a *new* file on every run,
  since Drive allows duplicate filenames. If more than one file with that
  name already exists in the folder, it won't guess which one to
  overwrite — it throws, and you clean up the duplicates or pass `fileId`
  explicitly instead.

For `bigquery` targets, `mode` defaults to `'append'` rather than
`'overwrite'` — the opposite default from `sheets` — because truncating a
real table is destructive and hard to undo, so that has to be requested
explicitly rather than risked by a missing `mode` key. Rows are uploaded as
a CSV load job.

- `target.schema` (optional) — an array of BigQuery field defs, e.g.
  `[{ name: 'order_id', type: 'STRING' }]`, used instead of the default
  `autodetect: true`. Autodetect infers types from the CSV header/values,
  which can guess wrong for things like a zero-padded id column (`"007"`)
  silently becoming an `INTEGER` — pass `target.schema` when that matters.
- `target.allowSchemaEvolution` (optional, default `false`) — without it,
  a source that has grown a column the destination table doesn't have
  fails the load job outright (safe, but a hard stop until someone
  manually alters the table). Set it `true` and, in `mode: 'append'`
  only, BigQuery is allowed to add a new nullable column and to loosen an
  existing `REQUIRED` column to `NULLABLE` as part of the load — additive
  changes only. A real type change, or a renamed/dropped column, still
  fails the job either way; BigQuery has no schema-evolution option for
  those, and silently coercing or dropping data would be worse than a
  loud failure. Ignored in `mode: 'overwrite'`, since `WRITE_TRUNCATE`
  already replaces the destination schema wholesale on every run.

`target.sqlTests` (optional array of `{ name, query }`) is a `bigquery`-only
extension of the `tests` config described below, for checks that need the
data to already be queryable as a table — referential integrity, an
aggregate/volume check, anything SQL can express that a per-cell JS check
can't. Its presence is what triggers the behavior, the same way `tests`
itself does — omit it (or leave it an empty array) and a `bigquery`
target's load is byte-for-byte what it always was:

```javascript
target: {
  type: 'bigquery', projectId: '...', dataset: 'raw', table: 'orders', mode: 'append',
  sqlTests: [
    {
      name: 'customer_id_exists_in_customers',
      query: 'SELECT s.customer_id FROM {{ this }} s ' +
             'LEFT JOIN `project.raw.customers` c ON s.customer_id = c.customer_id ' +
             'WHERE c.customer_id IS NULL'
    }
  ]
}
```

With `sqlTests` set, a `move()` call to this target:

1. Loads the extracted rows into a brand-new, temporary staging table
   instead of the real one (same `target.schema`/autodetect behavior as a
   direct load).
2. Runs every `sqlTests` query against that staged table, substituting
   `{{ this }}` with the staged table's fully-qualified name — deliberately
   the same placeholder dbt uses for "the table this check is about".
   Each query is expected to return the *offending rows* (any columns);
   zero rows back means that check passed, mirroring dbt's own generic
   test contract.
3. Only if every check passes, promotes the staged data into the real
   target table via a BigQuery copy job, honoring `mode`. With
   `allowSchemaEvolution` also set, a new column on the staged table is
   added to the real table first (BigQuery's copy jobs don't accept
   `schemaUpdateOptions` the way load jobs do, so this widens the
   destination directly instead of relying on the copy job to do it) —
   additive only, same as the direct-load path.
4. Deletes the staging table either way, success or failure.

If any check fails, `move()` throws one combined error (naming every
failing check, its failing-row count, and a few example rows) and the
real target table is **never touched** — the whole point of staging
first. There's no `discard_row` option here (yet): unlike `tests`, which
filters an in-memory array, discarding just the offending staged rows
would need its own delete-then-promote logic that no real use case has
asked for yet.

This costs more than a direct load — a staging table, an extra load job,
one query job per check, and a copy job — so it's opt-in per target, not
a default. `sqlTests[].query` is gated the same read-only-`SELECT` check
a `bigquery` source's query is; it runs under the script's own live
OAuth, so it can read anything that OAuth can, but can't mutate anything.

Every target except `api`/`custom` (which have no "existing state" to
protect - a POST is a POST, and a custom `fn` is on you) skips its
destructive step when `rows` is empty, rather than wiping out real data for
nothing: `sheets` (`overwrite` mode) leaves the target range/sheet
untouched instead of clearing it; `drive` (all three `fileType`s) leaves an
existing file's content untouched instead of overwriting it with an empty
file - though it still *creates* a new file from `folderId`+`fileName` even
with zero rows, since there's no prior data at risk there; `bigquery`
skips the load job entirely instead of running `WRITE_TRUNCATE`/`WRITE_APPEND`
against nothing. This matters most for unattended runs (a flaky source API,
an empty query result, a misconfigured range) where nobody's watching to
catch a real table or sheet getting silently blanked out.

"Empty" means **no data rows**, and every source normalizes to the same
thing: an extract with nothing in it returns `[]`. That's worth stating
because the underlying APIs don't agree — a BigQuery query that matches no
rows still returns its schema, and Sheets hands back `[['']]` (one row, one
blank cell) for an empty sheet or a misconfigured range, as does parsing an
empty CSV. Counted naively those look like one row of data and would sail
straight past the protections above, so the extractors flatten them to `[]`
first. One consequence worth knowing: a source holding *only* a header row
is indistinguishable from an empty one, and is treated as empty.

For `api` targets, `target.options` is merged in after the defaults
(`method: 'post'`, JSON content type, JSON body), so you can override any
of them — a different HTTP method, extra headers, or a different payload
shape entirely.

For `custom` targets, `fn` is called as `fn(rows, target)` — the extracted
rows plus the whole target object, in case your function needs extra
config keys you attached to it — same trust model as a `custom` source's
`fn`: it's a direct function reference from your own project, not a
name to look up. Its return value becomes `.loadResult`, mirroring how a
`custom` *source*'s return value becomes the extracted rows.

## Tests

`tests` is an optional array of checks run against the extracted rows,
before a `target` (if any) is loaded — validate what's about to be
written, with a declared severity, instead of finding out only after bad
data has landed. Each entry names a `column` (by header) and a `check`:

```javascript
tests: [
  { column: 'order_id', check: 'not_null' },
  { column: 'order_id', check: 'unique' },
  { column: 'status', check: 'accepted_values', values: ['open', 'closed', 'refunded'] },
  { column: 'amount', check: 'min', value: 0 },
  { column: 'discount', check: 'max', value: 1 },
  { column: 'email', check: 'regex', pattern: '^[^@]+@[^@]+\\.[^@]+$' }
]
```

`accepted_values` needs `values` (an array) and checks each cell against
it with exact equality, no type coercion — a numeric or boolean cell from
a typed source (Sheets, BigQuery) won't match a config array of strings,
so stringify `values` (or the source column) if that matters for your
data. `min`/`max` need `value` (a number — cells are coerced with
`Number()` before comparing) and, like `not_null` and `unique`, treat a
blank/`null`/`undefined` cell as "no value" rather than `0` — a blank cell
fails a `min`/`max` test instead of silently satisfying it. `regex` needs
`pattern` (a string); it's validated and compiled once when the node
runs, not once per cell, so an invalid pattern is a clear `move(): ...`
config error the moment you run it rather than a raw `SyntaxError` buried
inside a failing row. `unique` skips blank cells rather than counting
repeats of "nothing" as a duplicate, since `not_null` already owns that
check.

Every test's own shape — a known `check`, its required extra key, a
`regex` pattern that actually compiles — is validated the moment the node
runs, even if the extract came back with zero data rows to check: a
misconfigured test throws immediately rather than staying silent until a
run happens to see real data. Once there is data, every test still runs
regardless of outcome, before any decision is made — one `move()` call
reports every violation at once rather than stopping at the first
failure. What happens to a failing test is controlled by `onFailure`,
settable per test or once for the whole node via `onTestFailure`
(node-level is the fallback when a test doesn't set its own); the default
is `'raise'` either way:

- `'raise'` — throws one combined `move(): ...` error listing every
  failing test, its failure count, and a few example row numbers (1-indexed
  as a human would read them in a spreadsheet, header counted as row 1).
  The error aborts the node like any other `move()` misconfiguration, so
  `cli()`'s existing failure propagation applies: any node that
  `dependsOn` this one is skipped, not just this one failing — see
  "What cli() returns" in [docs/cli.md](cli.md).
- `'discard_row'` — drops just the rows that failed it and lets the rest
  load normally; a row failing more than one `discard_row` test is only
  dropped once. The node still reports `'success'`, so nothing downstream
  is blocked — pick this only for checks where loading the good 99% and
  quietly dropping the bad 1% is actually the outcome you want.

Either way, a pass/discard summary is attached as `result.testResults`
(`{ ran, discarded }`) — an extra property on the returned rows array,
same non-intrusive pattern as `.loadResult`. Tests are skipped entirely
when there are no data rows to check, consistent with "empty means `[]`"
everywhere else in `move`.

Referential checks across tables (dbt's `relationships` test) are out of
scope for `tests` — they'd need to query another table, which a check
running against an in-memory 2D array can't do. For a `bigquery` target
specifically, `target.sqlTests` (above) covers that case instead, by
running SQL against the data after it's staged in BigQuery rather than
against the extracted rows in Apps Script memory. Checking one *model*
against another (rather than incoming `move` rows against an existing
table) has its own, more direct `relationships` check — see
[docs/model.md](model.md)'s "Tests" section.
