# Not So Big Data

## What this project is?
This project is a repo to create a library to use in Google Apps Script environment where the user can create ELT based data pipelines through declarative programming

## Why this project exists?
I am a data experienced data profiessional with a business background. So i came all the way from excel PROCV to a analytics engineering profile.
I was labeled as a Data Analyst, BUsiness Intelligence Developer, Analytics Engineer....but in almost all the companies that i've worked i've found the same problem: Areas where professionals didnt have to deal with high Volume data, but the demand for high quality insights dealing with a high Velocity, Variety, Veracity and Value data.
Because of the lack of Volume in the environment, often i was given just a Bigquery IDE whitout git to build my data pipelines, for example....because usually those areas don't have acces to a ci/cd pipeline or dont have the knowledge to do so.
This environment is what we call not sog big data, where the volume is not big and we don't have a good dev/engineering environment, but we can use the good pratice and knowledge of big data environtments to build high quality data pipelines.
At the end i choose Google Apps Script because its a free programming environment with native conection with Drive and BigQuery so it would be a great way to deal with a diversity of files tuype in google drive and handle bigquery transformations as well.

## Project lineage
notsobigdata is a clean-slate successor to an earlier prototype,
[tinydeskdata](https://github.com/moschionigabriel/tinydeskdata), which
proved the same Move/Model/Orchestrate idea in Google Apps Script. This repo
is a fresh design and fresh implementation learned from that prototype, not
a continuation of it — no code or spec files are carried over, and
tinydeskdata's spec-driven development workflow (a `spec/` folder with
per-module status: draft/current/proposed docs) is intentionally **not**
adopted here for now. Treat tinydeskdata as design inspiration/reference
only, not as source to port.

## Library Architeture
The intentioin is to wrap the whole library in a IFFE funciton and then "call" it from google apps script like this:

``` javascript
    eval(UrlFetchApp.fetch('https://raw.githubusercontent.com/notsobigdata/lib/main/src.js').getContentText())
```

In that way we can use custom gas functions within the user scope (like reading html files) without problemse

**Eval scoping gotcha, discovered building the `notsobigdata-tests` test
project:** a direct `eval()` call's `var`/function declarations only leak
into the scope of whatever function `eval()` was called from — never
beyond it. So `eval(UrlFetchApp.fetch(...).getContentText())` must run
either at the top level of the caller's file (outside any function, so
every function in that file can see the library), or inline in the exact
same function that then calls `cli()`. Routing
the eval through a separate loader/helper function silently breaks this —
the library ends up scoped to that helper and disappears the moment it
returns, producing a `ReferenceError` on whatever name the library exposes
globally. This applies to every consumer of the library, not just the test
project — worth calling out prominently wherever installation is
documented (see README.md's "Installation").

**The same scoping rule now applies to the user's config objects, not just
the eval line.** `cli()` discovers nodes by scanning the global scope, which
only holds top-level `var` declarations — a config object declared inside a
function is invisible to it. That failure is silent by nature (nothing to
throw about; the object simply isn't there), which is why `cli('hello')`
exists as a discovery smoke test and why finding zero nodes is reported
loudly rather than treated as "nothing to do".

### One file to install, three files to author

The library **ships** as a single file, `src.js`, committed at the repo
root — that is what the `eval()` URL points at, and it must stay one file
and one URL. But it is **authored** as one module per public concept:

    src/move.js     the EL engine: five connectors, extract/load, move()
    src/model.js    the T layer: dbt-style SQL models against BigQuery
    src/cli.js      the declarative layer: discover, select, order, run
    src/*.md        per-module dev notes (tracked, but not user docs)

`./build.sh` concatenates the modules, in the order named by its `MODULES`
manifest, inside the one IIFE and writes `src.js`. `./build.sh --check`
fails if the committed `src.js` doesn't match `src/` — `/ship` runs both.
It is a plain shell script: no bundler, no Node, no npm, no CI, nothing to
install.

Three rules follow from this and matter more than the mechanism:

1. **Never edit `src.js` by hand** — the next build overwrites it. Edit the
   module and rebuild.
2. **`src.js` stays committed.** It is a generated artifact, and normally
   those don't belong in git; here it does, because the whole install story
   is one `eval()` of one URL with no build step on the consumer's side.
3. **The generated file must still read well top to bottom.** The original
   "open one file and understand the whole library" property is preserved,
   not abandoned — `build.sh` emits a banner naming each module's source
   file so the seams are visible in the built output.

Modules share one closure, so they are just lists of hoisted function
declarations — no imports, no exports, no module system. For a long time no
helper crossed the `move`/`cli` boundary, which is why the split needed no
shared module and moved no code. The first crossing is deliberate: `cli()`'s
run-manifest feature (writing a small JSON "what happened" file to Drive
after each `run`) calls `move.js`'s `resolveDriveWriteTarget`/`writeDriveText`
rather than re-implementing "resolve an existing Drive file or create one" a
second time — that's genuinely the same primitive `loadDriveJson` already
uses, not new Drive-writing logic living in the wrong module.

### One public entrypoint: cli()

The library exposes exactly **one** public function, `cli()`. It was
originally designed as three public modules — `move()`, `model()` and
`orchestrate()` — but only `move()` was ever built, and the three-function
shape pushed ordering onto the user: you'd write configs, then re-nest them
inside an `orchestrate()` call to say what depends on what. Collapsing to
one entrypoint takes the dbt posture instead — you *declare* pipeline
objects and run `cli('run')`, the same way dbt users write models and run
`dbt run --select`. Orchestration stops being a module and becomes simply
what the runner does.

`cli()` takes a single command string:

``` javascript
    NotSoBigData.cli('run')                  // every node, in dependency order
    NotSoBigData.cli('run --select move')    // by kind
    NotSoBigData.cli('run --select orders')  // by node name
    NotSoBigData.cli('run --exclude orders')
    NotSoBigData.cli('list')                 // dry run: resolve + order, execute nothing
    NotSoBigData.cli('hello')                // smoke test; the only command that never throws
    NotSoBigData.cli('help')
```

A `--select`/`--exclude` token matches kinds before names. Selection does
*not* pull in upstream dependencies (dbt's `+` operators are deliberately
out of scope for now). A failed node marks its downstream dependents
`skipped`, transitively, while unrelated branches keep running, and `cli()`
returns a structured report rather than throwing — because each run is a
human clicking Run in the Apps Script editor, so surfacing every independent
failure in one pass beats fixing them one run at a time.

Scheduling needs nothing extra: a `cli('run')` call is an ordinary function
call, so a GAS time-based (installable) trigger pointed at a function that
calls it gives unattended scheduled runs.

### Node kinds

What used to be a module is now a **kind** of declared node. A node is any
top-level `var` holding an object with a `kind` key; `name` defaults to the
variable name, and `dependsOn` is an array of node names. Note `kind` is
distinct from `source.type`/`target.type` — `kind` is the sort of step,
`type` is the connector.

Internally there is one `EXECUTORS` map from kind to the function that runs
one node's config. Selection, ordering and the run loop are all
kind-agnostic, and `knownKinds()` reads that map to build the help text, the
selector error messages and `hello()`'s output — so a new kind picks all of
those up from the one entry.

**Discovery is the exception, and it's worth knowing before you plan a new
kind.** `discoverNodes()` reads dependencies straight off `config.dependsOn`,
which is right for `move` but wrong for `model`, whose edges come from
parsing `{{ ref() }}` out of its SQL — so `model` needed a per-kind hook,
`model.js`'s `extractRefDependencies()`, for deriving `dependsOn`. `model`
went one step further, too: every model is one entry in a single shared
`notsobigdataModels` registry rather than its own top-level `var`, so
`discoverNodes()`'s normal var-scan can never find them at all.
`model.js`'s `expandModelNodes()` is the hook that makes up the
difference — it turns that one registry into N fully-formed nodes and
`discoverNodes()` folds them into the same list its own scan produces,
right where that scan finishes. Both hooks are scoped narrowly to `model`;
a third kind needing something similar gets its own hook, not a
generalized version of either of these.

    - `move` — moves data from A to B, covering the "EL" part of "ELT".
    Its config is the `source`/`target` object shape: each source produces a
    2d array, so every target receives the same type of data — like a
    "dataframe" for this library. The 2d array is used because it's how GAS
    deals with values from a google sheets, for example.

    For v1, source/target connectors in scope are: Google Sheets, Drive
    files (CSV/XLSX/JSON), BigQuery tables, and external APIs via
    `UrlFetchApp`. BigQuery access uses Apps Script's built-in OAuth
    (the Advanced BigQuery Service) — no service account or external
    credentials to manage; pipelines run under the identity of whoever
    owns/runs the script.

    - `model` — declares SQL models just like dbt to model data in
    BigQuery, covering the "T" part of the "ELT" paradigm. SQL statements
    are stored in `.html` files (one `<script type="text/sql">` tag per
    model) so they can live inside a Google Apps Script project. Every
    model is one entry in a single shared registry (`notsobigdataModels`
    — project-wide `projectId`/`dataset`/`materialized` defaults plus a
    `models` map), not its own top-level `var` — deliberately different
    from `move`'s "every node is its own var", since a project with many
    models shouldn't need a top-level declaration per model just to
    register them.

    Models reference each other dbt-style with `{{ ref('model_name') }}`
    placeholders inside the SQL. Those refs are the model's dependency
    declaration — a `model` node derives its edges by parsing them, rather
    than repeating them in a hand-written `dependsOn`, and they get
    substituted at run time from the resolved registry. `materialized` is
    `view` (default) or `table`, via BigQuery's native atomic `CREATE OR
    REPLACE ... AS SELECT`; incremental materialization is deferred past
    v1. A model can declare `tests` — dbt's four built-in generic tests
    (`not_null`/`unique`/`accepted_values`/`relationships`) plus custom
    SQL — run against the relation after it materializes (not staged
    first, unlike a `bigquery` move target's `sqlTests`: `CREATE OR
    REPLACE` is already atomic, and dbt itself builds then tests rather
    than staging). `{{ ... }}` scanning is written generically (dispatch
    by leading call name) so a new macro beyond `ref()` is an added case,
    not a rewrite — `{{ config(materialized='table') }}` is the first
    example: it sets config from within the SQL itself, overriding both
    the registry's project-wide default and the model's own registry
    entry, and is stripped from the compiled SQL rather than substituted
    into it. `set` and `for` are block constructs, not single-token calls,
    and are both implemented: `{% set key = 'value' %}` defines a
    file-local value read back as a bare `{{ key }}`, and `{% for x in
    ['a', 'b'] %}...{% endfor %}` repeats a block of SQL once per item in a
    literal list, substituting a bare `{{ x }}` inside it. `{% for %}` is a
    text-expansion pass that runs before `ref()`/`config()`/`set()`/`var()`
    are scanned, so a call written inside a loop body is handled by the
    existing pipeline for free. `if` remains unimplemented.

## About testing

For each and every possible combination that each module provide, we need to create a test in order to test it in a Google Apps Script project.
Since Google Apps script has its own runtime (or something like this) every test should be triggered by a human, but prepared but you.

In practice this means maintaining a companion example Apps Script project
in its own folder in this repo (`notsobigdata-tests/`), managed with the `clasp` CLI —
already installed locally — that pulls in `src.js` and exercises every
documented node kind / connector / cli() command combination against real
Sheets/Drive/BigQuery resources. Because `cli()` discovers nodes by scanning
the global scope, every fixture config in that project is a top-level `var`,
and each test selects its own node (`cli('run --select <node>')`) — a bare
`cli('run')` there would fire every fixture at once. A human runs it from the Apps Script
editor (or `clasp run`) and reports back pass/fail; there is no automated
CI for this since the GAS runtime can't run headless in this setup.

`notsobigdata-tests/` is committed — its fixtures and test code are part
of this repo, reviewed in PRs like everything else. The one file that
isn't is `notsobigdata-tests/.clasp.json` (see `.gitignore`): a clasp
project is tied to a specific Apps Script deployment via that file's
`scriptId`, which is personal to whoever's Google account owns it, so it
can't be shared across contributors. Each contributor runs `clasp create`
or `clasp clone` once to generate their own local `.clasp.json` pointing
at their own deployment, then `clasp push -f` to deploy the tracked code
there. PRs that add a new node kind, connector, or cli() command update
`notsobigdata-tests/` directly as part of the same diff — see `/ship`'s
workflow.

Both the test Apps Script project itself and any fixture files it depends
on (test Sheets, sample CSV/XLSX/JSON files, etc.) live together inside a
single Google Drive folder named after the library (`notsobigdata`), so
everything the test project touches is co-located and easy to find/clean
up.

**Drive-target tests that create a new file must clean up after
themselves.** Any fixture whose `target` has no `fileId` (Drive
`folderId` + `fileName`, exercising the "create" path of `loadDrive*`)
writes a brand-new file on every run — that's inherent to the path being
tested, not a bug, since a create-mode test can't reuse a target and still
be testing creation. Left alone, every run leaves one more duplicate
behind: `notsobigdata-load-test.csv/.json/.xlsx` and
`notsobigdata-load-new-test.csv` piled up to 30 files in the Drive folder
before anyone noticed (2026-08-06). The fix belongs in the test project,
not the library — `loadDrive*` already returns the id of the file it
wrote, attached to the run result as `.loadResult` (see `src/move.md`) —
so any fixture that tests file *creation* should assert on the result and
then trash the file it just made:

``` javascript
    var report = NotSoBigData.cli('run --select loadNewTest');
    var result = report.results[0].result;
    // ...assertions on result...
    DriveApp.getFileById(result.loadResult).setTrashed(true);
```

Fixtures that instead pass an explicit `target.fileId` (the `-target`
naming convention already in use: `load-target.csv/.json/.xlsx`) are
testing overwrite/upsert, not creation — they reuse the same file every
run and must **not** be trashed, or the next run's overwrite has nothing
left to write to.

Any identifying or sensitive value the test project needs — spreadsheet/file
IDs, BigQuery project IDs, dataset/schema/table names, folder IDs, and
anything else that points at a real resource rather than describing the
library's behavior — must be stored in GAS's built-in Script Properties
(`PropertiesService.getScriptProperties()`), never hardcoded inline in the
test project's code. This matters more now that `notsobigdata-tests/` is
committed: Script Properties keep the test project's own code — and this
repo, which is public — free of real resource identifiers.

## About documentation

Docs are split into four tiers, by audience:

- **README.md** — quickstart only: what this is, installation, one worked
  pipeline, and a short link to the right doc per topic. Kept intentionally
  short; if a section only matters once someone is actively configuring
  something, it belongs in `docs/`, not here.
- **`docs/cli.md`, `docs/move.md`, `docs/model.md`** — the full,
  user-facing reference: one file per module, holding every connector's
  config keys and edge cases. Committed to git, linked from README's
  per-topic sections rather than inlined into README itself — this was a
  deliberate choice over one big reference file, so a reader chasing one
  connector's config opens one scoped file, not a long document with
  everything else in it too.
- **`src/move.md`, `src/model.md`, `src/cli.md`** — tracked, code-internals
  notes for whoever changes that module (see "One file to install, three
  files to author" above). Not user documentation, and not where a config
  option gets documented — that distinction is about audience, not git
  status.
- **This file (CLAUDE.md)** — tracked, contributor/workflow guidance.

A new kind or connector gets a `docs/<kind>.md` entry (or a new section in
an existing one) plus a link added from README, and — if there's internal
rationale worth preserving for whoever touches the code next — a matching
note in its `src/<kind>.md`. See each module's "Adding a kind"/"Adding a
connector" checklist in its `src/*.md` notes for the concrete steps.
`/ship`'s doc-check step greps README.md and everything under `docs/` for
*other* existing mentions of what changed, not just the new section being
written — a summary line elsewhere (e.g. a stale "currently only X" aside)
is exactly the kind of thing a change can leave behind unnoticed otherwise.

## About devops stuff
We should create a new branch and use git semantic and git flow to implement new changes do the repo

Concretely: Conventional Commits + git-flow-style branches. Branch names
and commit messages use a `type/description` (branch) / `type: description`
(commit) convention, where `type` is one of `feat`, `fix`, `refactor`,
`docs`, `test`, or `chore`. E.g. branch `feat/move-bigquery-source`, commit
`feat: add BigQuery source support to the move kind`. Never commit directly to
main — always a feature branch and a PR, even for small or doc-only changes
like edits to the README.md file. This applies to everything git actually
tracks — which now includes this file. Only what's still listed in
`.gitignore` (`.claude/`, and `notsobigdata-tests/.clasp.json`'s
per-contributor `scriptId`) stays untracked and is edited directly, with
no branch/PR involved.

Branches are three-tier: feature branches (`feat/`, `fix/`, `refactor/`,
`docs/`, `test/`, `chore/`) branch off the current `release/N` branch and
merge into it via PR; `release/N` itself later merges into `main` via PR.
There is always at most one active (unmerged) `release/*` branch at a
time. This exists to split review cost by risk: `security-review` runs on
every feature PR since it's cheap and this library gets `eval()`'d with
live OAuth access, while heavier quality checks (`simplify`, an
independent fresh-agent review) are batched once per release instead of
once per feature PR — see `/release` below.

### Workflow commands

Three custom Claude Code commands (`.claude/commands/`) implement this
workflow end to end, split at the points where a human has to get
involved:

- **`/release start` / `/release finish`** — cuts a new `release/N`
  branch off `main` for `/ship` to target, or finishes one: runs
  `simplify` and one fresh independent code review pass against the whole
  release's diff (batched together, once, instead of per feature PR),
  folds findings back in, and opens the `release/N → main` PR.
- **`/ship <change description>`** — plans the change, implements it
  together with any doc updates it requires, rebuilds `src.js` with
  `./build.sh` and verifies it with `./build.sh --check`, self-reviews (via
  the `security-review` skill only — see above for why `simplify` and the
  independent review moved to `/release`), opens a PR against the active
  release branch with a didactic explanation of what changed and why, and
  updates the companion Apps Script test project. It stops there and
  never merges — Google Apps Script can't be tested headless, so a human
  always runs the new/changed combination by hand first (see "About
  testing" above).
- **`/merge-pr [PR number]`** — merges one PR (a feature branch into its
  release branch, or a release branch into `main`) after explicitly
  confirming the human ran the GAS tests and they passed. Always asks
  before merging (regular merge, not squash) and never assumes a prior
  "tests passed" from earlier in the conversation.

All three commands ask before any externally visible action (pushing,
opening a PR, merging) and favor more confirmation checkpoints over fewer,
since part of the point of this workflow is understanding the changes an
agent makes, not just approving them.
