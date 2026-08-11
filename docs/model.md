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
nothing goes in a hand-written `dependsOn` for that. `ref()` also resolves
a `move` node that loads into BigQuery — see "Depending on a `move` node"
below for both that case and the one case `dependsOn` is still needed for.
Unlike a `move` node, a model isn't its own top-level `var`.
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

### Setting config from SQL: `{{ config(...) }}`

A model can also set its own config from inside its SQL, dbt-style, instead
of (or as well as) the registry entry:

```html
<!-- orders_summary.html -->
<script type="text/sql">
  {{ config(materialized='table') }}
  select customer_id, count(*) as order_count
  from {{ ref('stg_orders') }}
  group by 1
</script>
```

`{{ config(...) }}` wins over both the registry's project-wide default and
the model's own registry entry for any key it sets — the same relationship
a dbt model's own `config()` block has with `dbt_project.yml`. The call
itself never appears in the SQL that actually runs against BigQuery; it's
read once during discovery and stripped out of the compiled statement.

Only `materialized` is supported today — an unrecognized key (or a second
`{{ config(...) }}` call in the same model, which has no obvious precedence
over the first) is a discovery-time error, caught by `cli('list')` the same
way a bad `tests` entry is.

### Reusing a value within one model: `{% set %}`

A model can define one or more named values with `{% set key = 'value' %}`
and read them back elsewhere in the *same* SQL as a bare `{{ key }}`
reference — real Jinja statement syntax, the same way dbt itself uses
`{% set %}` — useful when one literal (a threshold, a date cutoff) needs to
appear more than once in a query and you don't want the two copies to
drift apart:

```html
<!-- orders_summary.html -->
<script type="text/sql">
  {% set min_amount = '100' %}
  select customer_id, count(*) as order_count
  from {{ ref('stg_orders') }}
  where amount > {{ min_amount }}
  group by 1
  having sum(amount) > {{ min_amount }}
</script>
```

The `{% set %}` statement is stripped out of the SQL that actually runs
against BigQuery; every `{{ min_amount }}` reference is substituted with
the raw, unquoted value it was given — if the value needs to be a SQL
string literal, put the quotes in the `{% set %}` value itself (e.g.
`{% set status = "'active'" %}`) or around the `{{ min_amount }}`
reference in your SQL.

A bare `{{ key }}` referencing a name that was never `{% set %}` anywhere
in the model's SQL is a discovery-time error, same as an unrecognized
`config()` key. More than one `{% set %}` statement is allowed in the same
model — each may define a different name — but the same name can only be
set once; a second definition has no obvious precedence and is rejected
the same way a second `config()` call is.

`{% set %}` is file-local: a value defined in one model's SQL isn't
visible to any other model, and it creates no dependency edge — it exists
purely to avoid repeating yourself within one query, not to parameterize a
model from outside its own SQL. (For that, see `{{ var(...) }}` below.)
Only a single-line, single string-literal assignment is supported — not a
full Jinja expression on the right-hand side, and not the block
`{% set x %}...{% endset %}` form.

### Project-level values: `{{ var(...) }}`

`{{ var('key') }}` reads a value from `notsobigdataModels.vars` — a flat
dict of project-wide values, the model-SQL equivalent of dbt's
`dbt_project.yml` `vars:` section:

```javascript
var notsobigdataModels = {
  projectId: 'my-project', dataset: 'analytics',
  vars: { region: 'US' },
  models: {
    orders_summary: {
      // SQL: ... where region = {{ var('region') }}
    }
  }
};
```

An optional second argument supplies a default for when the key isn't set
in `vars`: `{{ var('region', 'US') }}` resolves to `'US'` even if
`notsobigdataModels.vars` has no `region` key at all. `{{ var(...) }}`
substitutes its value raw and unquoted, same posture `{% set %}`'s
substitution has. A `{{ var(...) }}` call with no default, naming a key
`vars` doesn't have, is a discovery-time error — same "fail loud before any
BigQuery call" treatment every other model misconfiguration gets.

`{{ var(...) }}` and `{% set %}` are unrelated features, on purpose — the
same way they are in real dbt/Jinja. `{% set %}` is a value scoped to one
model's own SQL; `{{ var(...) }}` is a value scoped to the whole project,
declared once on the registry. Neither can read the other's values.

### Repeating SQL: `{% for %}`

A model can repeat a block of SQL once per item in a literal list with
`{% for x in ['a', 'b'] %}...{% endfor %}`, substituting a bare `{{ x }}`
reference to the loop variable within that block — real Jinja block syntax,
the same way dbt itself uses `{% for %}` to generate a pivot's repeated
columns without hand-writing each one:

```html
<!-- orders_summary.html -->
<script type="text/sql">
  select
    customer_id,
    {% for status in ['open', 'closed', 'cancelled'] %}
    sum(case when status = '{{ status }}' then amount else 0 end) as {{ status }}_total,
    {% endfor %}
    count(*) as order_count
  from {{ ref('stg_orders') }}
  group by 1
</script>
```

The list is a literal, comma-separated array of quoted strings only — not a
`var()` or `ref()` call — the same string-literal-only posture `config()`'s
kwargs and `{% set %}`'s right-hand side already take. `{% for %}` expands
before anything else looks at the SQL, so a `{{ ref(...) }}`, `{{
config(...) }}`, or `{% set %}` written *inside* a loop body works exactly
like it would outside one, repeated once per item along with the rest of
the block.

Because `{% for %}` is plain text repetition, not a real Jinja evaluator,
it has the same limit `{% set %}` already documents for itself: only the
bare `{{ x }}` shape is substituted. Using the loop variable as an argument
to another call — `{{ ref(x) }}`, `{{ var(x) }}` — is not supported; write
the block so the loop variable stands on its own, the way `status` does
above.

Nesting one `{% for %}` inside another is not supported and is a
discovery-time error, same as an unterminated `{% for %}` with no matching
`{% endfor %}`, an empty list, or an item that isn't a quoted string —
`cli('list')` catches all of these before any real run, same as every
other model misconfiguration.

### Reusable SQL across models: `{% macro %}`

Where `{% set %}` is scoped to one model's own SQL, a `{% macro %}` is a
named, parameterized block of SQL any model can call — the same idea as a
dbt macro, or a spreadsheet's named formula you write once and reuse. It's
declared in its own `.html` file, not inside a model's file, using real
Jinja block syntax:

```html
<!-- macros.html -->
{% macro cents_to_dollars(column) %}
  ROUND({{ column }} / 100, 2)
{% endmacro %}
```

List which files hold macros on `notsobigdataModels.macros` — a plain array
of file names, so you can name them however you like and split them across
as many files as you want:

```javascript
var notsobigdataModels = {
  projectId: 'my-project', dataset: 'analytics',
  macros: ['macros.html'],
  models: {
    orders_summary: { /* ... */ }
  }
};
```

Call it from any model's SQL like any other `{{ }}` call, with quoted
string arguments matching the macro's declared parameters:

```html
<!-- orders_summary.html -->
<script type="text/sql">
  select
    order_id,
    {{ cents_to_dollars('amount_cents') }} as amount_usd
  from {{ ref('stg_orders') }}
</script>
```

Unlike a model's raw SQL — which has no way to name itself, which is why a
multi-model `.html` file needs `<script id="...">` matching (see "A
model's `.html` file can hold its SQL three ways" below) — a `{% macro %}`
block already names itself in its own opening statement. So one `.html`
file can hold several macros with no wrapping tag and no `id` needed at
all:

```html
<!-- macros.html -->
{% macro cents_to_dollars(column) %}
  ROUND({{ column }} / 100, 2)
{% endmacro %}

{% macro to_eur(column, rate) %}
  ROUND({{ column }} * {{ rate }}, 2)
{% endmacro %}
```

A macro's own parameters are bare names, not quoted — `{% macro
name(a, b) %}`, not `{% macro name('a', 'b') %}` — since a parameter is a
name the macro's body refers to via `{{ a }}`, the same bare-reference
shape `{% set %}` already uses. A call site's arguments, on the other
hand, are quoted strings, same posture every other call in this library
takes (`ref()`, `config()`, `var()`, `{% for %}`'s own list) — no numbers,
no expressions, no nested calls.

A macro's own body is expanded *before* anything else looks at a model's
SQL — before `ref()`/`config()`/`var()`/`{% set %}` are scanned, and after
`{% for %}` (so a macro called from inside a loop body expands once per
iteration). That means a `{{ ref(...) }}` inside a macro's body becomes a
real dependency edge for whichever model calls it, exactly as if the
`ref()` had been written directly in that model's own SQL:

```html
<!-- macros.html -->
{% macro enrich_with_region(column) %}
  (select region from {{ ref('stg_customers') }} where customer_id = {{ column }})
{% endmacro %}
```

A model calling `{{ enrich_with_region('customer_id') }}` now depends on
`stg_customers` too, with nothing extra to declare.

A macro cannot call another macro — that's a discovery-time error,
`cli('list')` catches it before any real run, same as every other model
misconfiguration. This is a deliberate scope limit, not a missing feature:
supporting real macro composition would need cycle detection (a macro
calling a macro calling itself) this library doesn't otherwise need. If
one macro's logic depends on another's, inline it, or ask whether the two
should really be one macro.

A macro name declared in more than one file listed in
`notsobigdataModels.macros`, an unterminated `{% macro %}` with no matching
`{% endmacro %}`, a call with the wrong number of arguments, or a
parameter list with a duplicate or non-identifier name are all
discovery-time errors too. So is naming a macro `ref`, `config`, or
`var` — those are the library's own built-in calls, and a macro reusing
one of those names would silently take over every `{{ ref(...) }}` (etc.)
in the whole project rather than raising an error, so it's rejected
outright instead. Declaring zero macro files (or omitting
`macros` from `notsobigdataModels` entirely) is not an error — it just
means no model can call one.

Every model is then just another node: `cli('run')` picks up every entry in
`notsobigdataModels.models` alongside your `move` nodes and orders the
whole graph together, `cli('run --select model')` runs only models,
`cli('run --select orders_summary')` runs just that one. `cli('compile')`
resolves the same SQL — every `ref()`/`var()`/`config()` substituted — but
never issues the resulting statement to BigQuery, letting you see exactly
what a model would run before it does; see [docs/cli.md](cli.md#clicompile--see-the-sql-before-it-runs).

### Depending on a `move` node

If a model's SQL selects from a table a `move` node loaded into BigQuery,
`{{ ref() }}` works exactly the way it does for another model — name the
`move` node:

```html
<!-- stg_orders.html -->
<script type="text/sql">
  select * from {{ ref('loadRawOrders') }}
</script>
```

with `loadRawOrders` declared as a top-level `move` node whose
`target.type` is `'bigquery'`:

```javascript
var loadRawOrders = {
  kind: 'move',
  source: { /* ... */ },
  target: { type: 'bigquery', projectId: 'my-project', dataset: 'staging', table: 'orders' }
};
```

`ref()` substitutes `loadRawOrders`'s fully-qualified table the same way it
substitutes another model's relation, and `stg_orders` automatically
depends on `loadRawOrders` running first — no hand-written `dependsOn`
needed, and no risk of the declared dependency drifting from what the SQL
actually selects from, the same guarantee a model-to-model `ref()` already
gives.

This only works for a `move` node whose target is BigQuery — a move
loading into Sheets, Drive, or anywhere else has no queryable relation for
`ref()` to substitute. For that case (or any time a model merely needs to
*wait* on a `move` node without selecting from what it loaded), fall back
to a hand-written `dependsOn` (the same key a `move` node's own config
already uses) to declare the ordering by hand:

```javascript
var notsobigdataModels = {
  projectId: 'my-project', dataset: 'analytics',
  models: {
    stg_orders: { dependsOn: ['loadRawOrdersToSheet'] }
  }
};
```

`stg_orders` now runs only after the `loadRawOrdersToSheet` move node
finishes, even though nothing in `stg_orders`'s SQL references it. A
model's `dependsOn` is combined with its `{{ ref() }}`-derived edges,
never instead of them — a model that both `ref()`s a BigQuery-target node
(model or move) and hand-declares a non-BigQuery `move` dependency waits
on both:

```javascript
models: {
  orders_summary: {
    dependsOn: ['loadRawOrdersToSheet'],
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
  dependsOn: ['loadRawOrdersToSheet'],  // every model waits on this by default
  models: {
    stg_orders: {},                     // inherits the default above
    stg_customers: { dependsOn: ['loadRawCustomers'] }  // its own instead
  }
};
```

`dependsOn` is meant for naming a `move` node `ref()` can't reach (one
whose target isn't BigQuery) — for anything `ref()` *can* reach — another
model, or a BigQuery-target `move` node — keep using `{{ ref() }}` so the
declared edge always matches what the SQL actually does. Naming a
`ref()`-reachable node in `dependsOn` instead isn't rejected, but it's not
the documented way to do it and skips the guarantee `ref()` gives that the
dependency and the SQL can't drift apart.

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

A `view` with tests still runs them **after** `CREATE OR REPLACE VIEW`,
against the view itself: a view is just stored SQL text, not landed data,
so there's nothing to stage — the view only ever changes what a *future*
query sees, never something already sitting in a table.

A `table` with tests works differently: it's staged first, the same way a
`bigquery` move target's `sqlTests` are (see
[docs/move.md](move.md)'s "Tests" section). The compiled `SELECT` builds
into a scratch table, tests run against *that*, and only if every test
passes does the real relation get replaced — via a BigQuery copy job, not
a second `SELECT`, so this costs one extra (cheap) copy job per run, not
a second run of the model's query. A failing test throws before that copy
job ever runs, so the real relation is simply never touched by a batch
that failed its checks — unlike a `view`, where the (only ever
query-time) SQL has already changed by the time a test can catch it. As
with a `view`'s tests, there's no `discard_row` option the way `move`'s
own `tests` has — a model's tests check a whole relation, not an
in-memory row array you can filter.

A `table` with *no* tests declared materializes directly, same as
always — nothing to check, nothing to gain from staging.

`{{ ref() }}`, `{{ config() }}` and `{{ var() }}` are the only built-in
`{{ }}` calls implemented so far, alongside the `{% set %}` and `{% for %}`
block constructs and your own `{% macro %}`s (see above) — no `if` yet.
Referencing a name that isn't a declared model, an undefined `{% set %}`/
`var()`, or a `{{ }}` call that's neither a built-in nor a declared macro,
is an error, not something silently passed through as literal text into
SQL that runs with your live BigQuery credentials.

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
