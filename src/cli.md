# cli.js — private notes

> Working notes, not user documentation. docs/cli.md is the public reference
> for the commands; this file is about the code's internals and the rules you
> have to keep if you change it. Gitignored.

## What this module owns

The declarative layer: the user *declares* node objects, `cli()` finds them,
orders them and runs them. Same posture as dbt — you don't call each model,
you write models and run `dbt run --select`.

The pipeline inside `cli()`, in order:

```
parseCommand  →  discoverNodes  →  assertDependenciesExist
              →  applySelection →  orderNodes  →  runNodes
```

Everything here is **kind-agnostic**. The only thing that knows kinds exist
is `EXECUTORS` — the map from `kind` to the function that runs one node's
config. That is the whole extension point: adding a kind is one entry there
plus the module implementing it.

## Discovery, and why it's fragile by nature

`discoverNodes()` is the one place the library reaches outside its own
closure: it walks `Object.keys(globalThis)` looking for objects with a
`kind`. That is *the* reason for two rules that keep coming up:

- The consumer's `eval()` must run at the top level of their file (a direct
  `eval`'s declarations only reach the scope that called it).
- The consumer's config objects must be top-level `var`s, or they simply
  aren't on `globalThis` and discovery cannot see them.

Both failures are **silent** — nothing throws, the nodes just aren't there.
That's why `cli('hello')` exists (a smoke test that reports what the library
can actually see) and why finding zero nodes is reported loudly.

Reads during the scan are individually guarded: touching some Apps Script
globals throws, so a bare `globalThis[key]` would break discovery entirely.

## Things that will bite you

- **`has()` is not optional.** Every lookup map is keyed by user-supplied
  node names, and a plain `{}` already "has" `toString`, `constructor`,
  `valueOf`. Without the `hasOwnProperty` guard, a node named `toString`
  passes dependency validation and then dies inside the sort with a
  `TypeError` instead of a clear message. Any new map keyed by node names
  must go through `has()`.
- **`runNodes` is deliberately fail-soft.** A failed node marks its
  dependents `skipped`, transitively, while unrelated branches keep running,
  and `cli()` *returns* a report rather than throwing. The reason is the
  runtime: every run is a human clicking Run in the Apps Script editor, so
  surfacing every independent failure in one pass beats discovering them one
  run at a time. Don't "fix" this into fail-fast.
- **`cli('hello')` must never throw.** It's the tool you reach for when
  nothing else works.
- **`cli()`'s "START"/"DONE" log lines are deliberately separate from
  the manifest**, not a redundant second copy of it. The manifest is a
  Drive artifact meant to be read *after* the fact (and only for `run`);
  these are `Logger.log` lines meant to be watched live in the Apps
  Script editor *while* a run happens, for every command including
  `hello`/`help`'s `START` line. `DONE` still only fires for `run`/`list`
  — same reasoning as the manifest skipping `hello`/`help`: there's no
  per-node status to roll up for either. `formatStatusCounts()` only
  renders non-zero counts specifically so `list` (all `planned`) doesn't
  print three "0 ..." clauses nobody asked about.
- **`runNodes()`'s per-node logging is proportional to what needs
  attention, not to node count.** `START` logs only immediately before
  the `EXECUTORS[node.kind]` call — not before the blocked-check or the
  dry-run check above it, since neither of those takes real time, so a
  `START` there would never carry the "is this still working" signal it
  exists for (a long BigQuery job poll is the case that actually needs
  it). `SKIP`/`FAIL` always log unconditionally - they're what needs a
  human's attention. `OK` only logs when `resolveLoggingConfig().verbose`
  is true (default `false`, set via the optional `notsobigdataLogging`
  global, same guarded-read pattern as `resolveManifestConfig()`) —
  nothing failed is already implied by `START` plus the absence of a
  `FAIL`/`SKIP` line, and `OK`'s row-count/timing detail is never lost
  from the permanent record either way (always in the returned
  `results`/manifest), only from the console. This shipped in two steps
  within the same session: `START` was first added unconditionally for
  *every* node (including skipped/planned ones) to fix "can't tell what's
  in flight"; after actually using it, the per-node volume (2 lines/node)
  was judged too noisy, so `START` was narrowed to only the branch that
  needs it and `OK` was made opt-in. Don't put `START` back in front of
  the blocked-check or dry-run check "for symmetry" - that was tried and
  reverted for a documented reason.
- **Selection matches kinds before names**, and does *not* pull in upstream
  dependencies (dbt's `+` operators are out of scope). If you ever add them,
  it belongs in `applySelection`, not in `orderNodes`.
- **`orderNodes` is Kahn's algorithm** and names the cycle members on
  failure — keep that; "there is a cycle" without names is useless in a
  ten-node graph.

## The run manifest

`writeManifest()` runs at the end of `cli()`, only for `run` (never `list`,
which executes nothing worth recording). It writes a small JSON file to
Drive summarizing `results` — a dbt-`manifest.json` analog, not a
`run_results.json`-style history: it's overwritten in place every run via
`upsertByName`, so it only ever reflects the latest run.

Design constraints that matter if you touch this:

- **Never embed raw row data.** `summarizeNodeResult()` only records
  `rowCount`/`columnCount` for array results, plus `loadResult`/
  `testResults` verbatim (both already small/bounded per every built-in
  target). This is what keeps manifest size independent of how much data a
  pipeline actually moves — don't be tempted to add the full `result.result`
  "just for debugging."
- **Kind-agnostic on purpose.** `summarizeNodeResult()` branches on the
  *shape* of a result (is it an array? does it carry `loadResult`?), never on
  `node.kind`. No per-kind hook exists for this, unlike `discoverNodes()`'s
  `dependsOn` derivation — don't add one speculatively before a real kind
  needs different manifest behavior.
- **Best-effort, always.** `writeManifest()` catches everything and reports
  one of three `{written: ...}` shapes; it must never throw out of `cli()`
  and must never affect `report.ok`. The actual node results are the thing
  that matters — the manifest is metadata about them.
- **Every outcome also gets a `Logger.log` line** (`MANIFEST written to
  <id>` / `MANIFEST skipped - ...` / `MANIFEST failed - ...`), same as
  every other outcome in a run. Before this, a failed write was only
  visible in `report.manifest`, which the documented usage pattern
  (`Logger.log(report.ok)`) never inspects — so a human watching the
  execution log had no way to tell a silent failure from a silent
  success. Don't drop this logging even though `writeManifest()` stays
  best-effort; the two are orthogonal — never throwing is about not
  breaking the run, logging is about not hiding the outcome.
- **Reuses `move.js`'s `resolveDriveWriteTarget`/`writeDriveText`** rather
  than a second Drive-write implementation — the first helper call to cross
  the `move`/`cli` module boundary (see CLAUDE.md). If `move.js` ever
  changes those signatures, this is a caller to update too.
- **Auto-detected default folder is unverified for container-bound
  scripts** (bound to a Sheet/Doc/Form rather than standalone) —
  `resolveManifestFolderId()`'s `ScriptApp.getScriptId()` +
  `DriveApp.getFileById(...).getParents()` chain has only been reasoned
  through, not run, against that case. Verify by hand before relying on it.

## cli('compile') and the COMPILERS map (2026-08-09)

Added a third dry-run-shaped command alongside `run`/`list`, mirroring
dbt's own three-way `run`/`compile`/`list` split rather than folding SQL
resolution into `list`. Design conversation with the user landed on this
explicitly: `list` is dbt's `list`/`ls` (enumerate + order, kind-agnostic,
cheap), `compile` is dbt's own `compile` (resolve Jinja into final SQL, no
execution) - two different jobs even in dbt itself, so keeping `list`
untouched and adding `compile` as its own command matches that split more
faithfully than bolting SQL text onto `list`'s existing cheap output.

**`COMPILERS` is a second small map, not a flag on `EXECUTORS`.** `EXECUTORS`
answers "how do I run this kind for real"; `COMPILERS` answers "can this
kind's SQL be resolved without running it" - a strictly narrower question
only `model` can answer yes to today (`move` has no `{{ }}`-style
templating). Keeping them separate means a kind that can run but can't
compile (every kind but `model`, right now) just isn't in `COMPILERS` -
`runNodes()`'s `compile` branch checks `has(COMPILERS, node.kind)` and falls
back to a plain `'planned'` result, identical to what `list` already
produces for it. Don't generalize this into one map with an optional
`compile` key per entry until a second kind actually needs it - same "narrow
hook per kind, not a speculative generalization" posture model.js's own
`extractRefDependencies`/`expandModelNodes` hooks already take.

**`runNodes()`'s second parameter changed from a `dryRun` boolean to the
command string itself** (`'run'`/`'list'`/`'compile'`). A third dry-run-ish
mode made the boolean insufficient, and passing the actual command string
through (rather than e.g. two booleans) means the function's own dispatch
reads as a direct match to `COMMANDS`, not an ad-hoc combination of flags
that has to be cross-checked against it.

**A model that fails to compile blocks its dependents the same way a real
run failure does** - reuses the existing `blocked` map inside `runNodes()`
rather than a parallel skip mechanism. This should be rare in practice:
`expandModelNodes()` already validates every `ref()`/`var()` name at
discovery time, so a compile-time failure here is defense-in-depth for the
same reason `compileModelSql()` itself re-validates at run time (see
model.md).

**The compile manifest is a genuinely separate file, not a flag on the run
manifest.** `resolveCompileManifestConfig()` stays a near-duplicate of
`resolveManifestConfig()` - deliberately, so `notsobigdataManifest` and
`notsobigdataCompileManifest` stay two independent, optional globals a user
can configure (or disable) without the other's config leaking in. The one
place they *do* share code, alongside `buildManifest()`/
`summarizeNodeResult()` (those already branch on result *shape*, not
command - adding a `'planned'` branch that surfaces `compiledSql` when
present costs nothing for `run`'s own manifest, since a `run` result never
carries `compiledSql`), is the actual Drive-writing body itself -
`writeManifestFile()`, see its own comment above `writeManifest()` in
`src/cli.js`. That one *did* start as two near-identical copies
(`writeManifest()`/`writeCompileManifest()`, differing only in which
config/log-prefix they used) and was later folded into one shared
function, called once with each side's own config plus the *other* side's
config - see "Manifest target collision now caught, writers deduplicated"
below for why. Deduplicating the actual write logic doesn't reopen "a bug
in one corrupts the other's file" the way sharing the *config resolution*
would: `writeManifestFile()` only ever reads from the `config` argument
its caller already resolved from its own global, so `writeManifest()`
still can't accidentally read `notsobigdataCompileManifest`'s settings or
vice versa - only the mechanical "resolve folder, upsert via Drive, log
the outcome" steps are shared, not the two globals' own resolution.

## Manifest target collision now caught, writers deduplicated (2026-08-11)

A code-review pass across the whole repo caught the actual consequence of
"two independent globals, two independent writers, no cross-check": if a
user configured `notsobigdataCompileManifest` with the same `folderId` +
`fileName` as `notsobigdataManifest` (a plausible copy-paste mistake, not
a deliberate choice - there's no legitimate reason to point both at the
same file), `cli('compile')` would silently overwrite the last real
`cli('run')`'s manifest with compile-only data, and vice versa. No error,
no warning - just whichever command ran most recently winning silently.
The "near-duplicates... deliberately, so a bug in one can never silently
corrupt the other's file" reasoning above turned out to only hold for
config *resolution* (which global gets read) - it said nothing about the
two *targets* a user's config can still point at the same place, which
was always possible and always unguarded.

**Fix: a same-target check, plus deduplicating the two writers so the
check only has to be written once.** `writeManifest()`/
`writeCompileManifest()` were genuinely identical past the first two
lines (which config/log-prefix to use) - folded into one
`writeManifestFile(logPrefix, config, otherConfig, commandText, ok,
results, ignored)`, called once from each of the two thin wrappers with
its own resolved config as `config` and the sibling's as `otherConfig`.
Right after resolving `config`'s own folder (already a required step),
`otherConfig`'s folder is resolved too - but only if `otherConfig.enabled`
is true, since a disabled manifest can never actually be overwritten, so
there's nothing to guard against and no reason to spend the extra
`resolveManifestFolderId()` Drive lookup checking it. If both resolved
folders and both fileNames match, the write is refused - same
`{written: false, reason: '...', error: '...'}` shape every other
best-effort failure here already returns, not a thrown error, matching
this function's own "must never throw out of `cli()`" contract.

**Why refuse rather than pick a winner (last-write-wins, or "run" always
wins over "compile").** Any precedence rule here would be guessing at
which manifest the user actually wanted - the same "no obvious
precedence, reject rather than guess" posture `model.js`'s `config()`
(at most one call) and duplicate-`{% set %}`-name checks already take.
Refusing to write is loud (a `Logger.log` line naming exactly which two
globals collided and what to change) without being destructive - the
node results themselves, which matter more than the manifest, are
completely unaffected either way.

**The whole feature is a workaround for one property of `eval()`.** Apps
Script normally auto-detects a project's required OAuth scopes/Advanced
Services by statically scanning that project's own `.gs` files for the
calls that need them. notsobigdata is installed via
`eval(UrlFetchApp.fetch(...).getContentText())` (see CLAUDE.md's "Library
Architecture"), so every `DriveApp`/`SpreadsheetApp`/`BigQuery`/
`UrlFetchApp` call this library makes lives inside a string that scan never
sees. A consuming project can end up missing a scope with no authorization
prompt ever shown for it, and the first symptom is a bare permission error
buried inside a real `cli('run')`. `cli('debug')` exists to surface that
gap directly instead - see `evalScopingHint()`, whose text gets appended to
every `missing_scope`/`service_not_enabled` result specifically so the
explanation travels with the failure, not just in docs someone has to go
find.

**`DEBUG_PROBES` is a fourth small map, same shape as `EXECUTORS`/
`COMPILERS`/(implicitly) the `list` branch** - keyed by connector `type`
(`sheets`/`drive`/`bigquery`/`api`/`url`/`custom`, the six strings
`extract()`/`load()` in move.js already switch on), not by node `kind`.
That's the one place this feature isn't kind-agnostic in the usual sense:
a `move` node can yield up to two checks (source and target), and a
`model` node yields one synthetic one built from
`resolveModelConfig()`'s already-resolved `projectId`/`dataset` -
`connectorTuplesForNode()` is the (intentionally narrow, per-kind, same
posture as `expandModelNodes()`/`extractRefDependencies()`) place that
difference lives, not `DEBUG_PROBES` itself.

**Debug checks never touch `runNodes()`'s `blocked` map, and `cli('debug')`
never calls `orderNodes()` at all.** Every other command's whole point is
"do the work in a valid order, stop cascading past a failure." Debug's
point is the opposite: surface every connector problem in one pass,
independent of every other node's status, so a broken node never hides a
problem in a node that comes after it. That's why `runDebugChecks()` is a
flat `forEach`, not a variant of `runNodes()`.

**Source-side probes reuse the real read call; target-side probes
substitute a read-only stand-in for the same resource - never the real
write.** This is the part most likely to bite someone extending it: it
would be simpler to just call `extract()`/`load()` directly and see what
throws, but `load()` is destructive by definition (that's `move()`'s whole
job), so a debug check would silently start overwriting/loading real data.
Concretely: `SpreadsheetApp.openById`, not `loadSheets`;
`DriveApp.getFileById`/`getFolderById`, not `writeDriveText`;
`BigQuery.Datasets.get`, not a load/query/copy job. The one place this
gets uncomfortable is `api` targets - `loadApi` always POSTs a JSON body,
so `probeApi`'s target case sends a GET instead via `fetchProbe()`, which
also strips `method`/`payload`/`muteHttpExceptions` out of any `options`
the config supplies, specifically so a target's own POST configuration
can never leak through - and, as of 2026-08-11 (a code-review finding), so
a config that sets its own `muteHttpExceptions: false` (plausible if the
same `options` object is reused for the real call and the probe) can't
override the forced `true` here either. Without that third exclusion, a
non-2xx response from an otherwise perfectly reachable, correctly-
authorized endpoint made `UrlFetchApp.fetch` throw instead of returning a
response object, and `classifyProbeError()` would misreport it as
`missing_scope`/`error` - exactly the false alarm this probe exists to
avoid (see the module comment above `fetchProbe()`: status code is
deliberately irrelevant to "ok"). Document this compromise anywhere this
module is touched again - it's the one probe that isn't "the same call,
made safely," it's "a different, weaker call."

**Result classification is deliberately best-effort, not a table of exact
GAS error strings.** `SCOPE_ERROR_PATTERN` is a loose case-insensitive
regex, and `classifyProbeError()` falls back to a plain `'error'` status
with the raw message on anything it doesn't recognize. This library has no
way to verify GAS's exact runtime wording without running it in a real
project - same reasoning CLAUDE.md's "About testing" applies everywhere
else. If a future contributor finds the actual wording differs, tighten
the regex; don't assume it's already correct.

**`typeof BigQuery === 'undefined'` is checked before any `BigQuery.*`
call, as its own `service_not_enabled` status distinct from
`missing_scope`.** These are genuinely different fixes in the Apps Script
editor (Services panel vs. `appsscript.json`'s `oauthScopes`), and
conflating them - e.g. by letting the `TypeError` from calling a method on
`undefined` fall through to the generic classifier - would send someone to
edit the wrong thing.

**`formatDebugStatusCounts()`'s known-status list moved into
`DEBUG_CHECK_STATUSES` (2026-08-11, code-review fix).** It used to
hardcode its own `counts` seed object and a separate `labels` object, each
listing the same five status strings by hand - a status added, renamed,
or removed from one of the probe functions above only had to be forgotten
in one of these two copies (not even both) for `counts[check.status] += 1`
to silently produce `NaN` for that status in the summary line, instead of
a clear failure. Not reachable with today's five statuses - every probe
function above only ever returns one of them - but nothing enforced that
staying true as this file changes. `DEBUG_CHECK_STATUSES` is now the one
list both the seed and the labels read from, and `formatDebugStatusCounts()`
throws on any `check.status` it doesn't recognize rather than falling
through to `NaN` - matching this file's own "fail loud on an unexpected
name, don't guess" posture everywhere else (`resolveSelector`'s unknown
kind/name, `parseCommand`'s unknown command, ...).

**`resolveManifestConfig()`/`resolveCompileManifestConfig()` share one
reader now (2026-08-12, ponytail audit).** Both used to independently read
a global, fall back to `{}`, and build the same three-field shape
(`enabled`/`folderId`/`fileName`) - identical except which global name and
which default `fileName` they used. `resolveManifestConfigFrom(globalName,
defaultFileName)` is now the one function that does the reading; each
caller is a one-line call naming its own global and default. The two
globals themselves stay separate (see the comment above
`resolveCompileManifestConfig()`) - only the parsing logic was duplicated,
not the config surface.

## Adding a kind

1. Write the module (see `model.js` for the slot that's already waiting).
2. Add it to `EXECUTORS` here.
3. Add it to `build.sh`'s `MODULES` manifest.
4. Document it: a `docs/<kind>.md` reference plus a link from README.md
   (see CLAUDE.md's "About documentation"); add fixtures to
   `notsobigdata-tests/`.

`usage()`, `resolveSelector`'s error text and `hello()` all read the kind
list from `knownKinds()`, so they pick up the new kind with no edit.
