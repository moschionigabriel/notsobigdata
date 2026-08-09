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
that's the whole dependency declaration for a model-to-model dependency;
nothing goes in a hand-written `dependsOn` for that. (See "Depending on a
`move` node" below for the one thing `dependsOn` *is* for.) Unlike a
`move` node, a model isn't its own top-level `var`.
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

`projectId`, `dataset`, `materialized` and `dependsOn` at the top level are
project-wide defaults; anything a model sets on its own entry (like
`orders_summary`'s `materialized: 'table'` above) overrides them for that
model only. `sqlFile` defaults to `<model name>.html` when omitted —
`stg_orders` above could have left it out entirely.

`materialized` is `'view'` (the default) or `'table'`, materialized with
BigQuery's own atomic `CREATE OR REPLACE {VIEW|TABLE} ... AS SELECT` — no
temp-table swap dance required. Incremental materialization isn't
implemented yet.

Every model is then just another node: `cli('run')` picks up every entry in
`notsobigdataModels.models` alongside your `move` nodes and orders the
whole graph together, `cli('run --select model')` runs only models,
`cli('run --select orders_summary')` runs just that one.

### Depending on a `move` node

`{{ ref() }}` can only point at another model — there's no way to `ref()`
a `move` node, since a move isn't SQL. If a model's SQL selects from a raw
table a `move` node loaded, use `dependsOn` (the same key a `move` node's
own config already uses) to declare that ordering by hand:

```javascript
var notsobigdataModels = {
  projectId: 'my-project', dataset: 'analytics',
  models: {
    stg_orders: { dependsOn: ['loadRawOrders'] }
  }
};
```

`stg_orders` now runs only after the `loadRawOrders` move node finishes,
even though nothing in `stg_orders`'s SQL references it. A model's
`dependsOn` is combined with its `{{ ref() }}`-derived edges, never
instead of them — a model that both `ref()`s another model and
hand-declares a `move` dependency waits on both:

```javascript
models: {
  orders_summary: {
    dependsOn: ['loadRawOrders'],
    // SQL: select ... from {{ ref('stg_orders') }} ...
  }
}
```

`dependsOn` can also be set once at the registry's top level as a
project-wide default, the same way `materialized` can — useful when every
model waits on the same load. A model that sets its own `dependsOn`
overrides the project-wide one entirely (it does not merge with it),
exactly like overriding `materialized` on one entry:

```javascript
var notsobigdataModels = {
  projectId: 'my-project', dataset: 'analytics',
  dependsOn: ['loadRawOrders'],       // every model waits on this by default
  models: {
    stg_orders: {},                    // inherits the default above
    stg_customers: { dependsOn: ['loadRawCustomers'] }  // its own instead
  }
};
```

`dependsOn` is meant for naming `move` nodes (or any other non-model node)
— for a model-to-model dependency, keep using `{{ ref() }}` so the
declared edge always matches what the SQL actually does. Naming another
model in `dependsOn` isn't rejected, but it's not the documented way to do
it and skips the guarantee `ref()` gives that the dependency and the SQL
can't drift apart.

## Tests

A model can declare `tests`, an optional array run against the relation
it just materialized — dbt's own four built-in generic tests, plus your
own SQL for anything more specific:

```javascript
var notsobigdataModels = {
  projectId: 'my-project', dataset: 'analytics',
  models: {
    stg_customers: { /* ... */ },
    orders_summary: {
      // SQL: select ... from {{ ref('stg_customers') }} ...
      tests: [
        { column: 'customer_id', check: 'not_null' },
        { column: 'order_id', check: 'unique' },
        { column: 'status', check: 'accepted_values', values: ['open', 'closed', 'cancelled'] },
        { column: 'customer_id', check: 'relationships', to: 'stg_customers' },
        { name: 'no_negative_totals', query: 'SELECT * FROM {{ this }} WHERE order_total < 0' }
      ]
    }
  }
};
```

Each entry sets exactly one of `check` (a generic test) or `query` (a
custom test) — never both, never neither.

- `not_null` and `unique` need `column` only.
- `accepted_values` also needs `values` (a non-empty array of strings,
  numbers, or booleans).
- `relationships` also needs `to` (another declared model's name) and
  accepts an optional `field` (the column on `to`, defaulting to the same
  name as `column`) — this is model's answer to the referential check
  `move`'s own row-level `tests` can't express (see
  [docs/move.md](move.md)'s "Tests" section): does every value in this
  model's column exist somewhere in another model's column?
- `query` (a custom test) works exactly like a `bigquery` move target's
  `target.sqlTests` — a `SELECT` with `{{ this }}` standing in for this
  model's own fully-qualified relation, expected to return the *offending
  rows*. Zero rows back means the test passed.

A `relationships` test's `to` is a real dependency, the same way
`{{ ref() }}` is — `orders_summary` above waits on `stg_customers` even
though nothing in its SQL selects from it, so the test never runs against
a relation that doesn't exist yet.

Every declared test runs, whether it's the built-in generic kind or your
own SQL, and a bad shape (an unknown `check`, a missing required key, an
empty `values`) is caught the moment `cli()` discovers the model —
`cli('list')` catches it, not just a real run, same as every other model
misconfiguration.

Tests run **after** the model materializes, not before — unlike a
`bigquery` move target's `sqlTests`, which stage data and test it before
ever touching the real table. A model's `CREATE OR REPLACE` is already
atomic, and re-running the model's own `SELECT` a second time into a
scratch table just to test-before-promote would double the BigQuery cost
of every run for a guarantee real dbt itself doesn't give either — dbt
builds a model, then runs its tests afterward, as a separate step. A
failing test here throws, same as any other `model()` error: this node
fails and anything depending on it is skipped, but the (bad) data is
already sitting in the real relation by the time you find out. There's no
`discard_row` option the way `move`'s own `tests` has — a model's tests
run against a relation that's already fully written, not an in-memory row
array you can still filter.

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
