# cli() reference

`cli()` is Not So Big Data's only public function — see the main
[README](../README.md) for installation and the "declare, don't call"
model. This page covers full command behavior, logging, the run manifest,
and how a node is declared. For the `move` kind's `source`/`target` config
see [docs/move.md](move.md); for the `model` kind see
[docs/model.md](model.md).

## Commands

`cli()` takes one command string:

```javascript
NotSoBigData.cli('run')                     // run every declared node, in dependency order
NotSoBigData.cli('run --select move')       // run only nodes of a given kind
NotSoBigData.cli('run --select rawOrders')  // run only that node
NotSoBigData.cli('run --select a,b')        // run only these, ordered among themselves
NotSoBigData.cli('run --exclude a')         // run everything except these
NotSoBigData.cli('list')                    // show what would run, in order — runs nothing
NotSoBigData.cli('compile')                 // resolve model SQL, without running anything
NotSoBigData.cli('compile --select orders') // resolve just that model's SQL
NotSoBigData.cli('debug')                   // check OAuth scopes/services per connector, without writing anything
NotSoBigData.cli('debug --select orders')   // check just that node's connector(s)
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

### cli('compile') — see the SQL before it runs

Like `list`, `compile` is a dry run — nothing executes against BigQuery,
Sheets, or Drive. Unlike `list`, it also resolves every `model` node's SQL —
substituting `{{ ref() }}`, `{{ var() }}` and stripping `{{ config() }}`,
exactly the substitution `run` itself does right before issuing a BigQuery
job — and hands you the result, so you can see precisely what would run
without running it. This is the same job dbt's own `dbt compile` does.

```javascript
NotSoBigData.cli('compile')                  // resolve every model's SQL
NotSoBigData.cli('compile --select orders')  // just that model
```

A `move` node has no `{{ }}`-style templating to resolve, so it's reported
`planned` under `compile` exactly the way it already is under `list` — no
`compiledSql`, nothing else attached. Only `model` nodes get one.

### cli('debug') — check your OAuth scopes/services before cli('run') does

This exists because of how the library installs. Apps Script normally
auto-detects which OAuth scopes and Advanced Services a project needs by
scanning that project's own `.gs` files for the calls that need them — the
reason you don't usually have to hand-edit `appsscript.json` yourself. But
notsobigdata is installed with `eval(UrlFetchApp.fetch(...).getContentText())`
(see the [README](../README.md)'s "Installation"), so the `DriveApp` /
`SpreadsheetApp` / `BigQuery` / `UrlFetchApp` calls this library makes live
inside a string that scan never sees. The scope or service they need can
end up missing from your project with no authorization prompt ever shown
for it — the first sign is usually a bare permission error buried inside a
real `cli('run')`. `cli('debug')` checks for that gap directly, connector by
connector, before you're relying on a real run to find it.

```javascript
NotSoBigData.cli('debug')                 // check every node's connector(s)
NotSoBigData.cli('debug --select orders') // just that node's
```

For every selected node, `debug` checks each connector it declares — a
`move` node's `source` and `target`, or a `model` node's implicit BigQuery
target — and reports one of:

| Status | Meaning |
| --- | --- |
| `ok` | The connector responded — scope/service is fine. |
| `missing_scope` | The call was rejected for what looks like a permission/scope reason. The message names the underlying error and reminds you to add the scope to `appsscript.json` by hand (see above — a re-authorization prompt won't add it for you). |
| `service_not_enabled` | BigQuery only. The `BigQuery` Advanced Service itself isn't turned on for this project — a different switch from an OAuth scope (Apps Script editor → Services → add "BigQuery API", and confirm the BigQuery API is enabled on the linked GCP project). |
| `error` | Something else went wrong (e.g. a real 404 on a resource that doesn't exist) — not treated as a scope problem. |
| `unverifiable` | A `custom` source/target calls your own function. `debug` has no way to know what services it uses, so it isn't checked. |

**`debug` never writes.** A source connector's check is (as close as
possible to) the real read `move()` would do — `url`/`api` sources are
already GET-only, so checking one *is* the real request. A target
connector's check is a read-only stand-in for the same resource instead:
opening a spreadsheet/file/folder rather than writing to it, reading
BigQuery dataset metadata rather than running a load job. The one
compromise is an `api` target: its real call (`loadApi`) always POSTs a
JSON body, so `debug` sends a GET to the same URL instead, to avoid
re-triggering whatever your endpoint does on POST. That means a POST-only
endpoint reads back as reachable-but-non-2xx, not as an auth failure —
`debug` only cares whether `UrlFetchApp` itself was allowed to make the
call, not what status code came back.

A `model` node with a broken SQL file/config (a `discoveryError` — the same
thing `cli('list')`/`cli('compile')` already surface) reports `error` for
its BigQuery check too, since the `projectId`/`dataset` it would check
against are only resolved once every other discovery-time check on that
model has already passed.

`debug` returns its own report shape, not the `nodes[]` shape `run`/
`list`/`compile` share, and writes no manifest — it's a diagnostic dry run,
not a record of pipeline output:

```javascript
{
  ok: false,
  command: 'debug',
  checks: [
    { node: 'rawOrders', kind: 'move',  role: 'source', type: 'sheets',   status: 'ok',            message: 'opened spreadsheet ...' },
    { node: 'rawOrders', kind: 'move',  role: 'target', type: 'bigquery', status: 'missing_scope',  message: 'bigquery target: ... - Apps Script only auto-adds ...' },
    { node: 'orders',    kind: 'model', role: 'target', type: 'bigquery', status: 'service_not_enabled', message: 'BigQuery is not available as a "BigQuery" service ...' }
  ],
  ignored: []
}
```

`ok` is `true` only when every check is `ok` or `unverifiable`. The
execution log gets one line per check — `OK`/`SKIP`/`FAIL`, reusing the
same prefixes `run` already uses, `SKIP` standing in for `unverifiable`
since a custom connector was deliberately not checked rather than found
broken:

```
START cli("debug")
OK    rawOrders (move) source (sheets) - opened spreadsheet ...
FAIL  rawOrders (move) target (bigquery) - bigquery target: ...
SKIP  loadToWebhook (move) target (custom) - custom target calls your own "fn" - cli('debug') has no way to know what services it uses.
DONE  cli("debug") - 1 ok, 1 missing scope, 1 unverifiable (3 total).
```

### What cli() returns

`hello` and `help` return their message as a string. `debug` returns its
own report shape — see [above](#clidebug-check-your-oauth-scopesservices-before-clirun-does).
`run`, `list` and `compile` share this one:

```javascript
{
  ok: false,
  command: 'run',
  nodes: [
    { name: 'rawOrders',    kind: 'move', status: 'success', ms: 1840, result: [ ... ] },
    { name: 'rawCustomers', kind: 'move', status: 'failed',  ms: 210,  error: 'move(): ...' },
    { name: 'ordersReport', kind: 'move', status: 'skipped', blockedBy: ['rawCustomers'] }
  ],
  ignored: [],
  manifest: { written: true, fileId: '...' }
}
```

A failure doesn't abort the run. The failed node is recorded, everything
downstream of it is marked `skipped` (transitively — a skipped node blocks
its own dependents too), and **unrelated branches still run**. That matters
more here than in a normal scheduler: each run is you clicking Run in the
Apps Script editor and waiting, so seeing every independent failure in one
pass beats fixing them one run at a time. Under `list`, every node's status
is `planned` and nothing executes. Under `compile`, every node is also
`planned` — a `model` node additionally carries `compiledSql`, and a model
that fails to compile (rare — most template mistakes are already caught
before this point) is `failed` instead, blocking its dependents the same
way a real run failure does:

```javascript
{
  ok: true,
  command: 'compile',
  nodes: [
    { name: 'rawOrders', kind: 'move',  status: 'planned' },
    { name: 'orders',    kind: 'model', status: 'planned', compiledSql: 'SELECT * FROM `proj.ds.rawOrders`' }
  ],
  ignored: [],
  manifest: { written: true, fileId: '...' }
}
```

`manifest` is present on `run` and `compile`, never `list` (a pure dry run
with nothing, not even compiled SQL, to record) or `debug` (a diagnostic
check, not a record of pipeline output — see [its own section
above](#clidebug-check-your-oauth-scopesservices-before-clirun-does)), and
is always one of:

```javascript
{ written: true, fileId: '...' }                      // wrote/overwrote the manifest file
{ written: false, reason: 'disabled' }                 // *Manifest.enabled is false
{ written: false, reason: 'error', error: '...' }      // Drive write failed - never throws, never affects ok
```

## Logging

`cli()` writes to the Apps Script execution log ([`Logger.log`](https://developers.google.com/apps-script/reference/base/logger)) so you can
watch a run happen live in the editor, or read back what happened afterward.
By default it's kept proportional to what needs your attention, not to how
many nodes happened to succeed:

```
START cli("run")
START rawOrders (move)
START rawCustomers (move)
FAIL  rawCustomers (move) - move(): ...
SKIP  ordersReport (move) - waiting on rawCustomers
DONE  cli("run") - 1 passed, 1 failed, 1 skipped (3 total).
MANIFEST written to <id>
```

Every node that actually runs logs a `START` line right before it starts —
so a node in the middle of a slow BigQuery job still shows up as "in
progress," not silence — and `FAIL`/`SKIP` always log too, since those are
exactly the lines you need to see. A node that *succeeds*, though, doesn't
get its own confirmation line by default: `START` plus the absence of a
`FAIL`/`SKIP` line already tells you nothing went wrong, and the detail an
`OK` line would add (row count, elapsed time) is never actually lost —
it's always in the returned `report.nodes[]` and, for `run`, the [Drive
manifest](#the-run-manifest) below, whether or not it hits the console.
`cli('list')`'s dry run only ever logs one `PLAN` line per node — nothing
executes, so there's no "in progress" to signal. `cli('compile')` logs the
same `PLAN` line (with " - compiled" appended for a `model` node that
resolved successfully), or `FAIL` for one that didn't. `cli('debug')` logs
one `OK`/`FAIL`/`SKIP` line per connector checked (not per node — a `move`
node with both a `source` and a `target` gets two lines), reusing those
same three prefixes; `SKIP` means a `custom` connector wasn't checked, not
that anything failed. See [its own section
above](#clidebug-check-your-oauth-scopesservices-before-clirun-does) for
the full log example.

Want the full detail back, e.g. while actively debugging a run? Set
`verbose: true`:

```javascript
var notsobigdataLogging = {
  verbose: false   // set true to also log an OK line for every successful node
};
```

```
START cli("run")
START rawOrders (move)
OK    rawOrders (move) - 1200 rows, 340ms
START rawCustomers (move)
OK    rawCustomers (move) - 80 rows, 210ms
DONE  cli("run") - 2 passed (2 total).
```

## The run manifest

Every `cli('run ...')` writes a small JSON file to Drive — a dbt-`manifest.json`-
style record of what happened, meant to be opened and read by a human. It's
overwritten in place on every run (not appended to), so it always reflects
the most recent run, not a history. If it can't find the file afterward, the
execution log has a `MANIFEST written to <id>` / `MANIFEST skipped - ...` /
`MANIFEST failed - ...` line saying exactly what happened — no need to
inspect `report.manifest` in code just to find out:

```json
{
  "notsobigdata": "manifest",
  "version": 1,
  "generatedAt": "2026-08-06T12:34:56.789Z",
  "command": "run --select move",
  "ok": false,
  "nodes": [
    { "name": "rawOrders", "kind": "move", "status": "success", "ms": 1840, "rowCount": 1200, "columnCount": 8 },
    { "name": "rawCustomers", "kind": "move", "status": "failed", "ms": 210, "error": "move(): ..." },
    { "name": "ordersReport", "kind": "move", "status": "skipped", "blockedBy": ["rawCustomers"] }
  ],
  "ignored": []
}
```

It never contains the actual rows a node moved — only their shape
(`rowCount`/`columnCount`) plus each target's own small `loadResult`/
`testResults`, if present, or — for a `model` node — the `relation` it
materialized and as which (`materialized: 'view'` or `'table'`), plus its
own `testResults` if it declared `tests` (see [docs/model.md](model.md)).
A `table` model with `tests` also carries `staged: { table: '...' }`,
naming the scratch table its data was tested in before being promoted —
purely informational, since that table is already deleted by the time the
manifest is written; it just records that this run went through the
staged-then-promoted path at all. This keeps the file's size independent
of how much data your pipeline actually moves.

On by default. Configure it with an optional top-level `var`, same
declaration style as a node:

```javascript
var notsobigdataManifest = {
  enabled: true,                           // set false to turn it off entirely
  folderId: null,                          // default: auto-detected, the folder the Apps Script project itself lives in
  fileName: 'notsobigdata-manifest.json'   // default filename inside that folder
};
```

All three keys are optional — omit the whole `var` to get every default.

## The compile manifest

Every `cli('compile ...')` writes its own small JSON file to Drive — same
upsert-by-name shape as the run manifest above, but a **separate file**,
never the run manifest itself. A compile pass doesn't touch BigQuery,
Sheets, or Drive, so overwriting the run manifest with it would replace the
record of what your last real run actually did with a record of a run that
never happened. The execution log has the same three-outcome line, prefixed
`COMPILE MANIFEST` instead of `MANIFEST`, so you can tell the two apart at a
glance.

If `notsobigdataManifest` and `notsobigdataCompileManifest` are configured
with the same `folderId` + `fileName` (only possible if you set at least
one of them explicitly — the defaults never collide), neither manifest is
written: `cli('run')` and `cli('compile')` would otherwise silently
overwrite each other's file, so both refuse instead, logging a
`MANIFEST failed - .../COMPILE MANIFEST failed - ...` line that names
which two globals collided. Give one of them its own `folderId` or
`fileName` to fix it — this doesn't affect `report.ok` or any node's own
result, only whether the manifest file itself gets written.

```json
{
  "notsobigdata": "manifest",
  "version": 1,
  "generatedAt": "2026-08-09T12:34:56.789Z",
  "command": "compile --select orders",
  "ok": true,
  "nodes": [
    { "name": "orders", "kind": "model", "status": "planned", "compiledSql": "SELECT * FROM `proj.ds.rawOrders`" }
  ],
  "ignored": []
}
```

Unlike the run manifest, this one *does* carry full SQL text per model —
being able to open the file and read exactly what would run is the entire
point of it existing, and unlike a `move` node's rows, compiled SQL text is
never large enough to make file size a concern.

On by default, configured the same way as the run manifest, via its own
top-level `var` so the two never fight over one filename:

```javascript
var notsobigdataCompileManifest = {
  enabled: true,                                   // set false to turn it off entirely
  folderId: null,                                  // default: auto-detected, the folder the Apps Script project itself lives in
  fileName: 'notsobigdata-compile-manifest.json'   // default filename inside that folder
};
```

All three keys are optional — omit the whole `var` to get every default.

## Declaring a node

Any top-level `var` holding an object with a `kind` key is a node.

| Key | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | Which kind of step this is, as a hand-written key on the `var`. Only `'move'` is declared this way — a `model` node is registered differently, as an entry in the `notsobigdataModels` registry rather than its own top-level `var`; see [docs/model.md](model.md). Both kinds still show up as ordinary nodes to `cli()` once discovered. |
| `name` | no | The node's name, used by `dependsOn` and `--select`. Defaults to the variable name you declared it as. |
| `dependsOn` | no | Array of node names this one must run after. (A `model` node isn't declared this way — see [docs/model.md](model.md)'s "Depending on a `move` node" for how a model hand-declares a `dependsOn` of its own, alongside its `{{ ref() }}`-derived edges.) |

Everything else on the object is that kind's own config — for `move`, the
`source` and `target` described in [docs/move.md](move.md).

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
