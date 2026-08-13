// 99-quick-run.js — one-click smoke test. Category names: see PROJECT.md.

// Just the tests touched by today's fixes: testLoadDriveCsv's stale-marker
// overwrite check, testLoadSheetsRangeAndIncludeHeader's startRow check,
// and the three bigquery tests + testRunEverything that exercise the new
// dependsOn edges in 06-fixtures-bigquery-targets.js.
function test() {
  runAllTests('testLoadDriveCsv,testLoadSheetsRangeAndIncludeHeader,testLoadBigQuerySchemaEvolutionEnabled,testLoadBigQuerySqlTestsPass,testLoadBigQuerySqlTestsWithSchemaEvolution,testRunEverything')
}
