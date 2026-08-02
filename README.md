# Not So Big Data

A declarative ELT library for Google Apps Script — move data, model it with
SQL, and orchestrate the whole pipeline, entirely inside a tool you
probably already have open.

> **Status: early-stage / pre-alpha.**
> This library is still taking shape. `move()` currently implements the
> **extract** half only — reading a source into a 2D array — for Sheets,
> Drive (CSV/XLSX/JSON), BigQuery, and external APIs. Writing that array
> into a target ("load") isn't implemented yet, so `move()` today only
> takes a `source`, not a `target`. `model()` and `orchestrate()` are not
> implemented yet either. Watch this repo for progress.

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
intended API shape — not final, and not usable yet. `move()`'s extract side
is implemented as shown.

### move()

`move()` extracts a source into a 2D array — the same shape Apps Script
already uses for Sheets ranges — regardless of where the source data comes
from:

```javascript
// Google Sheets — range is optional; omit it to read the whole active sheet
move({ source: { type: 'sheets', spreadsheetId: '...', range: 'Orders!A1:F' } })

// Drive file — fileType selects the parser: 'csv', 'xlsx', or 'json'
move({ source: { type: 'drive', fileId: '...', fileType: 'csv' } })

// BigQuery table — reads the full table (SELECT *), not arbitrary SQL;
// declaring transformations is model()'s job, not move()'s
move({ source: { type: 'bigquery', projectId: '...', dataset: 'staging', table: 'orders' } })

// External API — expects a JSON array of objects in the response body
move({ source: { type: 'api', url: 'https://...', options: { /* UrlFetchApp params */ } } })
```

For `drive` and `api` sources, a JSON array of objects is flattened into a
header row plus data rows using the **first object's keys** as the column
list — later objects missing a key just get a blank cell there. `xlsx`
files are converted to a temporary Google Sheet under the hood (Apps
Script has no native XLSX parser), read, and the temporary copy is deleted
immediately after — this requires the Advanced Drive Service enabled in
your Apps Script project.

**Loading the extracted array into a `target` is not implemented yet** —
`move()` only accepts `source` for now. Writing to Sheets/Drive/BigQuery
targets is planned for a follow-up change. Planned connectors are the same
on both sides once load lands: Google Sheets, Drive files (CSV/XLSX/JSON),
BigQuery tables, and external APIs via `UrlFetchApp`.

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
