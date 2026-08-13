# notsobigdata-tests — companion test project

This is the `notsobigdata-tests/` clasp project described in the main
repo's `CLAUDE.md` ("About testing"): a human-run Apps Script project that
exercises every `cli()` command / node kind / connector the library ships,
against real Sheets/Drive/BigQuery resources. It is entirely gitignored —
nothing here is committed, and there is no PR/branch workflow for changes
made in this folder.

Read this file instead of opening every file under `js/`/`html/` — it's
the map. Open an individual file only once you know which one you need.

## Layout

```
appsscript.json          manifest - enabled services, oauth scopes
.clasp.json               scriptId (per-contributor, gitignored)
stg_orders.html            ONE fixture that must stay at the project root - see below
html/                      every other model .html fixture (SQL + macro files)
js/
  00-bootstrap.js          eval()s src.js, reads Script Properties into P
  01-test-helpers.js       check(), testLog(), runOne(), withTemporaryNodes()...
  02-fixtures-custom-connectors.js   plain fns used as source.fn/target.fn
  03-fixtures-extract.js             move() nodes with no target
  04-fixtures-sheets-targets.js      move() nodes targeting Sheets
  05-fixtures-drive-targets.js       move() nodes targeting Drive
  06-fixtures-bigquery-targets.js    move() nodes targeting BigQuery
  07-fixtures-api-custom-targets.js  move() nodes targeting api/custom
  10-tests-cli.js          ) one file per TEST_CATEGORIES key - the file's
  11-tests-extract.js      ) number matches its position in this list, its
  12-tests-load.js         ) name matches runAllTests('<category>'). See
  13-tests-bigquery.js     ) "Test files" below for the full 10-25 list.
  ...
  90-test-registry.js      setupScriptProperties(), TEST_CATEGORIES, runAllTests()
  99-quick-run.js          test() - the one-click smoke test (runs 'cli')
```

There is **no build step** for this project, unlike the library itself
(`src.js`/`build.sh`). Every file under `js/`/`html/` is pushed to Apps
Script as-is by `clasp push -f` (the `-f` matters - a non-forced push can
silently no-op, see below). Edit a file, push, done.

## Why files, not folders, matter to Apps Script

Apps Script gives every file in a project - `.js`/`.gs` and `.html` alike,
regardless of which folder it lives in - one shared global scope. There is
no per-file module system and no imports: a function or top-level `var`
declared in any `js/*.js` file is visible to every other file. `html/` vs
`js/` and any numbering are for humans (and agents) browsing the project,
never a scoping boundary.

**The one exception: top-level `var` *initializers* that read another
`var`'s value run in file-concatenation order**, because `var` hoisting
only hoists the *declaration*, not the assignment. `00-bootstrap.js`
assigns `P` (Script Properties, read once). Every fixture in
`03-fixtures-extract.js` through `07-fixtures-api-custom-targets.js` reads
`P.SOME_PROPERTY` directly in its own object literal, at file-load time -
so those files must be concatenated *after* `00-bootstrap.js`. Function
declarations don't have this problem (hoisted before any top-level code
runs, from every file, order-independent) - which is why `10-*.js` through
`99-*.js` have no such constraint. The `00`-`07` numeric prefixes are load
order and must be preserved; `10`+ numbering is purely for
findability/mapping to `TEST_CATEGORIES` and can be renumbered freely.

## Test files (`js/10-*.js` – `25-*.js`)

Each file holds exactly the tests in one `TEST_CATEGORIES` key from
`90-test-registry.js`, in that key's declared order - so
`runAllTests('bigquery')` and `js/13-tests-bigquery.js` name the same set:

| file | category | file | category |
|---|---|---|---|
| 10-tests-cli.js | cli | 18-tests-model-discovery.js | model-discovery |
| 11-tests-extract.js | extract | 19-tests-model-tests.js | model-tests |
| 12-tests-load.js | load | 20-tests-model-compile.js | model-compile |
| 13-tests-bigquery.js | bigquery | 21-tests-manifest.js | manifest |
| 14-tests-model-core.js | model-core | 22-tests-datatests.js | datatests |
| 15-tests-model-dependson.js | model-dependson | 23-tests-emptyguards.js | emptyguards |
| 16-tests-model-jinja.js | model-jinja | 24-tests-regressions.js | regressions |
| 17-tests-model-files.js | model-files | 25-tests-pipeline.js | pipeline |

A few non-`test*` helper functions live inside their category's file even
though they're not themselves tests, because nothing else uses them:
`runOneCustomUrl` (11-extract), `sqlTestReferenceEnsured`/
`ensureSqlTestReference` (13-bigquery).

**Known pre-existing gap, not introduced by this split:**
`testLoadNestedObjectsToCsv` (in `12-tests-load.js`, flagged inline where
it sits) is defined but was never added to `TEST_CATEGORIES` in the
original single-file `Code.js` - `runAllTests()` has never run it on its
own. Worth deciding on deliberately; left as-is here.

## Running tests

- `test()` in `99-quick-run.js` - one-click smoke test, runs the `cli`
  category. Confirms the eval() install landed and the global scan can see
  the fixtures.
- `runAllTests()` - every test, every category.
- `runAllTests('<category>')` - one category (see the table above).
- `runAllTests('testA,testB')` - an explicit comma-separated list of test
  function names, spanning categories.
- `setupScriptProperties()` in `90-test-registry.js` - run this once per
  fresh Apps Script project before anything else; every fixture reads its
  identifying values (spreadsheet/file/table ids) from Script Properties,
  never hardcoded.

## `sqlFile`/`macros` paths

Every model fixture's `sqlFile`/`macros` value must include the `html/`
prefix now that those files live in `html/` (e.g. `sqlFile:
'html/stg_orders.html'`), because `model.js`'s `readModelHtml()` passes
the value straight to `HtmlService.createHtmlOutputFromFile()` after only
stripping `.html` - it has no folder awareness of its own, so the config
string has to spell out the path.

**`stg_orders.html` stays at the project root - do not move it into
`html/`.** Two tests (`testModelSqlFileDefaultsToNodeName` in
`17-tests-model-files.js`, and `testModelDependsOnUnionsWithRefDependencies`
in `15-tests-model-dependson.js`) declare a model named `stg_orders` with
no explicit `sqlFile`, deliberately relying on `model.js`'s default-naming
convention (`config.sqlFile = name + '.html'`). That default is a plain
string concatenation with no folder segment - it can only ever resolve at
the project root. If you add a new "default sqlFile naming" test, its
backing fixture needs a root-level file too, for the same reason.
