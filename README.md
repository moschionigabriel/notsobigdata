# Not So Big Data

A declarative ELT library for Google Apps Script — move data, model it with
SQL, and run the whole pipeline in dependency order, entirely inside a tool
you probably already have open.

> **Status: early-stage / pre-alpha.**
> This library is still taking shape. The `move` kind implements both halves
> of "EL" — extract (reading a source into a 2D array) and load (writing that
> array into a target) — for Sheets, Drive (CSV/XLSX/JSON), BigQuery,
> external APIs, and your own custom functions, and `cli()` runs those nodes
> in dependency order. The `model` kind (the "T") is not implemented yet.
> Watch this repo for progress.

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

## How it works

You don't call a function per pipeline step. You **declare** each step as a
plain object, and one entrypoint — `cli()` — finds them all, works out the
right order from the dependencies you declared, and runs them:

```javascript
// Top level of a .gs file — see the scope warning under Installation.
eval(UrlFetchApp.fetch('https://raw.githubusercontent.com/moschionigabriel/notsobigdata/main/src.js').getContentText())

var props = PropertiesService.getScriptProperties().getProperties();

var rawOrders = {
  kind: 'move',
  source: { type: 'drive', fileId: props.ORDERS_CSV, fileType: 'csv' },
  target: { type: 'bigquery', projectId: props.BQ_PROJECT, dataset: 'staging', table: 'orders' }
};

var rawCustomers = {
  kind: 'move',
  source: { type: 'sheets', spreadsheetId: props.CUSTOMERS_SHEET },
  target: { type: 'bigquery', projectId: props.BQ_PROJECT, dataset: 'staging', table: 'customers' }
};

var ordersReport = {
  kind: 'move',
  dependsOn: ['rawOrders', 'rawCustomers'],
  source: { type: 'bigquery', projectId: props.BQ_PROJECT, query: 'SELECT ... FROM staging.orders JOIN staging.customers USING (customer_id)' },
  target: { type: 'sheets', spreadsheetId: props.REPORT_SHEET, sheetName: 'Orders' }
};

function runPipeline() {
  var report = NotSoBigData.cli('run');
  Logger.log(report.ok);
}
```

`rawOrders` and `rawCustomers` have nothing to wait for, so they run first;
`ordersReport` runs after both. You never wrote that order down — you wrote
the *dependencies*, and the order follows from them.

If dbt is familiar: this is the same posture. You don't call each model, you
declare models and run `dbt run --select ...`. If dbt isn't familiar, the
closer analogy is a spreadsheet — you don't tell the sheet which formula to
recalculate first, you write the cell references and it figures the order
out.

## Installation

The library is pulled into your Apps Script project at runtime — no package
manager, no build step, just one line:

```javascript
eval(UrlFetchApp.fetch('https://raw.githubusercontent.com/moschionigabriel/notsobigdata/main/src.js').getContentText())
```

> **Where you put your code matters — for two things.**
>
> **1. The `eval()` line.** A direct `eval()` call's declarations only become
> visible in the scope of whatever function called it — never beyond it. Put
> this line at the top level of your file (outside any function), or inline
> it in the exact same function that then calls `cli()`. Routing it through a
> separate loader function will silently break — the library disappears the
> moment that function returns, and you'll get a `ReferenceError`.
>
> **2. Your config objects.** The same rule applies to everything you
> declare. `cli()` finds nodes by scanning the global scope, which only
> contains top-level `var` declarations. A config object declared *inside* a
> function is invisible to `cli()` — it won't error, it just won't be there.
> Declare your nodes at the top level of a file, and run `cli('hello')` if
> you're ever unsure what the library can actually see.

**A note on what you're trusting.** That URL points at the `main` branch,
which means your project runs whatever `main` says today, with your OAuth
access to your Drive, Sheets and BigQuery. That's the tradeoff for having no
build step and no package manager: you get fixes automatically, and you're
trusting this repo continuously rather than once. If you'd rather pin, swap
`main` for a tag or a commit SHA in the URL and update it deliberately —
same install, one word different.

## cli()

`cli()` is the library's only public function. It takes one command string:

```javascript
NotSoBigData.cli('run')                     // run every declared node, in dependency order
NotSoBigData.cli('run --select move')       // run only nodes of a given kind
NotSoBigData.cli('run --select rawOrders')  // run only that node
NotSoBigData.cli('run --select a,b')        // run only these, ordered among themselves
NotSoBigData.cli('run --exclude a')         // run everything except these
NotSoBigData.cli('list')                    // show what would run, in order — runs nothing
NotSoBigData.cli('hello')                   // check the library loaded and see what it can find
NotSoBigData.cli('help')                    // the command list
```

A `--select`/`--exclude` token is matched against node **kinds** first, then
node **names**, so `--select move` means "every move node" and
`--select rawOrders` means that one node. Both `--select a,b` and
`--select=a,b` work. A token matching neither a kind nor a name is an error
rather than an empty run — silently doing nothing is the failure this design
guards against hardest.

A token matching **both** — a node you named `move`, say, since a node's name
defaults to its variable name — is also an error, for the same reason.
Preferring the kind there would make `--exclude move` quietly drop every move
node in the project when you meant to drop one. Rename the node, or name the
ones you mean explicitly.

`--select` selects exactly what it names; it does **not** pull in upstream
dependencies, which are assumed to have run already. (dbt spells that
distinction `orders` vs `+orders`; those `+` operators aren't in this first
version.)

### cli('hello') — start here when something's wrong

This is the smoke test, and the only command that never throws. It checks
both fragile things at once: that the `eval()` install actually put the
library in scope, and that the global scan can see your declared nodes.

```
notsobigdata loaded OK. Kinds available: move.
Discovered 3 node(s): rawOrders (move), rawCustomers (move), ordersReport (move).
```

Finding zero nodes is reported as a finding, not an error — with a reminder
about the top-level-`var` rule, since that's almost always the cause.
Objects carrying an unrecognized `kind` are listed too, so a typo like
`kind: 'mvoe'` shows up instead of silently doing nothing.

### What cli() returns

`hello` and `help` return their message as a string. `run` and `list` return
a report:

```javascript
{
  ok: false,
  command: 'run',
  nodes: [
    { name: 'rawOrders',    kind: 'move', status: 'success', ms: 1840, result: [ ... ] },
    { name: 'rawCustomers', kind: 'move', status: 'failed',  ms: 210,  error: 'move(): ...' },
    { name: 'ordersReport', kind: 'move', status: 'skipped', blockedBy: ['rawCustomers'] }
  ],
  ignored: []
}
```

A failure doesn't abort the run. The failed node is recorded, everything
downstream of it is marked `skipped` (transitively — a skipped node blocks
its own dependents too), and **unrelated branches still run**. That matters
more here than in a normal scheduler: each run is you clicking Run in the
Apps Script editor and waiting, so seeing every independent failure in one
pass beats fixing them one run at a time. Under `list`, every node's status
is `planned` and nothing executes.

## Declaring a node

Any top-level `var` holding an object with a `kind` key is a node.

| Key | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | Which kind of step this is. Currently only `'move'`. |
| `name` | no | The node's name, used by `dependsOn` and `--select`. Defaults to the variable name you declared it as. |
| `dependsOn` | no | Array of node names this one must run after. |

Everything else on the object is that kind's own config — for `move`, the
`source` and `target` described below.

Note `kind` is not the same key as `source.type`/`target.type`. `kind` says
what sort of *step* this is; `type` says which *connector* the step reads
from or writes to.

Node names must be unique, and every `dependsOn` entry must name a node that
exists — both are checked before anything runs, against every declared node
rather than just the selected ones, so narrowing a run with `--select` can
never turn a typo into a silently ignored dependency.

A dependency cycle is caught before anything runs too, and the error names
the nodes involved. Cycle detection runs against the *selected* nodes rather
than all of them — edges pointing outside the selection are dropped, since
running a subset means assuming its upstreams already ran, so a cycle passing
through an unselected node can't deadlock the run anyway.

## The `move` kind — extract

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
`xlsx` files are converted to a temporary Google Sheet under the hood (Apps
Script has no native XLSX parser), read, and the temporary copy is deleted
immediately after — this requires the Advanced Drive Service enabled in
your Apps Script project.

For `bigquery` sources, `table`/`query`/`queryFileId` are mutually
exclusive — pick one (`table` also requires `dataset`). `query` and
`queryFileId` must be a single, read-only `SELECT` (a leading `WITH` is
fine, for CTEs) — a multi-statement script (statements separated by `;`)
or anything other than a read is rejected before it reaches BigQuery. This
isn't a hard security boundary, just a keyword/shape check to keep `move`
read-only — declaring transformations that write or modify data will be the
`model` kind's job, not `move`'s.

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

## The `move` kind — load

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

## The `move` kind — tests

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

`accepted_values` needs `values` (an array), `min`/`max` need `value` (a
number — cells are coerced with `Number()` before comparing), and `regex`
needs `pattern` (a string, compiled with `new RegExp()`). `unique` and
`not_null` treat a blank/`null`/`undefined` cell as "no value" — `unique`
skips those cells rather than counting repeats of "nothing" as a
duplicate, since `not_null` already owns that check.

Every test runs, regardless of outcome, before any decision is made — one
`move()` call reports every violation at once rather than stopping at the
first failure. What happens to a failing test is controlled by
`onFailure`, settable per test or once for the whole node via
`onTestFailure` (node-level is the fallback when a test doesn't set its
own); the default is `'raise'` either way:

- `'raise'` — throws one combined `move(): ...` error listing every
  failing test, its failure count, and a few example row numbers (1-indexed
  as a human would read them in a spreadsheet, header counted as row 1).
  The error aborts the node like any other `move()` misconfiguration, so
  `cli()`'s existing failure propagation applies: any node that
  `dependsOn` this one is skipped, not just this one failing — see
  "What cli() returns" above.
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
scope — they'd need to query another table, which isn't `move`'s job.

## The `model` kind — not implemented yet

The plan, illustrative of the intended shape and not usable today: SQL
stored in `.html` files, referencing other models dbt-style with
`{{ ref('model_name') }}`, so a model's dependencies come from the SQL
itself rather than from a hand-written `dependsOn`.

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
var ordersSummary = { kind: 'model', sqlFile: 'models/orders_summary.sql.html' };
```

It would then be just another node: `cli('run')` picks it up alongside your
`move` nodes and orders the whole graph together.

## Scheduling

There's no separate scheduler. A `cli('run')` call is an ordinary Apps
Script function call, so point an Apps Script time-based (installable)
trigger at a function that calls it and the pipeline runs unattended — no
external orchestrator required.

## Design philosophy

- **No infra required.** No git, no CI/CD, no server — just Apps Script.
- **Declarative over imperative.** You describe *what* should move or be
  modeled, and what depends on what — not the order to do it in.
- **One front door.** A single `cli()` entrypoint, rather than a function
  per module, so there's one thing to learn and one place ordering happens.
- **Right-sized for small data.** Built for the volume most business teams
  actually have, without dragging in tooling meant for a different scale.

## Project status & lineage

This is a clean-slate redesign, informed by an earlier prototype,
[tinydeskdata](https://github.com/moschionigabriel/tinydeskdata), that
proved out the same idea. Contribution guidelines and development workflow
live in `CLAUDE.md` for now.

If you're working *on* the library rather than with it: `src.js` is a
generated file, built by `./build.sh` from the modules in `src/`
(`move.js`, `model.js`, `cli.js`). Edit those and rebuild — edits made to
`src.js` directly are overwritten by the next build. It stays committed so
that installing remains a single `eval()` of a single URL.
