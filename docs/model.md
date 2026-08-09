# model kind reference

`model` is the "T" of ELT: SQL models that run against BigQuery, dbt-style.
See the main [README](../README.md) for installation, and
[docs/cli.md](cli.md) for how nodes are discovered, selected, and run in
general — a model is just another node once declared.

A model is SQL that runs against BigQuery, stored in a `.html` file — the
only plain-text file type Apps Script projects can hold — inside a single
`<script type="text/sql">` tag:

```html
<!-- orders_summary.html -->
<script type="text/sql">
  select
    customer_id,
    count(*) as order_count
  from {{ ref('stg_orders') }}
  group by 1
</script>
```

Models reference each other dbt-style with `{{ ref('model_name') }}` —
that's the whole dependency declaration; nothing goes in a hand-written
`dependsOn`. Unlike a `move` node, a model isn't its own top-level `var`.
Every model is one entry in a single shared registry instead, because a
project with a dozen models shouldn't need a dozen boilerplate top-level
`var`s just to register them:

```javascript
var notsobigdataModels = {
  projectId: 'my-project', dataset: 'analytics', materialized: 'view',
  models: {
    stg_orders: { sqlFile: 'stg_orders.html' },
    orders_summary: { sqlFile: 'orders_summary.html', materialized: 'table' }
  }
};
```

`projectId`, `dataset` and `materialized` at the top level are project-wide
defaults; anything a model sets on its own entry (like `orders_summary`'s
`materialized: 'table'` above) overrides them for that model only.
`sqlFile` defaults to `<model name>.html` when omitted — `stg_orders` above
could have left it out entirely.

`materialized` is `'view'` (the default) or `'table'`, materialized with
BigQuery's own atomic `CREATE OR REPLACE {VIEW|TABLE} ... AS SELECT` — no
temp-table swap dance required. Incremental materialization isn't
implemented yet.

Every model is then just another node: `cli('run')` picks up every entry in
`notsobigdataModels.models` alongside your `move` nodes and orders the
whole graph together, `cli('run --select model')` runs only models,
`cli('run --select orders_summary')` runs just that one.

`{{ ref() }}` is the only template call implemented so far — no macros, no
`for`/`if`. Referencing a name that isn't a declared model is an error, not
something silently passed through as literal text into SQL that runs with
your live BigQuery credentials.

A model's SQL must be a single statement — no `;`-separated scripts, same
restriction `move`'s BigQuery connector places on its own SQL (models can
still write, unlike `move`; this is about one statement, not read-only).
Models are declared as entries in `notsobigdataModels.models`, never as
their own `var { kind: 'model', ... }` — that shape is a `move` node's
pattern, not a model's, and is rejected with a clear error rather than
silently misbehaving.

A model's `.html` file can hold its SQL three ways, chosen by how many
`<script type="text/sql">` tags it contains:

- **No tag at all** — the whole file is the SQL. Simplest option for a
  model with its own dedicated file.
- **One tag** — its content is the SQL. An `id` is optional, but if present
  it must match the model's name (same rule as the multi-tag case below).
- **More than one tag** — several models can share one `.html` file, each
  in its own tagged block, as long as every tag's `id` matches a model
  name:

  ```html
  <!-- pipeline.sql.html -->
  <script type="text/sql" id="stg_orders">
    select 1 as order_id, 'alice' as customer
  </script>
  <script type="text/sql" id="orders_summary">
    select customer, count(*) as order_count
    from {{ ref('stg_orders') }}
    group by 1
  </script>
  ```
  ```javascript
  var notsobigdataModels = {
    projectId: 'my-project', dataset: 'analytics',
    models: {
      stg_orders: { sqlFile: 'pipeline.sql.html' },
      orders_summary: { sqlFile: 'pipeline.sql.html', materialized: 'table' }
    }
  };
  ```
  A shared file is only ever read once per `cli()` run, however many
  models point at it. A missing `id`, no tag matching a given model's
  name, or two tags sharing the same `id` are all clear errors — never a
  guess about which block belongs to which model.
