# Not So Big Data

A declarative ELT library for Google Apps Script — move data, model it with
SQL, and run the whole pipeline in dependency order, entirely inside a tool
you probably already have open.

*Not affiliated with or endorsed by dbt Labs, Inc. "dbt-style" throughout
this repo describes a design posture this library borrows, not a claim of
official integration.*

> **Status: early-stage / pre-alpha.** Both kinds this library offers are
> implemented today: `move` (the "EL" — extract/load across Sheets, Drive,
> BigQuery, external APIs, and your own custom functions) and `model` (the
> "T" — dbt-style SQL models against BigQuery), both run in one dependency
> order by `cli()`. "Early-stage" describes overall project maturity, not
> missing functionality — expect the API surface to still shift as it sees
> more real use. Watch this repo for progress.

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
eval(UrlFetchApp.fetch('https://raw.githubusercontent.com/notsobigdata/lib/v1.0.0/src.js').getContentText())

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
eval(UrlFetchApp.fetch('https://raw.githubusercontent.com/notsobigdata/lib/main/src.js').getContentText())
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
trusting this repo continuously rather than once.

**To pin instead, swap `main` for a tag** — same install, one word
different:

```javascript
eval(UrlFetchApp.fetch('https://raw.githubusercontent.com/notsobigdata/lib/v1.0.0/src.js').getContentText())
```

Unlike `main`, a tag never moves — `v1.0.0` will keep pointing at exactly
the same code even after a `v2.0.0` ships with breaking changes, so a
pipeline pinned to it keeps running unchanged. Update the tag in the URL
yourself, deliberately, whenever you're ready to move up.

## cli()

`cli()` is the library's only public function. It takes one command string:

```javascript
NotSoBigData.cli('run')                     // run every declared node, in dependency order
NotSoBigData.cli('run --select move')       // run only nodes of a given kind
NotSoBigData.cli('run --select rawOrders')  // run only that node
NotSoBigData.cli('run --select a,b')        // run only these, ordered among themselves
NotSoBigData.cli('run --exclude a')         // run everything except these
NotSoBigData.cli('list')                    // show what would run, in order — runs nothing
NotSoBigData.cli('compile')                 // resolve model SQL, without running anything
NotSoBigData.cli('debug')                   // check OAuth scopes/services per connector, without writing anything
NotSoBigData.cli('hello')                   // check the library loaded and see what it can find
NotSoBigData.cli('help')                    // the command list
```

`cli('hello')` is the one to reach for first if something isn't working —
it's the only command that never throws, and reports what the library can
actually see. Full command behavior — `--select`/`--exclude` precedence,
what each command returns, logging, the run manifest, and how a node is
declared → **[docs/cli.md](docs/cli.md)**.

## The two kinds

- **`move`** — moves data from A to B, the "EL" of "ELT": Sheets, Drive
  (CSV/XLSX/JSON), BigQuery, external APIs, and your own custom functions,
  with optional data tests before a target is loaded. Full connector-by-
  connector config → **[docs/move.md](docs/move.md)**.
- **`model`** — SQL models against BigQuery, the "T" of "ELT": dbt-style
  `{{ ref() }}` dependencies, `view`/`table` materialization, SQL stored in
  `.html` files, with optional dbt-style tests (`not_null`, `unique`,
  `accepted_values`, `relationships`) or your own SQL. Full config →
  **[docs/model.md](docs/model.md)**.

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
