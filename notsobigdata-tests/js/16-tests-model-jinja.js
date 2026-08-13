// 16-tests-model-jinja.js — model-jinja test category (see PROJECT.md; runAllTests('model-jinja')).


// tmpNotAModel has no "target" at all - ref() now also resolves a
// bigquery-target move node (see the three tests below this one), so this
// specifically covers "a real move node, but not one ref() can reach":
// no target means no queryable relation to substitute.
function testModelRefToNonModelNodeThrows() {
  withTemporaryNodes({
    tmpNotAModel: { kind: 'move', name: 'tmpNotAModel', source: { type: 'custom', fn: myCustomExtract } },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpRefsMoveNode: { sqlFile: 'html/model_ref_to_move_node.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpRefsMoveNode');
    check('ref() to a real move node with no queryable relation throws, not a silent pass-through',
      message.indexOf('does not match a declared model or a move node with a bigquery target') !== -1, message);
  });
}


// ref() resolving a move node's bigquery target directly (no hand-written
// dependsOn needed) - see docs/model.md's "Depending on a move node" and
// src/model.md's "ref() resolving a move node's bigquery target" design
// note. materialized: 'table' forces CREATE OR REPLACE TABLE ... AS
// SELECT to actually execute against the substituted relation - a view
// wouldn't prove the substitution resolved to a real table until queried.
function testModelRefResolvesMoveNodeBigQueryTarget() {
  withTemporaryNodes({
    tmpLoadForRef: {
      kind: 'move', name: 'tmpLoadForRef',
      source: { type: 'custom', fn: myCustomExtract },
      target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_REF_TEST_TABLE, mode: 'overwrite' }
    },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpRefsBigQueryMoveNode: { sqlFile: 'html/model_ref_to_bigquery_move_node.html', materialized: 'table' } }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpLoadForRef,tmpRefsBigQueryMoveNode');
    check('ref() to a bigquery-target move node runs with no hand-written dependsOn', report.ok, JSON.stringify(report.nodes));

    var order = report.nodes.map(function (n) { return n.name; });
    check('the move node runs before the model that ref()s it, purely from the derived edge',
      order.indexOf('tmpLoadForRef') < order.indexOf('tmpRefsBigQueryMoveNode'), order.join(', '));

    var byName = {};
    report.nodes.forEach(function (n) { byName[n.name] = n; });
    check('the model materialized as a table, proving the ref() substitution resolved to a real, queryable relation',
      byName.tmpRefsBigQueryMoveNode && byName.tmpRefsBigQueryMoveNode.result.materialized === 'table',
      JSON.stringify(byName.tmpRefsBigQueryMoveNode));
  });
}


// Same shape as testModelRefToNonModelNodeThrows above, but the move node
// this time genuinely has a target - just not a bigquery one - so this
// specifically covers "declared, but not the kind of target ref() can
// reach" rather than "no target at all".
function testModelRefToNonBigQueryMoveTargetFailsAtList() {
  withTemporaryNodes({
    tmpLoadToSheetForRef: {
      kind: 'move', name: 'tmpLoadToSheetForRef',
      source: { type: 'custom', fn: myCustomExtract },
      target: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, sheetName: 'PipelineReport', mode: 'overwrite' }
    },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpRefsSheetsMoveNode: { sqlFile: 'html/model_ref_to_non_bigquery_move_node.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpRefsSheetsMoveNode'; })[0];
    check('ref() naming a real move node whose target is not bigquery fails at a dry "list" run, not mid cli("run")',
      !!node && node.status === 'failed' && node.error.indexOf('does not match a declared model or a move node with a bigquery target') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


function testModelUnsupportedTemplateCallThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpUnsupportedMacro: { sqlFile: 'html/model_unsupported_call.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpUnsupportedMacro');
    check('a template call other than ref() throws instead of passing through',
      message.indexOf('unsupported template call') !== -1, message);
  });
}


// Regression coverage for a gap an independent security review's own
// verification surfaced during this PR: the {{ ... }} scanner originally
// only matched calls shaped like ref() (one quoted-string argument), so a
// kwarg-style call like this one - which doesn't fit that shape at all -
// never matched the scanner's regex and silently passed through as
// literal text instead of being rejected. Fixed by matching the call
// *shape* generically first, then validating ref()'s stricter argument
// shape only once a call is already known to be ref().
function testModelKwargStyleCallThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpKwargCall: { sqlFile: 'html/model_kwarg_call.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpKwargCall');
    check('a kwarg-style call is rejected, not silently passed through',
      message.indexOf('unsupported template call') !== -1, message);
  });
}


// {{ config(...) }} coverage: an inline config() call overrides the
// registry, an unsupported key is rejected at discovery (cli('list')
// would catch it too, not just a real run), and a second config() call
// is rejected rather than guessing which one should win.
function testModelConfigMacroOverridesMaterialized() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpConfigMaterialized: { sqlFile: 'html/model_config_materialized.html' } }
    }
  }, function () {
    var result = runOne('tmpConfigMaterialized');
    check('{{ config(materialized=\'table\') }} overrides the registry default (view)',
      result.materialized === 'table', result.materialized);
  });
}


function testModelConfigUnknownKeyThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpConfigUnknownKey: { sqlFile: 'html/model_config_unknown_key.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpConfigUnknownKey');
    check('config() with an unsupported key throws instead of being silently ignored',
      message.indexOf('is not a supported key') !== -1, message);
  });
}


function testModelConfigTwoCallsThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpConfigTwoCalls: { sqlFile: 'html/model_config_two_calls.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpConfigTwoCalls');
    check('more than one config() call in a model throws instead of guessing precedence',
      message.indexOf('at most one is allowed per model') !== -1, message);
  });
}


// {% set %} coverage: a value defined once and reused twice in the same
// model's SQL as a bare {{ key }} (a WHERE and a HAVING, mirroring
// docs/model.md's own example) compiles and runs successfully - proving
// both references resolve to the same substituted literal without
// breaking BigQuery's own parser. Real Jinja statement syntax, corrected
// from the original {{ set(...) }}/{{ var(...) }} call-shaped pairing -
// see src/model.md's "set()/var() corrected to match real dbt/Jinja" note.
function testModelSetVarDryUsage() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpSetVarDry: { sqlFile: 'html/model_set_var_dry.html' } }
    }
  }, function () {
    var result = runOne('tmpSetVarDry');
    check('a model reusing one {% set %} value via two bare {{ key }} references runs successfully',
      !!result.relation, JSON.stringify(result));
  });
}


function testModelSetUndefinedThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpSetVarUndefined: { sqlFile: 'html/model_set_var_undefined.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpSetVarUndefined');
    check('a bare {{ key }} referencing a name never {% set %} throws at discovery, not just at run time',
      message.indexOf('never set via') !== -1, message);
  });
}


function testModelSetDuplicateKeyThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpSetDuplicateKey: { sqlFile: 'html/model_set_var_duplicate_key.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpSetDuplicateKey');
    check('the same {% set %} key defined twice throws instead of guessing precedence',
      message.indexOf('is set by more than one') !== -1, message);
  });
}


// {{ var(...) }} coverage: real dbt semantics, reading notsobigdataModels.vars
// (a project-level dict) rather than a value {% set %} defined - see
// src/model.md's "set()/var() corrected to match real dbt/Jinja" note for
// why these two used to be (wrongly) paired.
function testModelVarMissingNoDefaultThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpVarMissing: { sqlFile: 'html/model_var_missing.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpVarMissing');
    check('{{ var(...) }} with no default, missing from notsobigdataModels.vars, throws at discovery',
      message.indexOf('not set in notsobigdataModels.vars') !== -1, message);
  });
}


function testModelVarResolvesFromRegistryAndDefault() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      vars: { region: 'US' },
      models: { tmpVarProjectLevel: { sqlFile: 'html/model_var_project_level.html' } }
    }
  }, function () {
    var result = runOne('tmpVarProjectLevel');
    check('{{ var(...) }} resolves from notsobigdataModels.vars, and falls back to its own default when missing',
      !!result.relation, JSON.stringify(result));
  });
}


// Regression coverage for the "{{ }} inside a SQL comment must be inert at
// compile time too" fix (src/model.md's "compileModelSql() now treats a
// SQL comment as inert" note). model_var_commented_out.html reuses
// model_var_missing.html's exact "no default, not in notsobigdataModels.vars"
// combination (see testModelVarMissingNoDefaultThrows above, which throws
// for the uncommented version) - the only difference is the "-- " prefix,
// isolating this test to exactly what the fix changed. Before the fix,
// this passed cli('list') clean (discovery scans comment-stripped SQL) but
// threw at cli('run') time, since compileModelSql() scanned the raw SQL.
function testModelVarCommentedOutIsInert() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpVarCommentedOut: { sqlFile: 'html/model_var_commented_out.html' } }
    }
  }, function () {
    var result = runOne('tmpVarCommentedOut');
    check('a commented-out {{ var(...) }} with no default and no vars entry does not throw at run time',
      !!result.relation, JSON.stringify(result));
  });
}


// {% for %} coverage: a literal-list loop expands into one repeated
// pivot-style column per item and still runs successfully - self-contained
// (an inline UNION ALL, no shared test_orders table), same reasoning
// model_set_var_dry.html already gives for its own self-contained data.
// The two failure fixtures below cover expandForLoops()'s own discovery-
// time checks - nesting and an unterminated block - both reported by a dry
// "list" run, same "FailsAtList" convention every other model discovery
// error already uses (see the block comment above testModelMultipleSqlTagsWithoutIdsFailsAtList).
function testModelForLoopExpandsAndRuns() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpForLoop: { sqlFile: 'html/model_for_loop.html' } }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpForLoop');
    check('a {% for %} pivot-style model runs ok', report.ok, JSON.stringify(report.nodes));
    var rows = report.nodes[0].result;
    check('{% for %} produced a materialized relation', !!rows.relation, JSON.stringify(rows));
  });
}


// Regression coverage for the "{% for %} list parsing breaks on a comma
// inside a quoted item" fix (src/model.md's "parseForIterable()'s comma
// split fixed for quoted commas" note). Before this fix,
// ['open, pending', 'closed'] threw "is not valid" at discovery, since
// parseForIterable() split on every comma before checking item shape,
// cutting 'open, pending' into two invalid fragments. The loop variable
// is deliberately used only inside a string literal (a case-when
// comparison), not in an identifier position - a real category label with
// a comma in it (e.g. "open, pending review") could never be used as a
// SQL identifier suffix anyway, so this matches how the bug actually
// shows up in practice.
function testModelForLoopCommaInsideQuotedItemRuns() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpForLoopCommaItem: { sqlFile: 'html/model_for_loop_comma_in_item.html' } }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpForLoopCommaItem');
    check('a {% for %} list with a comma inside one quoted item runs ok, not "is not valid"',
      report.ok, JSON.stringify(report.nodes));
  });
}


function testModelForLoopNestedFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpForLoopNested: { sqlFile: 'html/model_for_loop_nested.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpForLoopNested'; })[0];
    check('a {% for %} nested inside another {% for %} is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('nesting is not supported') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


function testModelForLoopUnterminatedFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpForLoopUnterminated: { sqlFile: 'html/model_for_loop_unterminated.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpForLoopUnterminated'; })[0];
    check('a {% for %} with no matching {% endfor %} is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('no matching "{% endfor %}"') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


// {% macro %} coverage: user-authored macros declared in files listed on
// notsobigdataModels.macros - macros.html holds two, cents_to_dollars(column)
// (self-contained) and enrich_with_region(column) (whose body contains its
// own {{ ref('tmpMacroCustomers') }} - proving a ref() living inside a
// macro's body becomes a real dependency edge for whichever model calls
// it, with nothing hand-written). model_macro_call.html is self-contained
// (an inline literal, no shared table), same reasoning every other
// model-jinja fixture already gives for its own data.
function testModelMacroExpandsAndPropagatesRefDependency() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      macros: ['html/macros.html'],
      models: {
        tmpMacroCustomers: { sqlFile: 'html/model_tests_customers.html' },
        tmpMacroOrders: { sqlFile: 'html/model_macro_call.html' }
      }
    },
    tmpReadMacroOrders: {
      kind: 'move', name: 'tmpReadMacroOrders', dependsOn: ['tmpMacroOrders'],
      source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: 'tmpMacroOrders' }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpMacroCustomers,tmpMacroOrders,tmpReadMacroOrders');
    check('macro-using model pipeline reports ok', report.ok, JSON.stringify(report.nodes));

    var order = report.nodes.map(function (n) { return n.name; });
    check('a {{ ref(...) }} living inside a macro body becomes a real dependency edge - tmpMacroCustomers runs before tmpMacroOrders',
      order.indexOf('tmpMacroCustomers') < order.indexOf('tmpMacroOrders'), order.join(', '));

    var byName = {};
    report.nodes.forEach(function (n) { byName[n.name] = n; });
    var rows = byName.tmpReadMacroOrders.result;
    var row1 = rows.slice(1).filter(function (row) { return String(row[0]) === '1'; })[0];
    check('cents_to_dollars() macro computed amount_usd correctly', !!row1 && String(row1[1]) === '2.5', JSON.stringify(rows));
    check('enrich_with_region() macro (with a ref() inside it) resolved the customer name', !!row1 && row1[2] === 'alice', JSON.stringify(rows));
  });
}


function testModelMacroUnknownNameThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      macros: ['html/macros.html'],
      models: { tmpMacroUnknownName: { sqlFile: 'html/model_macro_unknown_name.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpMacroUnknownName');
    check('calling a name that is neither a built-in call nor a declared macro throws, mentioning notsobigdataModels.macros',
      message.indexOf('unsupported template call') !== -1 && message.indexOf('notsobigdataModels.macros') !== -1, message);
  });
}


function testModelMacroArgCountMismatchFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      macros: ['html/macros.html'],
      models: { tmpMacroArgMismatch: { sqlFile: 'html/model_macro_arg_mismatch.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpMacroArgMismatch'; })[0];
    check('calling a macro with the wrong number of arguments is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('takes 1 argument') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


// The three tests below are all project-wide macro-file problems, not any
// one model's own mistake - readMacroDefinitions() is deliberately called
// unguarded at the top of expandModelNodes() (see src/model.md's "Where a
// bad macro fails" note), so these throw straight out of cli('list')
// itself, same as testModelMalformedRegistryThrows above, rather than
// showing up as one node's own "failed" status.

function testModelMacroCallingMacroThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      macros: ['html/macro_calls_macro.html'],
      models: { tmpMacroNesting: { sqlFile: 'stg_orders.html' } }
    }
  }, function () {
    var threw = null;
    try {
      NotSoBigData.cli('list');
    } catch (e) {
      threw = e;
    }
    check('a macro whose own body calls another macro throws - macro-to-macro calls are not supported',
      !!threw && threw.message.indexOf('macro-to-macro calls are not supported') !== -1, threw ? threw.message : 'did not throw');
  });
}


function testModelMacroCrossFileNameCollisionThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      macros: ['html/macros.html', 'html/macro_duplicate_name.html'],
      models: { tmpMacroCollision: { sqlFile: 'stg_orders.html' } }
    }
  }, function () {
    var threw = null;
    try {
      NotSoBigData.cli('list');
    } catch (e) {
      threw = e;
    }
    check('a macro name declared in more than one file listed in notsobigdataModels.macros throws',
      !!threw && threw.message.indexOf('declared in more than one file') !== -1, threw ? threw.message : 'did not throw');
  });
}


function testModelMacroUnterminatedThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      macros: ['html/macro_unterminated.html'],
      models: { tmpMacroUnterminated: { sqlFile: 'stg_orders.html' } }
    }
  }, function () {
    var threw = null;
    try {
      NotSoBigData.cli('list');
    } catch (e) {
      threw = e;
    }
    check('a {% macro %} with no matching {% endmacro %} throws',
      !!threw && threw.message.indexOf('no matching "{% endmacro %}"') !== -1, threw ? threw.message : 'did not throw');
  });
}
