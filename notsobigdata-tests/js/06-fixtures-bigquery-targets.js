// 06-fixtures-bigquery-targets.js — Declared move() nodes targeting BigQuery, plus the real two-step
// pipeline fixture. Backs the 'bigquery'/'pipeline' test categories.

// ===================================================================
// Declared nodes — BigQuery targets, plus a real two-step pipeline
// ===================================================================

var loadBigQueryAppend = {
  kind: 'move',
  name: 'loadBigQueryAppend',
  source: { type: 'drive', fileId: P.DRIVE_CSV_FILE_ID, fileType: 'csv' },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_LOAD_TABLE, mode: 'append' }
};

var loadBigQueryOverwrite = {
  kind: 'move',
  name: 'loadBigQueryOverwrite',
  dependsOn: ['loadBigQueryAppend'],
  source: { type: 'drive', fileId: P.DRIVE_CSV_FILE_ID, fileType: 'csv' },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_LOAD_TABLE, mode: 'overwrite' }
};

// Forces order_id to STRING instead of the INTEGER autodetect would infer.
// Loads into its own scratch table so it can't interact with
// BIGQUERY_LOAD_TABLE above.
var loadBigQuerySchema = {
  kind: 'move',
  name: 'loadBigQuerySchema',
  source: { type: 'drive', fileId: P.DRIVE_CSV_FILE_ID, fileType: 'csv' },
  target: {
    type: 'bigquery',
    projectId: P.BIGQUERY_PROJECT_ID,
    dataset: P.BIGQUERY_DATASET,
    table: P.BIGQUERY_SCHEMA_TABLE,
    mode: 'overwrite',
    schema: [
      { name: 'order_id', type: 'STRING' },
      { name: 'customer', type: 'STRING' },
      { name: 'amount', type: 'FLOAT' }
    ]
  }
};

// Schema-evolution fixtures (target.allowSchemaEvolution): two independent
// scratch tables, one exercising the flag, one a control proving today's
// fail-loud default is unchanged when it's omitted. Each pair resets its
// table to a fixed 2-column (a, b) shape via mode: 'overwrite' before its
// evolution step runs a 3-column (a, b, c) extract at it - so re-running
// this fixture never depends on residual state left by a prior run, the
// same reasoning loadBigQueryAppend/loadBigQueryOverwrite above already
// rely on for BIGQUERY_LOAD_TABLE. Two separate tables (not just two
// separate steps on one table) so the "control" fixture proving the
// fail-loud default still holds can't be polluted by the "enabled"
// fixture's own successful column addition.
var loadBigQueryEvolutionReset = {
  kind: 'move',
  name: 'loadBigQueryEvolutionReset',
  source: { type: 'custom', fn: myCustomExtractSchemaEvolutionBase },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_EVOLUTION_TABLE, mode: 'overwrite' }
};

var loadBigQueryEvolutionEnabled = {
  kind: 'move',
  name: 'loadBigQueryEvolutionEnabled',
  dependsOn: ['loadBigQueryEvolutionReset'],
  source: { type: 'custom', fn: myCustomExtractSchemaEvolutionEvolved },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_EVOLUTION_TABLE, mode: 'append', allowSchemaEvolution: true }
};

var loadBigQueryEvolutionControlReset = {
  kind: 'move',
  name: 'loadBigQueryEvolutionControlReset',
  source: { type: 'custom', fn: myCustomExtractSchemaEvolutionBase },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_EVOLUTION_CONTROL_TABLE, mode: 'overwrite' }
};

// The deliberately-failing control node itself (proving today's
// fail-loud default without allowSchemaEvolution) is declared inside
// testLoadBigQuerySchemaEvolutionControlFails via withTemporaryNodes,
// not here as a permanent top-level var - see withTemporaryNodes' own
// comment above for why: a permanently broken node would make every
// plain cli('run') fail, which is exactly what broke
// testRunEverything until this was caught.

// target.sqlTests fixtures: a small reference table (known customer ids)
// loaded directly (no staging - it's just test setup, not what's under
// test), a plain direct-load reset that gives BIGQUERY_SQLTEST_TABLE a
// known starting row count, and two staged loads onto it - one whose
// batch passes the referential-integrity sqlTests check, one that
// doesn't. Both sqlTests-bearing nodes target the same table as the
// reset node via mode: 'append' and declare dependsOn it, so a bare
// cli('run') always lands the reset first too - --select ignores
// dependsOn, so each test function still calls runOne('...Reset')
// itself before the node under test, same as loadBigQueryEvolutionReset
// above.
var loadSqlTestReference = {
  kind: 'move',
  name: 'loadSqlTestReference',
  source: { type: 'custom', fn: myCustomExtractSqlTestCustomers },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_SQLTEST_REFERENCE_TABLE, mode: 'overwrite' }
};

var loadSqlTestReset = {
  kind: 'move',
  name: 'loadSqlTestReset',
  source: { type: 'custom', fn: myCustomExtractSqlTestOrdersValid },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_SQLTEST_TABLE, mode: 'overwrite' }
};

// customer_id is cast to STRING on both sides of the join - autodetect
// would otherwise infer INT64 for these all-numeric-looking CSV values
// (bit us once already on the schema-evolution fixtures' "a" column),
// and this way the check is correct regardless of which type autodetect
// actually picks for either table.
function sqlTestReferentialCheck() {
  return [
    {
      name: 'customer_id_exists_in_reference',
      query: 'SELECT s.customer_id FROM {{ this }} s LEFT JOIN `' +
        P.BIGQUERY_PROJECT_ID + '.' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_SQLTEST_REFERENCE_TABLE +
        '` c ON CAST(s.customer_id AS STRING) = CAST(c.customer_id AS STRING) WHERE c.customer_id IS NULL'
    }
  ];
}

var loadSqlTestPassing = {
  kind: 'move',
  name: 'loadSqlTestPassing',
  dependsOn: ['loadSqlTestReset'],
  source: { type: 'custom', fn: myCustomExtractSqlTestOrdersValid },
  target: {
    type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_SQLTEST_TABLE, mode: 'append',
    sqlTests: sqlTestReferentialCheck()
  }
};

// The deliberately-failing sqlTests node (myCustomExtractSqlTestOrdersOrphan,
// a customer_id with no match in the reference table) is declared inside
// testLoadBigQuerySqlTestsFail via withTemporaryNodes, not here as a
// permanent top-level var - same reasoning as
// loadBigQueryEvolutionControlBlocked above.

// Combines sqlTests staging with allowSchemaEvolution on the same
// target - the promotion step is a BigQuery copy job, not a load job,
// and copy jobs were never confirmed to honor schemaUpdateOptions the
// same way. Own scratch table (not BIGQUERY_SQLTEST_TABLE above) so it
// starts without a "region" column to grow.
var loadSqlTestEvolutionReset = {
  kind: 'move',
  name: 'loadSqlTestEvolutionReset',
  source: { type: 'custom', fn: myCustomExtractSqlTestOrdersValid },
  target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_SQLTEST_EVOLUTION_TABLE, mode: 'overwrite' }
};

var loadSqlTestEvolutionCombined = {
  kind: 'move',
  name: 'loadSqlTestEvolutionCombined',
  dependsOn: ['loadSqlTestEvolutionReset'],
  source: { type: 'custom', fn: myCustomExtractSqlTestOrdersValidWithNewColumn },
  target: {
    type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_SQLTEST_EVOLUTION_TABLE, mode: 'append',
    allowSchemaEvolution: true,
    sqlTests: sqlTestReferentialCheck()
  }
};

// The point of the whole library in two nodes: land raw data in BigQuery,
// then read an aggregate of it back into a Sheets tab. Nothing here says
// "run the load first" - the dependsOn does, and cli() works the order out.
var reportFromLoadedTable = {
  kind: 'move',
  name: 'reportFromLoadedTable',
  dependsOn: ['loadBigQueryOverwrite'],
  source: {
    type: 'bigquery',
    projectId: P.BIGQUERY_PROJECT_ID,
    query: 'SELECT customer, SUM(amount) AS total FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_LOAD_TABLE + ' GROUP BY customer ORDER BY total DESC'
  },
  target: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, sheetName: 'PipelineReport', mode: 'overwrite' }
};
