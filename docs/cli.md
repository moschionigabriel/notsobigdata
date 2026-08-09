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
is `planned` and nothing executes — and there's no `manifest` field, since
`list` doesn't run anything worth recording (see below).

`manifest` is present only on `run`, and is always one of:

```javascript
{ written: true, fileId: '...' }                      // wrote/overwrote the manifest file
{ written: false, reason: 'disabled' }                 // notsobigdataManifest.enabled is false
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
executes, so there's no "in progress" to signal.

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
materialized and as which (`materialized: 'view'` or `'table'`). This
keeps the file's size independent of how much data your pipeline
actually moves.

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
