// 13-tests-bigquery.js — bigquery test category (see PROJECT.md; runAllTests('bigquery')).


// True once loadSqlTestReference has actually been run this execution -
// its target is mode: 'overwrite' with the same fixed 2 rows every time,
// so re-running it a second/third time in the same execution (e.g. all
// three sql-tests tests running together via runAllTests()) reloads
// identical content for no reason. Reset to false on every execution,
// same as every other top-level var in this file, since Apps Script
// re-evaluates top-level code on every single run - this does NOT make
// the three sql-tests tests depend on each other or on run order: each
// still calls this and still gets a correct reference table whether it
// runs alone or alongside the others, it just skips the redundant job
// when one already ran earlier in the same execution.
var sqlTestReferenceEnsured = false;

function ensureSqlTestReference() {
  if (!sqlTestReferenceEnsured) {
    runOne('loadSqlTestReference');
    sqlTestReferenceEnsured = true;
  }
}


function testExtractBigQueryTable() {
  testLog(runOne('extractBigQueryTable'));
}


function testExtractBigQueryQuery() {
  testLog(runOne('extractBigQueryQuery'));
}


function testExtractBigQueryQueryFile() {
  testLog(runOne('extractBigQueryQueryFile'));
}


// A bigquery source that isn't a read-only SELECT is rejected before it
// reaches BigQuery.
function testExtractBigQueryRejectsNonSelect() {
  withTemporaryNodes({
    tmpNonSelect: {
      kind: 'move', name: 'tmpNonSelect',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'INSERT INTO ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_TABLE + ' (customer) VALUES ("nope")'
      }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpNonSelect');
    check('a non-SELECT bigquery source is rejected', error.indexOf('read-only SELECT') !== -1, error);
  });
}


function testLoadBigQuery() {
  var appended = runOne('loadBigQueryAppend');
  testLog('appended into ' + P.BIGQUERY_LOAD_TABLE + ' via job ' + appended.loadResult.jobId);
  var overwritten = runOne('loadBigQueryOverwrite');
  testLog('overwrote ' + P.BIGQUERY_LOAD_TABLE + ' via job ' + overwritten.loadResult.jobId);

  withTemporaryNodes({
    tmpCountLoadTable: {
      kind: 'move', name: 'tmpCountLoadTable',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_LOAD_TABLE
      }
    }
  }, function () {
    var counted = runOne('tmpCountLoadTable');
    check('after overwrite the table holds just the source rows, not doubled',
      Number(counted[1][0]) === appended.length - 1,
      'table has ' + counted[1][0] + ' rows, source had ' + (appended.length - 1));
  });
}


function testLoadBigQuerySchema() {
  runOne('loadBigQuerySchema');
  withTemporaryNodes({
    tmpColumnType: {
      kind: 'move', name: 'tmpColumnType',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT data_type FROM ' + P.BIGQUERY_DATASET + '.INFORMATION_SCHEMA.COLUMNS WHERE table_name = "' + P.BIGQUERY_SCHEMA_TABLE + '" AND column_name = "order_id"'
      }
    }
  }, function () {
    var columnType = runOne('tmpColumnType');
    var actualType = columnType[1] && columnType[1][0];
    check('target.schema forced order_id to STRING',
      actualType === 'STRING',
      'got ' + actualType + ' (autodetect would have inferred INTEGER)');
  });
}


function testLoadBigQuerySchemaEvolutionEnabled() {
  runOne('loadBigQueryEvolutionReset');
  runOne('loadBigQueryEvolutionEnabled');

  withTemporaryNodes({
    tmpEvolutionHasColumnC: {
      kind: 'move', name: 'tmpEvolutionHasColumnC',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.INFORMATION_SCHEMA.COLUMNS WHERE table_name = "' + P.BIGQUERY_EVOLUTION_TABLE + '" AND column_name = "c"'
      }
    },
    tmpEvolutionOldRowsNullC: {
      kind: 'move', name: 'tmpEvolutionOldRowsNullC',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_EVOLUTION_TABLE + ' WHERE CAST(a AS STRING) IN ("1", "2") AND c IS NOT NULL'
      }
    }
  }, function () {
    var hasColumnC = runOne('tmpEvolutionHasColumnC');
    check('allowSchemaEvolution added the new column "c"',
      Number(hasColumnC[1][0]) === 1,
      'INFORMATION_SCHEMA.COLUMNS matched ' + hasColumnC[1][0] + ' row(s)');

    var oldRowsWithC = runOne('tmpEvolutionOldRowsNullC');
    check('rows loaded before "c" existed are NULL in it, not backfilled',
      Number(oldRowsWithC[1][0]) === 0,
      oldRowsWithC[1][0] + ' pre-existing row(s) unexpectedly have a non-null "c"');
  });
}


function testLoadBigQuerySchemaEvolutionControlFails() {
  runOne('loadBigQueryEvolutionControlReset');
  withTemporaryNodes({
    tmpEvolutionControlBlocked: {
      kind: 'move', name: 'tmpEvolutionControlBlocked',
      source: { type: 'custom', fn: myCustomExtractSchemaEvolutionEvolved },
      target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_EVOLUTION_CONTROL_TABLE, mode: 'append' }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpEvolutionControlBlocked');
    check('without allowSchemaEvolution, a grown source still fails the load job loudly',
      error.indexOf('move(): bigquery load job failed') === 0,
      error);
  });
}


function testLoadBigQuerySqlTestsPass() {
  ensureSqlTestReference();
  runOne('loadSqlTestReset');

  withTemporaryNodes({
    tmpSqlTestRowCount: {
      kind: 'move', name: 'tmpSqlTestRowCount',
      source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_SQLTEST_TABLE }
    },
    tmpSqlTestNoOrphanedStaging: {
      kind: 'move', name: 'tmpSqlTestNoOrphanedStaging',
      source: {
        type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID,
        // REGEXP_CONTAINS with an anchored pattern, not LIKE "..._%": a
        // plain LIKE prefix match on BIGQUERY_SQLTEST_TABLE
        // ("test_orders_sqltest") also matches
        // BIGQUERY_SQLTEST_EVOLUTION_TABLE's staging tables
        // ("test_orders_sqltest_evolution_..." starts with the same
        // prefix) - a real false-positive this caught the first time it
        // ran, when a leftover staging table from the evolution fixture
        // (orphaned by an earlier execution that hit Apps Script's own
        // time limit mid-run, before its own finally block could clean
        // up) made this check fail for a table it had nothing to do
        // with. resolveStagingTableId's suffix is always exactly a
        // 32-character lowercase hex uuid, so anchoring on that shape
        // is what actually scopes this to BIGQUERY_SQLTEST_TABLE's own
        // staging tables and no one else's.
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.INFORMATION_SCHEMA.TABLES WHERE REGEXP_CONTAINS(table_name, r"^_notsobigdata_stage_' + P.BIGQUERY_SQLTEST_TABLE + '_[0-9a-f]{32}$")'
      }
    }
  }, function () {
    var beforeCount = Number(runOne('tmpSqlTestRowCount')[1][0]);

    var loaded = runOne('loadSqlTestPassing');
    testLog('staged as ' + loaded.loadResult.staged.table + ', promoted via job ' + loaded.loadResult.jobId);
    check('sqlTestResults reports the one check that ran',
      loaded.loadResult.sqlTestResults.ran === 1,
      JSON.stringify(loaded.loadResult.sqlTestResults));

    var afterCount = Number(runOne('tmpSqlTestRowCount')[1][0]);
    check('a passing sql test promotes the staged rows into the real table',
      afterCount === beforeCount + 2,
      'table has ' + afterCount + ' rows, expected ' + (beforeCount + 2));

    var orphanedStaging = Number(runOne('tmpSqlTestNoOrphanedStaging')[1][0]);
    check('the staging table is gone after a successful promotion',
      orphanedStaging === 0,
      orphanedStaging + ' table(s) still match the staging name pattern');
  });
}


function testLoadBigQuerySqlTestsFail() {
  ensureSqlTestReference();
  runOne('loadSqlTestReset');

  withTemporaryNodes({
    tmpSqlTestRowCount: {
      kind: 'move', name: 'tmpSqlTestRowCount',
      source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_SQLTEST_TABLE }
    },
    tmpSqlTestNoOrphanedStaging: {
      kind: 'move', name: 'tmpSqlTestNoOrphanedStaging',
      source: {
        type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID,
        // REGEXP_CONTAINS with an anchored pattern, not LIKE "..._%": a
        // plain LIKE prefix match on BIGQUERY_SQLTEST_TABLE
        // ("test_orders_sqltest") also matches
        // BIGQUERY_SQLTEST_EVOLUTION_TABLE's staging tables
        // ("test_orders_sqltest_evolution_..." starts with the same
        // prefix) - a real false-positive this caught the first time it
        // ran, when a leftover staging table from the evolution fixture
        // (orphaned by an earlier execution that hit Apps Script's own
        // time limit mid-run, before its own finally block could clean
        // up) made this check fail for a table it had nothing to do
        // with. resolveStagingTableId's suffix is always exactly a
        // 32-character lowercase hex uuid, so anchoring on that shape
        // is what actually scopes this to BIGQUERY_SQLTEST_TABLE's own
        // staging tables and no one else's.
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.INFORMATION_SCHEMA.TABLES WHERE REGEXP_CONTAINS(table_name, r"^_notsobigdata_stage_' + P.BIGQUERY_SQLTEST_TABLE + '_[0-9a-f]{32}$")'
      }
    },
    tmpSqlTestFailing: {
      kind: 'move', name: 'tmpSqlTestFailing',
      source: { type: 'custom', fn: myCustomExtractSqlTestOrdersOrphan },
      target: {
        type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_SQLTEST_TABLE, mode: 'append',
        sqlTests: sqlTestReferentialCheck()
      }
    }
  }, function () {
    var beforeCount = Number(runOne('tmpSqlTestRowCount')[1][0]);

    var error = runOneExpectingFailure('tmpSqlTestFailing');
    check('a failing sql test names the check in the thrown error',
      error.indexOf('customer_id_exists_in_reference') !== -1,
      error);

    var afterCount = Number(runOne('tmpSqlTestRowCount')[1][0]);
    check('a failing sql test leaves the real target table completely unchanged',
      afterCount === beforeCount,
      'table had ' + beforeCount + ' rows before, ' + afterCount + ' after a failed staged load');

    var orphanedStaging = Number(runOne('tmpSqlTestNoOrphanedStaging')[1][0]);
    check('the staging table is still cleaned up despite the failure',
      orphanedStaging === 0,
      orphanedStaging + ' table(s) still match the staging name pattern');
  });
}


// The one combination never actually run before release/7's simplify
// pass caught that it hadn't been: sqlTests staging (promotion via a
// copy job) together with allowSchemaEvolution. The direct-load path
// (testLoadBigQuerySchemaEvolutionEnabled) and the staging path
// (testLoadBigQuerySqlTestsPass) were each verified alone; this is the
// two together.
function testLoadBigQuerySqlTestsWithSchemaEvolution() {
  ensureSqlTestReference();
  runOne('loadSqlTestEvolutionReset');

  var loaded = runOne('loadSqlTestEvolutionCombined');
  testLog('promoted via job ' + loaded.loadResult.jobId + ' (staged as ' + loaded.loadResult.staged.table + ')');

  withTemporaryNodes({
    tmpSqlTestEvolutionHasColumn: {
      kind: 'move', name: 'tmpSqlTestEvolutionHasColumn',
      source: {
        type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.INFORMATION_SCHEMA.COLUMNS WHERE table_name = "' + P.BIGQUERY_SQLTEST_EVOLUTION_TABLE + '" AND column_name = "region"'
      }
    },
    tmpSqlTestEvolutionNoOrphanedStaging: {
      kind: 'move', name: 'tmpSqlTestEvolutionNoOrphanedStaging',
      source: {
        type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.INFORMATION_SCHEMA.TABLES WHERE REGEXP_CONTAINS(table_name, r"^_notsobigdata_stage_' + P.BIGQUERY_SQLTEST_EVOLUTION_TABLE + '_[0-9a-f]{32}$")'
      }
    }
  }, function () {
    var hasColumn = runOne('tmpSqlTestEvolutionHasColumn');
    check('allowSchemaEvolution widens the real table on a staged promotion (copy job), not just a direct load',
      Number(hasColumn[1][0]) === 1,
      'INFORMATION_SCHEMA.COLUMNS matched ' + hasColumn[1][0] + ' row(s) for "region"');

    var orphanedStaging = Number(runOne('tmpSqlTestEvolutionNoOrphanedStaging')[1][0]);
    check('the staging table is gone after a successful promotion',
      orphanedStaging === 0,
      orphanedStaging + ' table(s) still match the staging name pattern');
  });
}
