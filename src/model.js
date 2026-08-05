// model - the "T" of ELT. NOT IMPLEMENTED YET.
//
// This module is deliberately empty of code: it is the slot the model kind
// will fill, so adding it later is filling a file rather than rearranging
// the library. Because there is nothing executable here, the built src.js
// behaves exactly as if this file did not exist.
//
// The intended shape, for whoever writes it (see README.md's "The model
// kind" section for the user-facing version):
//
//   - A model is SQL, stored in an Apps Script .html file - one <script
//     type="text/sql"> tag per model - because .html is the only way to
//     keep a plain-text blob inside a GAS project, and HtmlService can
//     read it back at run time.
//
//   - Models reference each other dbt-style, with {{ ref('other_model') }}
//     placeholders inside the SQL. Those refs *are* the dependency
//     declaration: a model node derives its edges by parsing its own SQL
//     rather than repeating them in a hand-written dependsOn, and they get
//     substituted from the resolved graph just before the SQL runs.
//
//   - A declared node therefore looks like:
//       var ordersSummary = { kind: 'model', sqlFile: 'models/orders_summary.sql.html' };
//
// Wiring it up is one line in cli.js: add `model: model` to EXECUTORS.
// Everything else in cli.js - discovery, selection, ordering, the run
// loop - is kind-agnostic and needs no change. The one exception is
// dependency derivation: today discoverNodes() reads dependsOn off the
// config, so parsing {{ ref() }} into the same field is the one hook the
// model kind will need.
//
// Security note for whoever implements this: {{ ref() }} substitution is
// string interpolation into SQL. Only ever substitute a name that resolved
// to a known node in the graph - never interpolate arbitrary user text -
// or this becomes a SQL injection surface running under the script
// owner's live BigQuery credentials.
