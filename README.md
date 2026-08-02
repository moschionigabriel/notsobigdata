# Not So Big Data

A declarative ELT library for Google Apps Script — move data, model it with
SQL, and orchestrate the whole pipeline, entirely inside a tool you
probably already have open.

> **Status: early-stage / pre-alpha.**
> This library is still taking shape. `move()` implements both halves of
> "EL" — extract (reading a source into a 2D array) and load (writing that
> array into a target) — for Sheets, Drive (CSV/XLSX/JSON), BigQuery,
> external APIs, and your own custom functions. `model()` and
> `orchestrate()` are not implemented yet. Watch this repo for progress.

## What is this for?

If you've done analytics work in a business team without a "real" data
platform, this is for you: no CI/CD, no dedicated infra, often just a
BigQuery IDE or a folder of spreadsheets — but still expected to deliver
reliable, high-quality pipelines.

Not So Big Data brings good practices from big-data engineering — declarative
pipelines, dependency-ordered transforms, testable models — into an
environment that has none of the infrastructure big-data tooling assumes it
can lean on. It runs entirely inside Google Apps Script, using its native
connections to Drive and BigQuery, so it works with data that's already
living in Sheets and Drive as part of your existing workflows.

It's built around three primitives:

- **`move()`** — extract-and-load data between sources and targets (Sheets,
  Drive files, BigQuery, external APIs), covering the "EL" of ELT.
- **`model()`** — declare SQL transformations, dbt-style, covering the "T".
- **`orchestrate()`** — declare dependencies between `move()` and `model()`
  steps and run them in the right order.

## Planned installation

Once available, the library will be pulled into your Apps Script project at
runtime — no package manager, no build step, just one line:

```javascript
eval(UrlFetchApp.fetch('https://raw.githubusercontent.com/moschionigabriel/notsobigdata/main/src.js').getContentText())
```

> **Where to put that line matters.** A direct `eval()` call's declarations
> only become visible in the scope of whatever function called it — never
> beyond it. Put this line at the top level of your file (outside any
> function), or inline it in the exact same function where you then call
> `move()`/`model()`/`orchestrate()`. Routing it through a separate loader
> function will silently break — the library disappears the moment that
> function returns, and you'll get a `ReferenceError` instead.

## Planned usage

The `model()` and `orchestrate()` examples below are illustrative of the
intended API shape — not final, and not usable yet. `move()` is implemented
as shown.

### move()

`move()` extracts a `source` into a 2D array — the same shape Apps Script
already uses for Sheets ranges — and, if you also give it a `target`, loads
that array there too:

```javascript
// Google Sheets — range is optional; omit it to read the whole active sheet
move({ source: { type: 'sheets', spreadsheetId: '...', range: 'Orders!A1:F' } })

// Drive file — fileType selects the parser: 'csv', 'xlsx', or 'json'
move({ source: { type: 'drive', fileId: '...', fileType: 'csv' } })

// BigQuery — exactly one of table, query, or queryFileId
move({ source: { type: 'bigquery', projectId: '...', dataset: 'staging', table: 'orders' } })
move({ source: { type: 'bigquery', projectId: '...', query: 'SELECT customer, SUM(amount) AS total FROM staging.orders GROUP BY 1' } })
move({ source: { type: 'bigquery', projectId: '...', queryFileId: '<drive file id of a .sql file>' } })

// External API — expects a JSON array of objects in the response body
move({ source: { type: 'api', url: 'https://...', options: { /* UrlFetchApp params */ } } })

// Custom — fn is a function you already defined in your own Apps Script
// project; move() calls it as fn(source) and uses its return value directly
function myCustomExtract(source) {
  return [['col1', 'col2'], ['a', 1], ['b', 2]];
}
move({ source: { type: 'custom', fn: myCustomExtract } })
```

For `drive` and `api` sources, a JSON array of objects is flattened into a
header row plus data rows using the **union of every object's keys** as the
column list — any object missing a given key just gets a blank cell there.
`xlsx`
files are converted to a temporary Google Sheet under the hood (Apps
Script has no native XLSX parser), read, and the temporary copy is deleted
immediately after — this requires the Advanced Drive Service enabled in
your Apps Script project.

For `bigquery` sources, `table`/`query`/`queryFileId` are mutually
exclusive — pick one (`table` also requires `dataset`). `query` and
`queryFileId` must be a single, read-only `SELECT` (a leading `WITH` is
fine, for CTEs) — a multi-statement script (statements separated by `;`)
or anything other than a read is rejected before it reaches BigQuery. This
isn't a hard security boundary, just a keyword/shape check to keep
`move()` read-only — declaring transformations that write or modify data
is `model()`'s job, not `move()`'s.

For `custom` sources, `fn` is a direct reference to a function you've
already defined elsewhere in your Apps Script project — not a function
name to look up, so there's no global-scope lookup or `eval` involved.
`move()` calls it as `fn(source)`, passing the whole source object back in
case your function needs any extra config keys you attached to it, and
checks that the return value is an array of arrays — the same 2D-array
shape every other extract function produces — but does not check cell
types or that every row is the same length. Getting that part right is on
you, just like it's on you to get a `bigquery` `query` string right.

### move() — load

`target` is optional — omit it and `move()` behaves exactly like an
extract-only call, returning the rows without writing them anywhere. Give
it a `target` and those same rows get loaded there too; `move()` always
returns the extracted rows either way, so you can inspect or reuse them
regardless of whether a target was given. When a target *was* given,
whatever that connector's load produced — a file id, a BigQuery job id,
an API response — is attached as `rows.loadResult`, an extra property on
the returned array rather than a new element, so `rows.length`,
`rows[i]`, and `JSON.stringify(rows)` all behave exactly as if it weren't
there:

```javascript
// Google Sheets — sheetName is optional (defaults to the active sheet,
// created if it doesn't exist yet); mode defaults to 'overwrite'
var result = move({
  source: { type: 'bigquery', projectId: '...', dataset: 'staging', table: 'orders' },
  target: { type: 'sheets', spreadsheetId: '...', sheetName: 'Orders', mode: 'overwrite' }
})
// result.loadResult -> { spreadsheetId, sheetName, startRow, startColumn, numRows }

// Drive file — fileId overwrites an existing file; folderId + fileName
// creates a new one instead
move({
  source: { type: 'sheets', spreadsheetId: '...' },
  target: { type: 'drive', fileType: 'csv', folderId: '...', fileName: 'orders.csv' }
})
// .loadResult -> the resulting file's id (string)

// BigQuery — mode defaults to 'append' (WRITE_APPEND); 'overwrite'
// (WRITE_TRUNCATE) must be opted into explicitly
move({
  source: { type: 'drive', fileId: '...', fileType: 'csv' },
  target: { type: 'bigquery', projectId: '...', dataset: 'staging', table: 'orders', mode: 'append' }
})
// .loadResult -> { projectId, dataset, table, jobId }

// External API — rows are POSTed as a JSON array of objects
move({
  source: { type: 'sheets', spreadsheetId: '...' },
  target: { type: 'api', url: 'https://...', options: { /* UrlFetchApp params */ } }
})
// .loadResult -> { statusCode, body }

// Custom — fn is a function you already defined; move() calls it as
// fn(rows, target) and passes its return value through as .loadResult
function myCustomLoad(rows, target) {
  // write rows wherever you want
}
move({
  source: { type: 'sheets', spreadsheetId: '...' },
  target: { type: 'custom', fn: myCustomLoad }
})
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
  `move()` always puts at `rows[0]` — otherwise every append duplicates
  the header in the middle of the sheet.

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
  name already exists in the folder, `move()` won't guess which one to
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

### model()

```html
<!-- models/orders_summary.sql.html -->
<script type="text/sql">
  select
    customer_id,
    count(*) as order_count
  from {{ ref('stg_orders') }}
  group by 1
</script>
```

```javascript
model({ name: 'orders_summary' })
```

SQL models are stored in `.html` files and reference each other dbt-style
with `{{ ref('model_name') }}`; dependencies are resolved automatically
from those references.

### orchestrate()

```javascript
orchestrate({
  nodes: [
    { name: 'load_orders', move: { /* ... */ } },
    { name: 'orders_summary', model: { /* ... */ }, dependsOn: ['load_orders'] }
  ]
})
```

Nodes run in dependency order. Orchestration can be triggered manually or
scheduled with Apps Script's own time-based triggers — no external
scheduler required.

## Design philosophy

- **No infra required.** No git, no CI/CD, no server — just Apps Script.
- **Declarative over imperative.** You describe *what* should move or be
  modeled, not how to do it step by step.
- **Right-sized for small data.** Built for the volume most business teams
  actually have, without dragging in tooling meant for a different scale.

## Project status & lineage

This is a clean-slate redesign, informed by an earlier prototype,
[tinydeskdata](https://github.com/moschionigabriel/tinydeskdata), that
proved out the same idea. Contribution guidelines and development workflow
live in `CLAUDE.md` for now.
