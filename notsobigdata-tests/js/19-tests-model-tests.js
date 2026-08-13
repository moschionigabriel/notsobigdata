// 19-tests-model-tests.js — model-tests test category (see PROJECT.md; runAllTests('model-tests')).


// The seven tests below cover model()'s tests feature (dbt-style generic
// tests + custom SQL, see docs/model.md's "Tests" section). Two fixture
// files back most of them: model_tests_customers.html (a clean 2-row
// "parent" table) and model_tests_orders.html (a clean 3-row "child"
// table with no {{ ref() }} to model_tests_customers at all - so any
// ordering between them can only come from a relationships test's "to",
// isolating that dependency-derivation path from {{ ref() }}'s own).
// model_tests_orders_with_violations.html is the same shape but crafted
// to fail all four generic checks at once (a duplicate order_id, a null
// customer_id, an out-of-list status, and a customer_id absent from
// model_tests_customers).

function testModelTestsPassAndRelationshipsOrdersCorrectly() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpTestsCustomers: { sqlFile: 'html/model_tests_customers.html' },
        tmpTestsOrders: {
          sqlFile: 'html/model_tests_orders.html',
          tests: [
            { column: 'customer_id', check: 'not_null' },
            { column: 'order_id', check: 'unique' },
            { column: 'status', check: 'accepted_values', values: ['open', 'closed'] },
            { column: 'customer_id', check: 'relationships', to: 'tmpTestsCustomers' },
            { name: 'no_negative_order_ids', query: 'SELECT * FROM {{ this }} WHERE order_id < 0' }
          ]
        }
      }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpTestsCustomers,tmpTestsOrders');
    check('customers + orders pipeline reports ok', report.ok, JSON.stringify(report.nodes));

    var order = report.nodes.map(function (n) { return n.name; });
    check('a relationships test\'s "to" orders its model after the one it checks against, with no {{ ref() }} involved',
      order.indexOf('tmpTestsCustomers') < order.indexOf('tmpTestsOrders'), order.join(', '));

    var ordersNode = report.nodes.filter(function (n) { return n.name === 'tmpTestsOrders'; })[0];
    check('every declared test ran and the model still reports success', ordersNode.result.testResults.ran === 5,
      JSON.stringify(ordersNode.result));
  });
}


function testModelGenericTestsFailCollectAllViolations() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpViolationsCustomers: { sqlFile: 'html/model_tests_customers.html' },
        tmpViolationsOrders: {
          sqlFile: 'html/model_tests_orders_with_violations.html',
          tests: [
            { column: 'customer_id', check: 'not_null' },
            { column: 'order_id', check: 'unique' },
            { column: 'status', check: 'accepted_values', values: ['open', 'closed'] },
            { column: 'customer_id', check: 'relationships', to: 'tmpViolationsCustomers' }
          ]
        }
      }
    }
  }, function () {
    // tmpViolationsCustomers must actually materialize first - the
    // relationships check's subquery runs against its real relation, and
    // running only tmpViolationsOrders would fail that one check with a
    // "table not found" BigQuery error instead of the intended
    // offending-rows failure, which would also abort runSqlTests()
    // before the other three checks in this list get a chance to run.
    var report = NotSoBigData.cli('run --select tmpViolationsCustomers,tmpViolationsOrders');
    var ordersNode = report.nodes.filter(function (n) { return n.name === 'tmpViolationsOrders'; })[0];
    check('the model with four violating rows reports failed', !!ordersNode && ordersNode.status === 'failed',
      ordersNode ? JSON.stringify(ordersNode) : 'node missing from report');
    ['not_null_customer_id', 'unique_order_id', 'accepted_values_status', 'relationships_customer_id_to_tmpViolationsCustomers']
      .forEach(function (name) {
        check('failure message names "' + name + '"', ordersNode.error.indexOf(name) !== -1, ordersNode.error);
      });
  });
}


function testModelCustomQueryTestFails() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpCustomTestFails: {
          sqlFile: 'html/model_tests_orders.html',
          tests: [{ name: 'always_fails_probe', query: 'SELECT * FROM {{ this }} WHERE 1 = 1' }]
        }
      }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpCustomTestFails');
    check('failure message names the custom test', error.indexOf('always_fails_probe') !== -1, error);
  });
}


function testModelTestsBothCheckAndQueryFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpBothCheckAndQuery: { sqlFile: 'stg_orders.html', tests: [{ check: 'not_null', column: 'x', query: 'select 1' }] } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpBothCheckAndQuery'; })[0];
    check('a tests[] entry setting both check and query is reported failed by a dry "list" run, not thrown for the whole project',
      !!node && node.status === 'failed' && node.error.indexOf('exactly one of') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


function testModelTestsAcceptedValuesEmptyValuesFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpEmptyAcceptedValues: { sqlFile: 'stg_orders.html', tests: [{ check: 'accepted_values', column: 'x', values: [] }] } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpEmptyAcceptedValues'; })[0];
    check('an accepted_values test with an empty "values" array is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('non-empty array') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


function testModelTestsRelationshipsUnknownToThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpRelationshipsUnknownTo: {
          sqlFile: 'html/model_tests_orders.html',
          tests: [{ column: 'customer_id', check: 'relationships', to: 'tmpNoSuchModel' }]
        }
      }
    }
  }, function () {
    var threw = null;
    try {
      NotSoBigData.cli('list');
    } catch (e) {
      threw = e;
    }
    check('a relationships test naming an undeclared model throws cli()\'s own dangling-dependency error',
      !!threw && threw.message.indexOf('tmpNoSuchModel') !== -1, threw ? threw.message : 'did not throw');
  });
}


// Regression coverage for validateModelTest() now checking a relationships
// test's "to" against notsobigdataModels.models, not just "does this name
// any node" (see src/model.md's "relationships.to validated against
// declared models at discovery" note). Deliberately different from
// testModelTestsRelationshipsUnknownToThrows above: "to" here names a
// *real* node (a move node), so assertDependenciesExist()'s own
// dangling-edge check (which fires for a name that isn't any node at all,
// and throws for the whole cli('list') call rather than just this one
// node) never gets a chance to catch it - before this fix, that meant the
// model materialized in a real cli('run') before resolveModelConfig()
// threw partway through compiling its tests.
function testModelTestsRelationshipsToNonModelNodeFailsAtList() {
  withTemporaryNodes({
    tmpNotAModelForRelationships: { kind: 'move', name: 'tmpNotAModelForRelationships', source: { type: 'custom', fn: myCustomExtract } },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpRelationshipsToMoveNode: {
          sqlFile: 'html/model_tests_orders.html',
          tests: [{ column: 'customer_id', check: 'relationships', to: 'tmpNotAModelForRelationships' }]
        }
      }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpRelationshipsToMoveNode'; })[0];
    check('a relationships test\'s "to" naming a real move node (not a model) is reported failed by a dry "list" run, not mid cli("run")',
      !!node && node.status === 'failed' && node.error.indexOf('is not a declared model') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


// The two tests below exercise modelTableStaged() specifically -
// materialized: 'table' with tests declared, the one combination none of
// the model-tests fixtures above hit (they're all the default "view"
// materialization). Reused fixture SQL files, same as above; the point
// here is the materialized: 'table' override, not new SQL shapes.
//
// Neither test queries BigQuery directly to confirm the staging table
// was cleaned up or (on the failure case) that the real relation was
// never touched - this harness has no precedent for a raw BigQuery.Tables/
// Jobs.query call, every other test asserts only through cli()'s own
// report. That deeper check - no _notsobigdata_stage_* table left behind
// in the dataset, and the real relation absent/unchanged after a failed
// run - is a manual BigQuery-console step, called out in this PR's
// description.

// Also covers the "include modelTableStaged()'s staged field in the
// manifest" fix (src/model.md/src/cli.md's 2026-08-11 notes on
// summarizeNodeResult()) - result.staged existing on the raw node result
// was already proven below; the manifest-content check added here proves
// summarizeNodeResult() actually copies it into the written manifest
// file too, which used to be silently dropped.
function testModelTableStagedTestsPassPromotesRelation() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpStagedTablePass: {
          sqlFile: 'html/model_tests_customers.html',
          materialized: 'table',
          tests: [{ column: 'customer_id', check: 'not_null' }]
        }
      }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpStagedTablePass');
    var result = report.nodes[0].result;
    check('a passing table model with tests reports materialized "table"', result.materialized === 'table', JSON.stringify(result));
    check('the staged path ran (result.staged names the scratch table it used)',
      !!result.staged && typeof result.staged.table === 'string' && result.staged.table.length > 0, JSON.stringify(result));
    check('the declared test ran and passed', !!result.testResults && result.testResults.ran === 1, JSON.stringify(result));

    check('the run manifest wrote successfully', report.manifest.written === true, JSON.stringify(report.manifest));
    var manifestContent = JSON.parse(DriveApp.getFileById(report.manifest.fileId).getBlob().getDataAsString());
    var manifestNode = manifestContent.nodes.filter(function (n) { return n.name === 'tmpStagedTablePass'; })[0];
    check('the manifest itself also carries the staged field, not just the raw node result',
      !!manifestNode && !!manifestNode.staged && manifestNode.staged.table === result.staged.table,
      JSON.stringify(manifestNode));
    DriveApp.getFileById(report.manifest.fileId).setTrashed(true);
  });
}


function testModelTableStagedTestsFailBlocksPromotion() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpStagedTableFail: {
          sqlFile: 'html/model_tests_orders_with_violations.html',
          materialized: 'table',
          tests: [{ column: 'customer_id', check: 'not_null' }]
        }
      }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpStagedTableFail');
    check('a failing table model\'s test names the check, same as the view-materialized case',
      error.indexOf('not_null') !== -1, error);
  });
}
