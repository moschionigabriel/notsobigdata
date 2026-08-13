# model.js — private notes

> Working notes, not user documentation. docs/model.md is the public
> version. Gitignored.

## Status

Implemented (v1: view/table materialization, `ref()`, `config()`, `set()`,
`var()`, `for()`, and user-authored `{% macro %}`).

## `compileModel()` and `buildRefResolver()` (2026-08-09)

Added for cli.js's new `compile` command (see cli.md's own note on this) -
a dbt-`dbt compile`-style dry run that resolves a model's SQL without ever
calling BigQuery. `compileModel(config)` is deliberately a second function
next to `model()`, not a flag threaded through it: the two diverge in
return shape (a compiled string vs. a materialization result with
`relation`/`materialized`/`testResults`), and `model()` already branches on
staged-vs-direct and tested-vs-not - adding a third "don't actually run
this" branch there would tangle two independent concerns into one function.

The one thing genuinely shared between them is *how a `ref()` name resolves*
- against a declared model or a bigquery-target move node - which used to be
an inline closure inside `model()`'s own body. Extracted into
`buildRefResolver(config, registry)` so both `model()` and `compileModel()`
build that closure the same way instead of the two drifting apart the first
time one of them changes. `compileModel()` itself is just:
`assertSingleStatement` (same SQL-shape guard `model()` uses), read the
registry, `compileModelSql(sql, buildRefResolver(config, registry), registry)`
- no new substitution logic, purely reusing what `model()` already needed.

Deliberately does **not** attempt to compile a model whose own `tests[]`
would need resolving (e.g. a `relationships` test's `to`) - `compileModel()`
only ever compiles the model's own `SELECT`, the same scope `dbt compile`
itself has. Test SQL compilation (`compileModelTests()`) stays reachable
only from `model()`'s own real-run path.

## User-authored `{% macro %}` (2026-08-09)

Reuse across models, the gap every built-in `{{ }}` call so far didn't
close: `ref()`/`config()`/`var()`/`set()`/`for()` are all *built into*
model.js, so the only way to avoid repeating a SQL fragment across two
models' `.html` files was copy-paste. `{% macro name(a, b) %}...{% endmacro %}`
is the dbt-macro equivalent, authored by the library's *user*, not this
file.

**Design decisions, in the order they came up in conversation before any
code was written:**

1. **Where do macros live, and how does the library find them?** Considered
   and rejected: a per-macro registry entry (`notsobigdataMacros.macros.name
   = { htmlFile }`), mirroring `notsobigdataModels.models`. Rejected because
   it solves a problem macros don't have - the registry pattern exists for
   *models* only because Apps Script can't enumerate project files, so a
   model's *name* has to be declared somewhere or `cli()` can never find it.
   A macro is never a `cli()` node; nothing needs to discover its name ahead
   of time, only look it up reactively when some model's SQL calls it.
   Landed instead on `notsobigdataModels.macros`: a plain array of file
   names, the same "project-wide setting living on the one shared registry"
   status `vars` already has - not a new global, just one more optional key.
   `readModelsRegistry()` validates it the same way it validates `vars`
   (must be an array, here of non-empty strings) and returns it as
   `macroFiles`.
2. **Does a macro need a wrapping `<script type="...">` tag, with an `id`
   matching its name, the way multi-model SQL files do?** No - and this
   is the one place this feature is *simpler* than the model-SQL tag
   scheme it might look like a sibling of. `extractSqlTags()`/
   `extractModelSql()`'s `id` matching exists to compensate for raw SQL
   having no way to self-identify. A `{% macro name(...) %}` block already
   names itself in its own opening statement, so `extractMacroBlocks()`
   just scans for blocks and reads the name off each one - several macros
   share one file with zero tags, zero ids, zero chance of a stale
   copy-pasted id silently running under the wrong name (the exact failure
   mode the model-SQL id-matching rule exists to prevent, sidestepped here
   by not needing an id at all).
3. **Text-expansion pre-pass, mirroring `expandForLoops()`, not a
   `compileModelSql()` dispatch case.** Same reasoning `{% for %}` already
   established: a macro call's *replacement text* can itself contain
   `{{ ref(...) }}`, `{{ var(...) }}`, or `{% set %}`, which a single-match
   dispatch case (like `config()`/`var()`'s handlers) has no way to expand
   further - it only ever sees one `{{ call(args) }}` match at a time, not
   a span it can read, transform, and splice back in. `expandMacroCalls()`
   runs in `expandModelNodes()` right after `expandForLoops()` (so a macro
   call written inside a loop body expands once per iteration, for free)
   and before `extractConfigOverrides`/`validateSetUsage`/`validateVarUsage`/
   `extractRefDependencies`/`compileModelSql()` ever see the SQL - so a
   `ref()` living inside a macro body becomes a real dependency edge with
   zero changes to `extractRefDependencies()` itself, the same "for free"
   property `{% for %}` already gives loop bodies.
4. **No macro-to-macro calls.** Real dbt allows arbitrary macro
   composition. This file has consistently avoided building a real
   expression evaluator (see `templateExpressionPattern()`'s own module
   comment, and `{% for %}`'s deliberate no-nesting restriction), and macro
   composition would need actual cycle detection - a macro calling a macro
   calling itself - that nothing else here needs. Enforced the cheap way:
   `readMacroDefinitions()` validates, once, after merging every listed
   file's blocks, that no macro's own body contains a call to any *other*
   name in the merged map. Not "no cycles" - "no calls to another macro at
   all" - which makes a cycle structurally impossible without needing to
   actually trace one. Checked once per registry build (cheap - a project's
   macro files are typically small, and this runs once per `cli()`
   discovery pass, not once per model that happens to call a macro), and
   checked against the macro's own undecorated body, *before* any call
   site's arguments are substituted into it - substituting first and then
   scanning the result would risk a false positive if some call site's
   plain-text argument value happened to look like `othername(...)`.
5. **Argument shape.** Call-site arguments are positional, quoted strings
   only - the same string-literal-only posture every other call in this
   file already takes (`parseSingleStringArgument`/`parseKwargsArgument`/
   `parseVarArguments`/`parseForIterable`), via a new
   `parseMacroCallArguments()`. A macro's own *parameters*, on its
   `{% macro name(a, b) %}` opening line, are bare identifiers instead
   (`parseMacroParams()`) - not quoted, since a parameter is a *name* the
   body refers to via `{{ a }}`, not a value, the same distinction
   `{% for %}`'s loop variable (bare) has from its iterable's items
   (quoted).
6. **Reserved names.** A macro named `ref`, `config`, or `var`
   (`BUILTIN_TEMPLATE_CALLS`) is rejected in `readMacroDefinitions()`
   itself, the same place a cross-file name collision is caught. Found
   during release review, not designed in up front: `expandMacroCalls()`
   runs before `compileModelSql()`'s own `ref`/`config`/`var` dispatch ever
   sees the SQL, and its `has(macros, call)` check has no opinion on
   whether `call` happens to be a built-in name - so a macro named `ref`
   would have silently taken over every `{{ ref(...) }}` in the *whole
   project*, with dependency edges just vanishing and no error anywhere.
   Same "reject rather than guess a precedence" posture as every other
   collision in this file.
7. **Where a bad macro fails.** `readMacroDefinitions(registry.macroFiles)`
   is called once, hoisted above the per-model loop in `expandModelNodes()`,
   and deliberately left *outside* the per-model `try`/`catch` that wraps
   everything else in that loop. A malformed macro file, a name declared in
   two files, or a macro-to-macro call is a mistake in shared config every
   model might read - not any one model's own problem - the exact same
   reasoning that already lets `readModelsRegistry()` itself throw
   unguarded at the top of `expandModelNodes()`. A *call-site* mistake (wrong
   arg count, a call inside one model's SQL to a name that isn't a declared
   macro) still surfaces as that one model's own `discoveryError`, same as
   every other per-model SQL problem.

**New functions**, in the order they're used: `macroOpenPattern()`/
`macroEndPattern()` (the `{% macro name(...) %}`/`{% endmacro %}` shapes,
non-global regexes, same reason `forStatementOpenPattern()`/`forEndPattern()`
aren't global - the match is used to slice the string, not just collected),
`parseMacroParams()`, `extractMacroBlocks()` (one file → `{name: {params,
body}}`, reusing `expandForLoops()`'s left-to-right splice-and-resume
scanning rather than a global regex's `lastIndex`), `readMacroDefinitions()`
(N files → one merged map, plus the macro-to-macro validation pass),
`parseMacroCallArguments()`, `expandMacroCalls()` (the pre-pass itself).
`compileModelSql()` needed no logic changes - by the time it runs, every
macro call has already been expanded away or, if the name matched neither a
macro nor a built-in, falls through to its existing "unsupported template
call" throw, whose message now also mentions macros so the error is
actionable (a typo'd macro name, or a file missing from
`notsobigdataModels.macros`, looks identical to a genuinely unsupported
call from `compileModelSql()`'s point of view).

Verified with the same kind of throwaway Node smoke test used for
`config()`/`set()`/`var()`/`for()` (the new functions are pure string
transformation - no `HtmlService`/`BigQuery` to mock, `readModelHtml()`
stubbed with an in-memory file map): basic single- and multi-param
expansion, a zero-param macro, a `{{ ref(...) }}` inside a macro body
surviving expansion untouched for downstream pickup, several
self-naming macros sharing one file, an unrecognized call name passing
through untouched, an arg-count mismatch throwing, an unterminated
`{% macro %}`/stray `{% endmacro %}` throwing, a duplicate macro name
within one file and across two files both throwing, a bad/duplicate
parameter name throwing, a macro-to-macro call throwing at
`readMacroDefinitions()` time, an empty macro file list being a true
no-op, a malformed (unquoted) call-site argument throwing, and a macro
called more than once in one SQL string (simulating what `{% for %}`
would produce) expanding every occurrence correctly.

## `{% for %}` (2026-08-09)

The first block construct beyond `{% set %}`, and the first macro that
isn't a case in `compileModelSql()`'s dispatch at all. Design decision:
implement it as a **text-expansion preprocessing pass**
(`expandForLoops()`), run once in `expandModelNodes()` right after a
model's SQL is read, *before* `extractConfigOverrides`/`validateSetUsage`/
`validateVarUsage`/`extractRefDependencies` or `compileModelSql()` ever see
it. Considered and rejected: adding `for` as a `compileModelSql()` dispatch
case the way `config()`/`var()` were - doesn't work for a block construct,
since a call's dispatch handler gets one `{{ call(args) }}` match at a
time, not a whole span of surrounding SQL text it needs to read, repeat,
and splice back in. Preprocessing is also what makes "a `ref()`/`config()`/
`{% set %}` call inside a loop body just works" free: by the time any of
those functions run, `{% for %}` is already gone, so a doubled `ref()`
inside a 2-item loop is indistinguishable from a doubled `ref()` a human
typed twice by hand - same dependency-dedup path (`mergeDependsOn`'s
`has()` check) handles both.

Deliberately string-literal-only iterable (`['a', 'b']`, not `var('key')`
or `ref(...)`) - same posture `config()`'s kwargs and `{% set %}`'s
right-hand side already take, and it sidesteps a real design question left
unresolved: `var()`'s existing values are validated as strings only
(`readModelsRegistry()`), so making `var()` usable as a `for` iterable
would mean either loosening that validation to accept arrays too (splitting
`var()`'s resolution into "scalar context" vs "list context," each needing
its own error message) or inventing a second, `for`-only way to declare a
project-level list. Neither is a small change, and no concrete use case
called for it yet - deferred, not rejected outright.

Deliberately non-nesting: `expandForLoops()` finds the first `{% for %}`,
then the *nearest* following `{% endfor %}` as that block's body - a
nested `{% for %}` inside that body would make its own `{% endfor %}` the
one found, truncating the outer body and leaving a stray unmatched
`{% endfor %}` behind. Rather than let that silently produce wrong SQL,
`expandForLoops()` explicitly checks the captured body for another
`{% for %}` before expanding and throws a clear "nesting is not supported"
error instead. A real nesting implementation would need the endfor search
to track depth (skip one endfor for every nested for seen) - not
attempted, since no use case has needed it and it's a bigger step toward
"general block parser" than this file has wanted to take at any point so
far (see templateExpressionPattern()'s own module comment on the same
tension for `{{ }}` calls).

The loop variable only substitutes in the bare `{{ x }}` shape (reusing
`{% set %}`'s own bareVarPattern-style regex, built fresh per loop-variable
name since it isn't a fixed name the way `{% set %}`'s own bare-reference
scan is) - not as an argument inside another call (`{{ ref(x) }}`). Doing
that would mean rewriting a call's *argument text* mid-scan before
`parseSingleStringArgument`/`parseKwargsArgument` ever see it - a second,
narrower text-substitution pass nested inside the first, for a capability
`{% set %}` doesn't have either (its own value can't be read back as a
call argument, only as a bare `{{ key }}`). Kept symmetric with that
existing limit rather than giving `for` a capability no other macro in
this file has.

No discovery-time `validateForUsage()`-style function exists, unlike
`set()`/`var()` - and deliberately so. `set()`/`var()` need a two-phase
check-then-resolve because their actual substitution happens later, at run
time, inside `compileModelSql()`. `{% for %}` has no run-time phase at
all: `expandForLoops()` fully expands (and validates - empty list, bad
item quoting, unterminated/unmatched tags, nesting) in one pass at
discovery time, and the result is what `config.sql` becomes from then on.
By the time `model()` actually runs, `config.sql` already has zero
`{% for %}` in it, so `compileModelSql()` needed no changes at all - not
even a new dispatch case.

Verified with the same kind of throwaway Node smoke test used for
`config()`/`set()`/`var()` (copy of `expandForLoops()`/`parseForIterable()`
run standalone, no `HtmlService`/`BigQuery` mocking needed since the
function is pure string transformation): basic pivot-column expansion,
two separate non-nested loops in one SQL both expand, nested `{% for %}`
throws, unterminated `{% for %}` throws, a stray `{% endfor %}` with no
opening tag throws, an empty list throws, an unquoted item throws, a bare
`{{ other }}` inside the loop body that isn't the loop variable passes
through untouched (left for `{% set %}`'s own bareVarPattern resolution
downstream), and a `{{ ref(...) }}` call inside a loop body survives
expansion doubled (once per item) for the existing pipeline to pick up.

## `parseForIterable()`'s comma split fixed for quoted commas (2026-08-11)

A code-review pass across the whole repo caught a bug the smoke test above
never covered: `parseForIterable()` used to call `inner.split(',')`
directly on the bracket contents *before* checking each piece looked like
a quoted string, so a literal comma inside a quoted item split the item
in half. `['open, pending', 'closed']` became `"'open"` and `" pending'"`
- neither a valid quoted string on its own - so the whole `{% for %}`
threw "is not valid," even though the list looks well-formed to whoever
wrote it. Unlike `parseKwargsArgument()`'s own documented "naive
comma-splitting, fine today since no value needs a comma" limitation (see
"config() macro" above), this one wasn't documented as a known limit at
all - just missed.

**Fix: `splitTopLevelListItems()`, a small char-by-char scan that tracks
whether the current position is inside a quote**, added right above
`parseForIterable()`. A comma encountered while `quoteChar` is set (inside
an open `'` or `"`) is appended to the current segment instead of ending
it; the segment only closes on a comma seen *outside* any quote. No
escape-sequence support - same "simple string literal, no backslash
escaping" posture every other quoted value in this file already takes
(`parseSingleStringArgument`, `parseKwargsArgument`, ...), so a quote
character can only ever open or close a segment, matching
`parseForIterable()`'s own existing item-shape regex
(`^\s*(['"])([^'"]*)\1\s*$`), which likewise has no escape support. Every
segment `splitTopLevelListItems()` returns still gets validated against
that same regex afterward, unchanged - a segment that isn't a clean quoted
string (an unquoted item, junk between items) still throws exactly as
before; only a comma legitimately *inside* one quoted item stopped being
misread as a separator.

## The design, and why it's shaped this way

**SQL lives in `.html` files.** Not a choice, a constraint: an Apps Script
project can hold `.gs` and `.html` files and nothing else, so `.html` is the
only way to keep a plain-text blob in the project.

**A file's SQL is picked out by how many `<script type="text/sql">` tags
it has**, not a fixed one-tag-per-file rule (`extractModelSql()`): zero
tags means the whole file is the SQL; one tag is used regardless of `id`;
more than one requires every tag to carry an `id`, and the model's own
name picks which one. This grew out of a real design conversation
(2026-08-09): the original one-file-per-model shape used a tag purely as
"a way to hold a plain-text blob," which the `.html` file itself already
does - the tag only earns its place once it's doing actual work
disambiguating *which* block belongs to *which* model in a file several
models share. Recognizing by tag count (rather than, say, a separate
config flag for "this file is shared") means the simple one-model case
needs no tag at all, and the shared case is opt-in just by adding more of
them - no mode switch to set anywhere.

**A shared file is read once per `cli()` run, not once per model
pointing at it.** `expandModelNodes()` keeps a `sqlFile → html` cache
scoped to its own call (`emptyMap()`/`has()`, reused from `cli.js` for the
same reason `readModelsRegistry()` already does - `sqlFile` is a
caller-chosen string, same risk class as a node name). Without this, two
models sharing a file would double the `HtmlService` round trips for that
file - exactly the kind of redundant read the previous review round
already fixed once (model's SQL being read twice per model, once at
discovery and once at execution); worth avoiding here too rather than
reintroducing the same class of waste from a different angle.

**`{{ ref('other_model') }}` *is* the model-to-model dependency
declaration.** A `move` node declares `dependsOn` by hand; a `model` node
doesn't repeat in `dependsOn` something the SQL already says about another
*model*. The edges get parsed out of the SQL by `extractRefDependencies()`,
and the same refs get substituted from the resolved registry
(`resolveModelConfig()` + `qualifiedRelation()`) just before execution, via
`compileModelSql()`. (A model *can* still have its own hand-written
`dependsOn` today — see "Depending on a move node" below; it's additive to
`ref()`, never a substitute for it.)

**Every model is one entry in a single shared registry, not its own
top-level `var`.** This is the one place model's discovery shape actually
diverges from move's "every node is its own var" — decided explicitly
(2026-08-08 design session) over the alternative of one thin `kind: 'model'`
var per model, because a project with many models shouldn't need N
boilerplate top-level declarations just to register them. The registry
(`notsobigdataModels`) holds project-wide defaults (`projectId`, `dataset`,
`materialized`) plus a `models` map; each entry inherits the defaults and
can override any of them, and `sqlFile` defaults to `<name>.html` when
omitted. `dependsOn` joined this same defaults list in the design
conversation below, getting override-not-merge semantics for free from the
same mechanism.

The cost of that shape: `discoverNodes()`'s normal var-scan (any top-level
`var` with a `.kind` key) can never find these nodes, since
`notsobigdataModels` itself carries no `kind`. `expandModelNodes()` is the
hook that makes up the difference — it turns the one registry into N
fully-formed node objects (`{name, kind, variable, config, dependsOn}`,
same shape the var-scan produces) and `discoverNodes()` folds them
straight into the same list, right after its own scan, with the same
duplicate-name check. Selection, ordering and the run loop never learn two
discovery mechanisms produced that list.

**One real consequence of deriving edges from SQL, not stated up front:**
`expandModelNodes()` has to read every declared model's SQL to know its
`dependsOn`, whether or not that model was selected to run — the same
tension dbt itself has (a `dbt run --select` still needs the whole
manifest to parse first) and inherent to any ref()-based graph. Unlike
dbt's parse step, though, a model whose file can't be read (missing file,
mismatched tag `id`, duplicate `id`) does *not* abort discovery for
everything else any more (fixed in the second `/release finish` pass
below) — `expandModelNodes()` catches that model's own error and stashes
it on its node as `config.expandError`, which `model()` rethrows if that
node's turn to run ever comes up. So the broken model still fails (and
still blocks its own dependents, same as any other failure), but an
unrelated `cli('run --select someMoveNode')` or `cli('run --select
someOtherModel')` is unaffected — the failure is isolated to exactly the
node that caused it, same posture `runNodes()` already has for every other
kind of failure.

## Template scanning

`scanTemplateExpressions()`/`compileModelSql()` implement a generic
"extract every `{{ call(...) }}` span, dispatch by leading call name"
scanner — not a `ref()`-only regex — specifically so a later macro (e.g.
`config()`) is a new case in `compileModelSql()`'s dispatch, not a rewrite
of the scanner. `compileModelSql()` throws on any call name it doesn't
recognize, rather than passing it through as literal text.

The scanner's regex matches a call's *shape* only (name plus whatever's
between its parens) rather than ref()'s own stricter "exactly one quoted
string" shape - `parseSingleStringArgument()` enforces that narrower shape
separately, once a call is already known to be `ref`. This split matters:
an independent security review's own verification during this PR's first
pass found that matching the narrow shape *in the scanner itself* let a
call that didn't fit it (a no-arg `{{ macro() }}`, a kwarg-style
`{{ config(materialized='table') }}`) fail to match at all and pass
through as literal text - never reaching the "unsupported template call"
check, since that check only runs on things the scanner matched in the
first place. Not a live exploit under this module's trust model (the SQL
file is author-written, not attacker-controlled), but it broke the stated
guarantee that any non-`ref()` call throws rather than leaking through, so
it was fixed rather than left as a known gap. Covered by
`testModelKwargStyleCallThrows` in the companion test project.

## config() macro (2026-08-09)

The macro predicted above as the likely first addition beyond `ref()`,
implemented: `{{ config(materialized='table') }}`. Two new pieces beyond
the scanner/dispatch this module comment already anticipated:

- `parseKwargsArgument()` - `ref()`'s own `parseSingleStringArgument()`
  only handles one positional quoted string; `config()` needs
  `key='value', key2='value2'` parsing. Naive top-level comma split, no
  support for a comma inside a value - fine today since `materialized`'s
  only legal values (`'view'`/`'table'`) never contain one, worth
  revisiting the day a config key's value legitimately might.
- `MODEL_CONFIG_KEYS` - a separate whitelist from `MODEL_DEFAULT_KEYS`,
  deliberately not reused even though `materialized` is on both today. The
  two lists answer different questions (`MODEL_DEFAULT_KEYS`: what the
  registry may default; `MODEL_CONFIG_KEYS`: what a model's own SQL may
  override) and letting SQL override `projectId`/`dataset`/`dependsOn`
  later just because they're already on the other list would be an
  accident of implementation, not a deliberate choice.

Precedence: `config()` wins over both the registry's project-wide default
and the model's own registry entry - extracted in `expandModelNodes()`
right after `config.sql` is set, merged over the result of
`resolveModelConfig()`'s own defaults+entry merge. This mirrors dbt's own
relationship between a model's inline `config()` block and
`dbt_project.yml`, and was a deliberate choice over the alternative
(registry wins, config() only fills in gaps) - the registry is *further*
from the model's own SQL than the model's own SQL is, so the closer
source should win, same intuition as entry-overrides-default already
established for `MODEL_DEFAULT_KEYS`.

At most one `config()` call per model, enforced in
`extractConfigOverrides()` - a second call has no obvious precedence rule
(last-wins? first-wins? per-key merge?) so it's rejected rather than
guessed at. `extractConfigOverrides()` scans `stripSqlComments()`'s output,
same as `extractRefDependencies()`, so a commented-out `config()` doesn't
silently take effect.

**One scan, not three.** `extractRefDependencies()`, `extractConfigOverrides()`
and `validateVarUsage()` all take an already-scanned `matches` array
(`scanTemplateExpressions(stripSqlComments(sql))`), not raw `sql` - found
during release review, since all three had independently been stripping
comments and re-tokenizing the *same* model's SQL back-to-back in
`expandModelNodes()`'s per-model loop. `expandModelNodes()` now scans once
per model and passes the result to all three.

At compile time, `compileModelSql()` strips the call from the output SQL
(`config` case returns `''`) rather than substituting it - by the time
`compileModelSql()` runs, the override is already folded into
`node.config` from discovery, so the call itself has nothing left to do.
It still re-parses via `parseKwargsArgument()` first (result discarded)
purely for defense in depth, mirroring `ref()`'s own redundant
re-validation at compile time - there's no known way for the SQL string to
differ between discovery and compile (`config.sql` is set once, never
mutated), but diverging from that precedent for `config()` alone would be
its own small surprise for whoever reads both code paths next.

Verified with a throwaway Node smoke test (mocked `HtmlService`/
`BigQuery`/`Logger`, not committed anywhere) before writing this up:
confirmed the override actually reaches `resolveMaterialized()` (a
`config()`-table model compiles to `CREATE OR REPLACE TABLE`), confirmed a
commented-out `config()` is ignored for override purposes exactly like a
commented-out `ref()` is ignored for dependency purposes, confirmed the
unknown-key and second-call cases fail at discovery with `cli('list')`
rather than only surfacing on a real run.

## Fixes from /release finish's simplify + independent review pass (2026-08-09)

A second, batched review (per CLAUDE.md's release workflow) found several
real gaps beyond the templating one above, none of them exploitable under
this module's trust model but each worth closing:

- **`readModelSql()` now strips a trailing `.html` before calling
  `HtmlService.createHtmlOutputFromFile()`.** Google's own documented
  contract takes the file's registered name *without* the extension; the
  original code passed `sqlFile` (which includes it) straight through.
  This had passed a live GAS test regardless (the runtime appears lenient
  about it in practice), but relying on undocumented leniency instead of
  the documented contract isn't something to leave in place once noticed.
  `sqlFile` itself keeps its `.html` suffix as a config value - only the
  actual API call is normalized.
- **`readModelSql()` now requires exactly one `<script type="text/sql">`
  tag**, throwing if there are zero or more than one, instead of silently
  taking the first match via a non-global regex `.exec()`. (Superseded
  later the same day by the tag-count-based dispatch described above,
  once "zero or more than one" turned out to be a real, wanted shape
  rather than an error - `readModelSql()` itself was later split into
  `readModelHtml()`/`extractModelSql()`. Left here as the actual history
  of what this review round found and fixed at the time.)
- **`model()` now calls `assertSingleStatement()`** (extracted out of
  `move.js`'s `assertReadOnlySelect` into its own function, so model.js
  reuses just the "no `;`-separated statements" half without also
  requiring a leading `SELECT`/`WITH` - models are meant to write).
- **`discoverNodes()` now rejects a top-level `var` declared with
  `kind: 'model'`** with a clear redirect error. Before this fix, since
  `model` is now a real `EXECUTORS` entry, a var written the old way (an
  earlier design, before the registry shape was decided) wouldn't be
  ignored as an unknown kind anymore - it would silently become a node
  with no derived `dependsOn` at all, ordering wrong relative to whatever
  it actually `ref()`s, with no error to explain why.
- **`readModelsRegistry()` now throws if `notsobigdataModels` (or its
  `.models` field) is declared but structurally malformed** (an array, a
  string, etc.) instead of silently treating it the same as "not declared
  at all." Absent entirely is still silent - only a value that's clearly
  meant for this library but shaped wrong is an error.
- **`expandModelNodes()` now caches the SQL it reads while deriving
  `dependsOn` onto `config.sql`**, and `model()` reuses it instead of
  calling `HtmlService` a second time for the same file - one read per
  model per run instead of two.
- **`claimName()`/`readOptionalGlobal()` extracted** in `cli.js` - the
  duplicate-node-name check and the guarded-global-read pattern were each
  copy-pasted at least once by this feature; both are now one function
  reused everywhere they're needed instead.

## Fixes from /release finish's second simplify + independent review pass (2026-08-09)

This release branch (`release/9`) picked up a second feature (the shared
`.html` tag-count dispatch, above) after the first `/release finish` pass
already ran once against just `model()` v1. Running both checks again
against the *full* `release/9` vs `main` diff surfaced more to fix:

Simplify pass (reuse/simplification/efficiency, no behavior change):
`qualifiedTableRef()` extracted in `move.js` so it, `runSqlTests()`, and
model.js's `qualifiedRelation()` build a backtick-quoted relation identifier
one way instead of three separate copies; `isPlainObject()` extracted in
`cli.js`, replacing the duplicated shape-check in `discoverNodes()` and
twice over in `readModelsRegistry()`; `resolveModelConfig()` now takes an
optional already-read `registry` so `expandModelNodes()`/`model()` don't
re-read and re-validate `notsobigdataModels` once per model or per `ref()`;
`qualifiedRelation()`'s two copy-pasted validations collapsed into one loop;
`summarizeNodeResult()` (cli.js) now recognizes a model's `{relation,
materialized}` result shape for the run manifest, matching every other
result shape it already handled.

Independent review pass (real correctness gaps, closed):

- **One broken model no longer aborts discovery for everything else.**
  `expandModelNodes()` used to let any per-model read/parse error
  (unreadable `sqlFile`, mismatched tag `id`, duplicate `id`) throw straight
  out of `discoverNodes()`, killing `cli()` for every node in the project -
  move nodes included, and degrading `cli('hello')` to "discovering nodes
  failed," hiding everything it would otherwise have listed. Contradicted
  this library's own stated failure posture (one node fails, its dependents
  skip, unrelated branches keep running - see cli.js's `runNodes()`).
  Fixed by wrapping each model's own resolve/read/extract step in its own
  try/catch inside `expandModelNodes()`'s loop; a failure there becomes that
  node's own `discoveryError` (a plain node-level field, not nested in
  `config` - kept kind-agnostic on purpose) instead of an exception that
  unwinds `discoverNodes()` itself.

  First fix attempt stashed it as `config.expandError` and had `model()`
  rethrow it once that node's turn to run came up - which broke a *different*
  guarantee, caught by the human GAS-testing round for this fix itself
  (not the original feature): `cli('list')`'s whole point is surfacing a
  config mistake before anything runs for real, and four existing fixtures
  (`testModelMultipleSqlTagsWithoutIds...`, `testModelSingleTagMismatchedId...`,
  `testModelSharedFileNoIdMatch...`, `testModelSharedFileDuplicateId...`)
  expected exactly that - `cli('list')` throwing synchronously with the
  tag/id error. Deferring the error to `model()` meant a dry "list" run
  never called the executor that would raise it, so it silently reported
  "planned" instead. Corrected by moving the check into `cli.js`'s
  `runNodes()` itself: any node carrying a `discoveryError` is reported
  `failed` immediately, before the `dryRun` branch and before the
  blocked-by-dependency check, so it's caught by `list` *and* `run` alike,
  while every unrelated node - regardless of kind - is untouched either
  way. The four fixtures were updated to assert on `cli('list')`'s
  returned report (`node.status === 'failed'`) instead of a thrown
  exception, and renamed with a `...FailsAtList` suffix to say so.

  A malformed `notsobigdataModels`/`.models` shape is deliberately *not*
  covered by any of this - `readModelsRegistry()` still throws for that,
  since it's a mistake in the one config every model shares, not one
  model's own problem.
- **A malformed `{{ ... }}` no longer ships to BigQuery as literal,
  unsubstituted text.** `templateExpressionPattern()`'s args group
  (`[^)]*`) can't match a call containing its own `)` - e.g. a stray paren
  inside a `ref()` argument - so that span skipped the scanner (and the
  "unsupported call" check) entirely, defeating the module's own stated
  guarantee that any non-`ref()` `{{ }}` throws rather than leaking through.
  `compileModelSql()` now throws if `{{` is still present in its output
  after substitution.
- **A `ref()` inside a SQL comment no longer creates a real dependency
  edge.** `extractRefDependencies()` scanned raw SQL, so `-- from
  {{ ref('old_model') }}` created an edge on `old_model` even if that model
  had since been deleted, aborting the whole run over dead commented-out
  text. Now scans `stripSqlComments(sql)` (move.js's own helper, reused)
  instead.
- **Docs contradicted the code on the single-tag case.** README.md said a
  lone `<script type="text/sql">` tag's `id` is used "with or without" a
  match to the model name; `extractModelSql()` has always actually thrown
  on a mismatch. Kept the stricter code behavior (catches a stale
  copy-pasted `id` early) and fixed the docs/module comment to match
  instead of loosening the check.

## Depending on a move node (2026-08-09 design conversation)

Before this, a model's `dependsOn` was entirely computed from
`extractRefDependencies()` — there was no way to declare that a model
depends on a `move` node at all, since `ref()` only resolves against
`notsobigdataModels.models`. The only workaround was running `cli('run
--select move')` then `cli('run --select model')` as two separate calls,
a kind-wide barrier: every model waits for every move, even one that only
needs a single specific move node's output. The gap surfaced from a user
walking through a concrete scenario (two `move` nodes, two models, each
model only actually depending on one specific move) and asking how to
express the fine-grained edge — see conversation this design note is
attached to.

The fix has three parts, each pinned down as a separate fork during that
conversation rather than assumed:

- **`dependsOn` joined `MODEL_DEFAULT_KEYS`** (`src/model.js`), so it gets
  the exact override-not-merge behavior `projectId`/`dataset`/`materialized`
  already have via `resolveModelConfig()`'s existing merge loop — a
  project-wide default at the registry's top level, replaced entirely
  (not merged) by an entry that sets its own. No new merge logic needed;
  this was the whole point of piggybacking on the existing mechanism.
  Fine-grainedness (per-model, not per-registry) falls out for free from
  `expandModelNodes()` already building one independent node per registry
  key regardless — the same reason per-model `materialized` overrides
  already work.
- **The resolved hand-written `dependsOn` is always unioned with, never
  replaces, the model's own `{{ ref() }}`-derived edges** —
  `mergeDependsOn()`. A model's real `ref()` relationships must never be
  suppressible by an unrelated `dependsOn` entry; the two are additive,
  covering two different things (`ref()` = model-to-model, `dependsOn` =
  everything else).
- **`dependsOn` naming a `move` node specifically is a documented
  convention, not an enforced one.** Rejecting a `dependsOn` entry that
  names another model instead of a `move` node (nudging toward `ref()`)
  was considered and explicitly turned down — it would require passing
  the already-discovered `move` node list from `cli.js`'s `discoverNodes()`
  into `expandModelNodes()`, a new cross-module argument that doesn't
  exist today, to enforce something the existing `assertDependenciesExist()`
  (which already rejects a dangling/typo'd name of *any* kind) covers the
  part that actually matters for. (That cross-module argument exists now —
  see "`ref()` resolving a `move` node's bigquery target" below — added for
  a different reason than this one, so this paragraph's own conclusion
  still holds: nothing here newly enforces `dependsOn` naming only `move`
  nodes.)

Validation of the hand-written value itself (must be an array of
non-empty strings) reuses `cli.js`'s `parseDependsOnList()` — factored out
of `discoverNodes()`'s own inline check specifically for this, rather than
duplicating it a second time (same lesson as `claimName()`/
`readOptionalGlobal()` being extracted during the previous review round).
A validation failure is caught by `expandModelNodes()`'s existing per-model
`try/catch` and becomes that model's own `discoveryError` — never aborts
discovery for the rest of the registry, and is visible to a dry
`cli('list')`, same posture as every other error that function can raise.

## `ref()` resolving a `move` node's bigquery target (2026-08-09)

`dependsOn` (above) was always the documented escape hatch for "a model
needs to wait on a `move` node" — but for the common case, a model
`select`ing directly from a table a `move` node loaded into BigQuery, it
was a worse fit than `ref()`: the dependency and the SQL's actual `FROM`
had to be kept in sync by hand, exactly the drift `ref()` exists to
prevent for model-to-model deps. Asked directly ("why can't `ref()` just
reach a `move` node too?"), there wasn't a good reason it couldn't — a
`move` node's bigquery target is already a real, queryable relation, the
same shape a model's own relation is.

**The cross-module argument the previous design note explicitly turned
down now exists, for this.** `cli.js`'s `discoverNodes()` passes its
already-scanned non-model node list into `expandModelNodes(otherNodes)`
(previously called with no arguments) — the same list the earlier
`dependsOn` note considered wiring through and declined, since nothing
about `dependsOn` needed it. `ref()` resolution does.

**Resolution happens once, at discovery time, not once per compile.**
`indexMoveBigQueryTargets(otherNodes)` builds a `name -> qualifiedTableRef()`
map from every `move` node whose `config.target.type === 'bigquery'`
(missing `projectId`/`dataset`/`table` on that target is deliberately not
an error here — that's `loadBigQuery()`'s own config to validate, not this
index's business; such a node just doesn't make it in, so a `ref()` naming
it fails the same "unknown ref target" way a typo would). Each model's own
loop in `expandModelNodes()` then classifies every `extractRefDependencies()`
name as a known model, a known bigquery-target `move` node (cached onto
`config.moveRefTargets`), or neither — the last case is a `discoveryError`,
same "fail loud at `list` time" posture as every other check in that loop.
`compileModelSql()`'s `resolveRef` callback (in the `model()` executor)
then just checks `config.moveRefTargets` when a name isn't a declared
model — a cheap lookup against an already-resolved value, not a fresh
global-scope scan at compile time.

**Edge-building needed no changes at all.** `extractRefDependencies()`
already just extracts names with no opinion on what they resolve to, and
`assertDependenciesExist()` (`cli.js`) already accepts a dependency edge
naming *any* declared node regardless of kind — both were already
kind-agnostic enough for this before the feature existed. The only real
gap was `resolveRef` only ever trying the models registry.

**`relationships` tests' `to` deliberately did not get the same
treatment.** A `relationships` test needs a `field` to join on and its own
query shape (`MODEL_TEST_COMPILERS.relationships`) — "does every value in
this column exist in another model's column" doesn't generalize cleanly to
an arbitrary `move`-loaded table without inventing a second, differently-
shaped `move` counterpart. Left as model-only; revisit only if a concrete
use case shows up, not preemptively.

## Security

Ref substitution is string interpolation into SQL, executed with the script
owner's live BigQuery credentials. The rule: **only ever substitute a name
that resolved to a known model in the registry, or a known `move` node's
own bigquery target** — never interpolate arbitrary text from the config or
from the SQL file. Enforced twice over, at both ends of `ref()`'s two
resolution paths: `resolveModelConfig()` throws on an unknown model name,
and the `move`-node path only ever substitutes `qualifiedTableRef()` run
over that node's own `config.target.projectId/dataset/table` — fields the
pipeline author already declared to load real data into, not new text a
ref() call itself supplies (a ref() call only ever contributes the *name*
being looked up, never a value that reaches the compiled SQL directly). See
"`ref()` resolving a `move` node's bigquery target" below.

`move`'s `assertReadOnlySelect` guard does *not* apply to a model's own
materializing SQL — models are meant to write. That makes the
ref-resolution rule the only thing standing between a typo and a
destructive statement, so it carries real weight. It *does* apply to every
test query a model runs (both a custom `tests[].query` and every
compiler-generated one) — see "Tests" below.

## Tests (2026-08-09 design conversation)

`tests` gives a model dbt's own generic-test experience
(`not_null`/`unique`/`accepted_values`/`relationships`) plus custom SQL,
reusing `move.js`'s `runSqlTests()` machinery rather than building a
second "run SQL, zero rows means pass" mechanism from scratch — a
`bigquery` move target's `target.sqlTests` already is that primitive,
just previously only reachable from `move.js`.

**`runSqlTests()`/`assertReadOnlySelect()` were generalized to take an
explicit `messagePrefix`, not duplicated.** Both used to hardcode
`'move(): '` (and, for `runSqlTests`, "the staged table") into their
thrown messages — fine when `move.js` was the only caller, wrong once
`model.js` needed the same primitive with its own error text.
`assertSingleStatement()` already took an explicit `messagePrefix` the
caller controls; the other two now follow the same convention. Both of
move.js's own call sites (the two-argument old signature) were updated to
pass their own `'move(): ...'` prefix explicitly — move's own error text
is unchanged except the final combined-failure message now names the
actual relation instead of a hardcoded "the staged table" (an incidental
improvement, not a behavior change worth its own note).

**Generic checks compile to SQL, they don't evaluate in memory.** Unlike
`move.js`'s `CELL_CHECKS` (per-cell JS functions over an in-memory 2D
array), `MODEL_TEST_COMPILERS` builds a query string per check
(`not_null`/`unique`/`accepted_values`/`relationships`), each still
containing the literal `{{ this }}` placeholder — substitution happens
once, inside the shared `runSqlTests()`, not duplicated per-compiler. The
check-name vocabulary deliberately only covers dbt's actual four built-in
generic tests, not move.js's extra `min`/`max`/`regex` — those are
row-level checks that don't map cleanly to "a query returning offending
rows," and a custom `query` test already covers that ground trivially
(`WHERE amount < 0`). `MODEL_TEST_KNOWN_CHECKS`/`MODEL_TEST_COMPILERS`/
`MODEL_TEST_REQUIRES` mirror move.js's `KNOWN_CHECKS`/`CELL_CHECKS`/
`TEST_CHECK_REQUIRES` prototype-pollution-safe idiom on purpose (array
membership for "is this a known check," `Object.create(null)` for the
lookup maps) — `check` is a config-supplied string, and a plain `{}`
already "has" `toString`/`constructor`/etc.

**Two new small, narrowly-scoped helpers, not general-purpose ones.**
`quoteIdentifier()` backtick-quotes a `column`/`field` (and rejects one
already containing a backtick *or* backslash — can't safely quote around
either) so a column legitimately named `order`/`group`/a reserved word
doesn't break the generated SQL. `quoteSqlLiteral()` renders one
`accepted_values` entry as a SQL literal (numbers/booleans bare, strings
single-quoted with `\` escaped *before* `'`) and throws on anything else
(`null`, an object — no sensible SQL literal). Escaping order matters
here, not just style — escaping `'` first and `\` second would let a
value ending in an odd number of backslashes turn the next value's
escaped-quote sequence into an escaped quote inside *this* value, closing
the literal in the wrong place; caught in this PR's own security-review
pass, fixed by escaping `\` first. Neither helper is a general
SQL-serialization utility; both stay scoped to exactly what this feature
needs, since there's no
second caller yet.

**Validation happens at discovery, full compilation at run time —
same split `{{ ref() }}` already has.** `validateModelTests()` runs inside
`expandModelNodes()`'s existing per-model try/catch (shape only: known
check, required keys, non-empty `values`, no backticks) so a malformed
`tests` entry becomes that model's own `discoveryError`, caught by
`cli('list')` — it deliberately rejects an empty `accepted_values.values`
array too, since BigQuery's `NOT IN ()` is a syntax error, not "always
false" the way `move.js`'s in-memory version degrades to. Full SQL
compilation (`compileModelTests()`, which needs the registry to resolve a
`relationships.to`) happens inside `model()` at run time, mirroring
`extractRefDependencies()` (names only, at discovery) vs.
`compileModelSql()` (full resolution, at run time).

**`relationships.to` is a real `dependsOn` edge**, exactly like
`{{ ref() }}` — `extractTestRefDependencies()` folds it into the same
`mergeDependsOn()` call `{{ ref() }}`'s own edges already go through, so a
model is never tested against a relation that hasn't been built yet.
`assertDependenciesExist()` (cli.js, already kind-agnostic) validates it's
not a dangling name for free — no new validation needed there. `to`
naming a real node that isn't a model is already `blocked`/`skipped`
automatically by `runNodes()` once `to` is a real `dependsOn` edge onto a
failed node — that part needed no change.

**`to` naming a real node that isn't a model used to hit
`resolveModelConfig()`'s "not declared" throw only at run time — fixed to
throw at discovery instead, see "`relationships.to` validated against
declared models at discovery" below.** The original design (kept here for
the record) reasoned that `assertDependenciesExist()`'s existing
kind-agnostic check already covered "is `to` a dangling name," so nothing
else was needed — but that check only confirms `to` names *some* node, not
specifically a model, and `{{ ref() }}`'s own docs above already promise
"another declared model's name" for `to` (`docs/model.md`). A `to` naming
a `move` node passed discovery clean under the original design and only
failed once `compileModelTests()`'s `resolveModelConfig()` call ran inside
`model()` — after `CREATE OR REPLACE` had already materialized the
relation (or, for a staged `table` model, after `modelTableStaged()` had
already created its staging table). That's real BigQuery work undone by a
config mistake `cli('list')` should have caught.

**Tests originally ran after `CREATE OR REPLACE`, not staged-then-promoted
like a `bigquery` move target's `sqlTests` — revisited below, see
"Table-model tests staged before promotion".** The original reasoning
(kept here for the record, since the revisit section explains what was
wrong with it): staging a model's own transform SQL a second time just to
test-before-promote would double BigQuery compute on every run, for a
guarantee real dbt itself doesn't provide either (dbt builds a model,
then runs its tests afterward, non-transactionally — a failing test never
un-writes the model). A failing test throws via the reused
`runSqlTests()`, failing the node and skipping dependents through
`cli()`'s ordinary propagation — same outcome shape as any other
`model()` failure, one step later. No `discard_row` equivalent: unlike
`move()`'s in-memory `tests`, there's no row array left to filter by the
time a test can run — the relation is already fully written.

**`result.testResults` needed no `cli.js` changes.**
`summarizeNodeResult()` already copies `result.result.testResults` into
the run manifest generically (independent `if`s, not `else if`, so it
sits alongside the existing `relation`/`materialized` copy) — a
consequence of it already handling `move`'s own `testResults`
(row-level `config.tests`) the same way. Worth knowing the two aren't the
same shape if you're reading a manifest: `move`'s `testResults` is
`{ran, discarded}` from row checks; `model`'s is `{ran}` from
`runSqlTests()`.

## Table-model tests staged before promotion (2026-08-09 review feedback)

External review on the "Tests" section above pointed out the real
consequence of "tests run after `CREATE OR REPLACE`": a `table` model
whose relationship test fails still briefly has its bad rows sitting in
the real relation, findable by anything reading it before the test even
finishes. The original write-up (above) leaned on "dbt doesn't give this
guarantee either" as the justification — true of *default* `dbt build`,
but beside the point: this library already has the staged-then-promoted
pattern, in `move.js`'s `loadBigQueryStaged`, and the actual objection
("would double BigQuery compute") turned out to rest on a wrong
assumption about how promotion would work.

**The fix: promote via a copy job, not a second `SELECT`.** The
"double compute" reasoning assumed promoting from a scratch table meant
re-running `CREATE OR REPLACE TABLE <real> AS SELECT * FROM <staging>` —
a second full query execution. `loadBigQueryStaged` already proves that's
not necessary: `BigQuery.Jobs.insert` with `configuration.copy`
(`sourceTable`/`destinationTable`/`writeDisposition`) copies a table at
the metadata/storage level, no query slots consumed. Applying that to
`model()` gets the "never test data already sitting in the real
relation" guarantee without re-running the model's own `SELECT` a second
time — it still runs exactly once per run, same as before.

**Only `materialized: 'table'` models with `tests` take this path** —
see `modelTableStaged()` in `src/model.js`. A `view` never lands data (a
view is stored SQL text; `CREATE OR REPLACE VIEW` only changes what a
*future* query sees), so staging one would cost an extra query execution
to test a snapshot that isn't even representative of the next live query
against it — not worth it. A `table` with no `tests` has nothing to
check, so it keeps materializing directly too. `model()` branches on
`materialized === 'table' && hasTests` right after resolving both, before
either the old direct path or the new `modelTableStaged()` runs.

**Staging table creation inlines its own `expiration_timestamp`, unlike
`loadBigQueryStaged`'s separate `BigQuery.Tables.insert`.**
`loadBigQueryStaged` pre-creates an empty staging table via
`Tables.insert` (so it can set `expirationTime` before any data lands)
because its own write path is a CSV load job, which needs a destination
to already exist. `model()` never talks to BigQuery except through query
jobs, so `CREATE OR REPLACE TABLE ... OPTIONS(expiration_timestamp =
TIMESTAMP_MILLIS(...)) AS <compiled>` sets the same backstop inline, in
the one query job that would've run anyway — no second BigQuery API
shape introduced just for this path. Same 1-hour backstop and same
reasoning as `loadBigQueryStaged`'s: a GAS execution-timeout kill doesn't
guarantee the `finally` block below ever runs, so `expiration_timestamp`
is a durable, BigQuery-side backstop, not a substitute for the explicit
cleanup.

**`finally` only removes the staging table if it was actually created.**
Unlike `loadBigQueryStaged` (whose `Tables.insert` happens *before* its
`try` starts, so by the time `finally` runs the table is guaranteed to
exist), `modelTableStaged()`'s staging table is created *inside* the
`try` — the `CREATE OR REPLACE TABLE ... AS <compiled>` query is itself
the first thing that can fail. A `stagingCreated` flag, set true only
after that query succeeds, gates the `finally`'s `BigQuery.Tables.remove`
call — without it, a failure in the staging query itself would make
`finally` try to remove a table that never existed, throwing a spurious
"not found" that masks the real error.

**The `staged: { table: stagingTable }` field on this function's return
value went unread by `cli.js`'s own manifest summarizer until a
2026-08-11 code-review fix.** `summarizeNodeResult()` (`src/cli.js`)
copied `relation`/`materialized`/`testResults` off a successful result but
never checked for `staged`, so a table-model-with-tests run's manifest
entry silently dropped the one field unique to this path — low real
impact, since the staging table itself is already gone (removed in the
`finally` block above) by the time a manifest gets written, but any future
consumer trusting the manifest to fully describe what happened wouldn't
have seen that this run went through the staged path at all. Fixed with
one more `if` in `summarizeNodeResult()`, the same independent-`if`
pattern every other optional field there already uses - see
`docs/cli.md`'s run-manifest section for the user-facing version.

## set()/var() macros (2026-08-09)

The pairing predicted in the "Deferred to v2" note below (now moved out of
it): `{{ set(key='value', ...) }}` defines one or more named string values
scoped to *that one model's own SQL*; `{{ var('key') }}` reads one back.
Deliberately file-local, not a project-wide `vars` dict on the registry —
raised and explicitly decided in the design conversation this PR came
from, choosing the smaller-scoped option over adding a `notsobigdataModels.
vars` registry key. A project-wide `vars` dict is real dbt behavior and
was considered, but `set()` would then have no obvious job (a per-model
override of a project var, maybe, but that's a second design question
riding along with the first) — file-local keeps this PR to one clear
feature: avoid repeating the same literal twice in one query, nothing
more.

Two new pieces, following the exact scan/dispatch pattern `config()`
established:

- `extractSetValues(sql)` — the single source of truth for "what did
  `set()` define," called both by `validateSetVarUsage()` at discovery and
  by `compileModelSql()` at run time (computed once per compile call, not
  once per `var()` match — cheap, and avoids re-scanning the same SQL N
  times for N `var()` references). Scans `stripSqlComments()`'s output,
  same as every other extractor here.
- `validateSetVarUsage(sql, messagePrefix)` — the discovery-time check:
  every `var()` in the file must resolve against `extractSetValues()`'s
  map. Called from `expandModelNodes()`'s existing per-model try/catch
  (same spot `validateModelTests()` already sits), so a bad reference
  becomes that model's own `discoveryError`, caught by `cli('list')` —
  same posture every other model misconfiguration already gets.

**Multiple `set()` calls are allowed, unlike `config()`'s "at most one."**
`config()` rejects a second call outright because its one key
(`materialized`) has no obvious two-call precedence. `set()` is different
in kind — it's meant to define several independently-named values, and
cramming all of them into one call's argument list would be an awkward
fit once a model needs more than one or two. What's still rejected is the
same *name* being set twice (one call or two) — that has the identical
"no obvious precedence" problem `config()`'s rule exists to avoid, so
`extractSetValues()` throws on it exactly like `parseKwargsArgument()`
already throws on a duplicate key within one call.

**`var()` substitutes raw, unquoted text — no type system.** Same
posture `ref()`'s relation substitution already has: it's string
interpolation into SQL, not evaluation. A caller wanting a SQL string
literal has to put the quotes in the `set()` value itself
(`set(status="'active'")`) or wrap the `{{ var() }}` call in quotes in
their own SQL. No attempt was made to infer type from the literal's shape
(numeric-looking vs not) — that would be guessing at intent for a
questionable ergonomics win, and diverges from every other value in this
file being deliberately string-only (`parseKwargsArgument`'s existing
comment on this).

**Inherited the same "raw sql includes comments" quirk `ref()`/`config()`
already had**, not a new one this feature introduced:
`compileModelSql()` ran its single `.replace()` pass over the *raw* SQL
(comments included), so a `set()`/`var()` call sitting inside a `--`/`/*
*/` comment still got matched and processed by that pass even though
`extractSetValues()`'s discovery-time scan (which uses
`stripSqlComments()`) never saw it as a legitimate definition. Concretely:
a commented-out `set()` never defined a value discovery would validate
against, but if that same commented-out text also matched the `set`/`var`
call shape, `compileModelSql()`'s pass still stripped/substituted it inside
the comment (harmless — the result stayed inside the comment in the
compiled SQL) unless it was a `var()` whose name was never legitimately
`set()` elsewhere, which threw. `ref()` had this exact same inconsistency
(a commented-out `ref()` to a deleted model could still throw at compile
time even though it created no dependency edge). **Fixed generically for
all four calls (`ref()`/`config()`/`var()`/`{% set %}`/bare `{{ key }}`)
in release/12 — see "compileModelSql() now treats a SQL comment as inert"
below.**

## set()/var() corrected to match real dbt/Jinja (2026-08-09)

The pairing above was a mistake, caught before this merged past `release/11`
into `main` — corrected here rather than left to accumulate as "the way this
library does it, differently from dbt for no real reason." Real dbt/Jinja
has no `{{ set(...) }}`/`{{ var(...) }}` pair at all: `{% set key = 'value' %}`
is a Jinja *statement*, referenced later as bare `{{ key }}`, not through a
`var()` call — and dbt's own `var()` is a completely unrelated feature, reading
a project-level value from `dbt_project.yml`'s `vars:` section (or `--vars`
on the CLI), with no connection to `{% set %}` whatsoever. The previous
design borrowed dbt's names but invented its own semantics (`var()` reading
back whatever `set()` had just defined) to fit the single-token
`{{ name(args) }}` call shape every other macro here already used — which
seemed like a reasonable adaptation at the time (see the note above:
`{% set %}` was called "a block construct, out of scope" and folded into
the call-shaped scanner instead) but produces exactly the wrong intuition
for anyone who already knows dbt: a `{{ var('x') }}` in this library used to
mean something dbt users would never guess.

**What changed:**

- `{{ set(key='value') }}` → `{% set key = 'value' %}`, matched by its own
  `setStatementPattern()` (a *different* bracket shape, `{% %}` not `{{ }}`,
  so it can never collide with `templateExpressionPattern()`'s call-shaped
  regex). Turns out this didn't need the "real block constructs need a
  tokenizer" machinery the earlier note worried about — `{% set %}` is a
  single-line *statement*, not a multi-line block like `{% if %}...{% endif %}`,
  so a second regex was enough. That distinction (statement vs. block) is
  the reason `{% set %}` could be fixed now while `for`/`if` stay deferred —
  see "Deferred to v2" below.
- The value it defines is read back as a bare `{{ key }}` — a new
  `bareVarPattern()` (`{{ identifier }}`, no parens, so it can't collide
  with the call-shaped regex either) substituted in `compileModelSql()`'s
  third pass.
- `var()` now reads `notsobigdataModels.vars` (a new flat, string-only dict
  on the registry — the "project-wide vars dict" the original note above
  explicitly considered and rejected, now added because `var()` needs it to
  mean what it means in real dbt), with an optional second positional
  argument as a default (`var('region', 'US')`) via `parseVarArguments()`,
  resolved by `resolveVar()`.

**New pieces**, replacing the old `extractSetValues()`/`validateSetVarUsage()`:

- `extractSetStatements(sql)` — scans for `{% set key = 'value' %}` (via
  `setStatementPattern()`, over `stripSqlComments()`'s output, same as
  every other extractor here), duplicate-name detection inline (same
  "no obvious precedence" rejection the old `extractSetValues()` had).
- `validateSetUsage(sql, messagePrefix)` — discovery-time: every bare
  `{{ key }}` must resolve against `extractSetStatements()`'s map.
- `resolveVar(registry, name, hasDefault, defaultValue)` — the one
  resolution rule both `validateVarUsage()` (discovery) and
  `compileModelSql()`'s `var()` dispatch (run time) share.
- `validateVarUsage(matches, registry, messagePrefix)` — discovery-time:
  duplicates `resolveVar()`'s check rather than calling it, so it can embed
  `messagePrefix` the same way every other discovery-time `validate*`
  function here does (`resolveVar()` itself has no model-name context to
  embed, since it's also called from `compileModelSql()` at run time).
  Takes `matches` (already scanned off `stripSqlComments()`'s output), not
  raw `sql`, same as `extractRefDependencies()`/`extractConfigOverrides()`
  below - see the "one scan, not three" note there.

**Breaking change, not a migration path.** Any model already using
`{{ set(key='value') }}`/`{{ var('key') }}` (there shouldn't be any past
this feature branch — it landed in `release/11` via PR #40 and never reached
`main`) needs rewriting to the new syntax; the old call shape is now just an
unrecognized `{{ }}` call, caught the same way any other unknown call is
(at compile time, via `compileModelSql()`'s "unsupported template call"
throw — not at discovery, since discovery only validates *known* call
names). No backwards-compat shim was added, per this repo's
no-compat-hack posture — CLAUDE.md's stated instructions this project runs
under, not something to weaken for one already-shipped-but-not-yet-released
feature.

Every prior claim in the note above about `{{ set(...) }}`/`{{ var(...) }}`
(the multiple-`set()`-calls-allowed rule, the "raw text, no type coercion"
posture) still holds for the new `{% set %}`/`{{ key }}`/`var()` shapes —
only the *syntax* changed, not those underlying design decisions. The
"raw sql includes comments" quirk itself no longer holds as of release/12 —
see below.

## compileModelSql() now treats a SQL comment as inert (2026-08-11)

The quirk both notes above flagged as "worth fixing generically... if it
ever bites someone for real" did: code review on the whole repo (ahead of
`release/12`) surfaced the concrete failure mode directly — a commented-out
`-- {{ var('region') }}` where `region` has no default and isn't set in
`notsobigdataModels.vars` passed `cli('list')` clean (discovery scans
`stripSqlComments()`'s output) but threw at `cli('run')`/`cli('compile')`
time, since `compileModelSql()` scanned the raw, un-stripped SQL. Same
class of surprise for a commented-out `ref()` to a deleted model.

**Fix:** two new helpers, `commentSpans(text)` and `isCommentedOut(spans,
offset)`, sitting right above `compileModelSql()`. `commentSpans()` finds
every `--`/`/* */` span in a string (same two regexes `stripSqlComments()`
uses, just collecting positions instead of stripping); `isCommentedOut()`
checks whether a given match offset falls inside one. Each of
`compileModelSql()`'s three `.replace()` passes (the `ref()`/`config()`/
`var()` dispatch, the `{% set %}` strip, the bare `{{ key }}` resolve) now
takes the match's `offset` argument (the 4th/3rd param `String#replace()`'s
callback already receives, previously unused) and returns the match
unchanged — not substituted, not thrown on — when it falls inside a
comment.

**Why this can't just reuse `stripSqlComments()` directly**, unlike
discovery's checks: discovery only needs to *decide* whether a call counts
(ignore-if-commented is enough), but `compileModelSql()` has to *emit* the
comment text unchanged in the compiled SQL — a real, non-macro SQL comment
is legitimate output, not something to strip. Hence spans (positions to
skip), not a stripped string to scan instead.

**Offset drift across the three passes:** spans are recomputed fresh
before each pass, against whatever the string currently is at that point
(`sql` for the first pass, then `compiled` twice more) — not computed once
against the original `sql` and reused. A commented-out match is always
returned byte-for-byte unchanged, so a comment's own delimiter text is
never touched by an earlier pass; only the *length* of the surrounding
string changes (from real substitutions outside comments), so recomputing
spans against the current string is both necessary (offsets from the
original `sql` would be stale) and sufficient (the comment syntax to
re-find is still there, verbatim).

**The final "stray `{{`/`{%`" guard needed the same treatment.** It used
to be a plain `compiled.indexOf('{{') !== -1` check — after this fix, a
deliberately-untouched commented-out call leaves exactly that text behind
on purpose, so the check now walks every `{{`/`{%` occurrence and only
throws if one falls outside every comment span, same `isCommentedOut()`
helper reused a third time.

**Known remaining limitation, not attempted here:** `commentSpans()`,
like `stripSqlComments()` it mirrors, is not string-literal-aware — a `--`
or `/*` appearing inside a quoted SQL string literal earlier on the same
line is still misread as starting a real comment. That was already true
of every discovery-time check built on `stripSqlComments()`; this fix
matches that existing posture rather than introducing a more sophisticated
parser for only the compile-time path. Worth a real tokenizer if it ever
bites someone for real, same "not attempted here" reasoning the original
quirk note gave.

## `relationships.to` validated against declared models at discovery (2026-08-11)

Same code-review pass that surfaced the comment-inertness bug above also
caught this: a `relationships` test's `to` naming a real node that wasn't
a model (most plausibly a `move` node — a name `{{ ref() }}` elsewhere in
the same project can legally target) passed `cli('list')` clean, since
`assertDependenciesExist()` (cli.js) only checks that `to` names *some*
declared node, kind-agnostic by design. The mismatch only surfaced once
`compileModelTests()`'s `resolveModelConfig(test.to, registry)` call ran
inside `model()` at run time — by then, for a `view` model `CREATE OR
REPLACE VIEW` had already materialized the relation, and for a staged
`table` model, `modelTableStaged()` had already created its staging
table. See the "Tests" section above (now updated) for the fuller
before/after — this was flagged there at the time as an intentional
choice ("isn't specially handled either"), which turned out to be wrong:
`docs/model.md` already promised `to` must be "another declared model's
name," so the code just hadn't been made to agree with its own docs yet.

**Fix:** `validateModelTest()` (and `validateModelTests()`, which calls
it once per test) now take `registry` as a third argument, threaded
through from `expandModelNodes()`'s own already-in-scope `registry` at
its one call site. For a `relationships` check, after confirming `to` is
a non-empty string, it now also checks `has(registry.models, test.to)` —
the same existence check `resolveModelConfig()` already makes at run
time, just moved earlier, with the same "Known models: ..." message shape
`resolveModelConfig()`'s own throw already uses. A `to` naming a
completely made-up name (not any node at all) already threw at discovery
before this fix, via `assertDependenciesExist()` — this only closes the
gap for a `to` naming a *real* node of the wrong kind.

## Deferred to v2

Incremental materialization, column-level tests beyond dbt's four
built-in generic checks (e.g. a `dbt_utils`-style `expression_is_true`);
`for`/`if` are a materially bigger undertaking than `ref()`/`config()`/
`var()`/`{% set %}` (real *block* constructs, not a single-token call or a
single-line statement - the current scanner can't be extended into them,
it'd need a real tokenizer for the `{% ... %}...{% end... %}` span) and
`for` would also need a design decision about what a loop iterates over.
