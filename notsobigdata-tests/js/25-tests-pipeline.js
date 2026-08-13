// 25-tests-pipeline.js — pipeline test category (see PROJECT.md; runAllTests('pipeline')).


// The two-node pipeline on its own: load raw data into BigQuery, then read
// an aggregate of it back into a Sheets tab, in that order, without either
// node being told when to run.
function testPipelineChain() {
  var report = NotSoBigData.cli('run --select loadBigQueryAppend,loadBigQueryOverwrite,reportFromLoadedTable');
  var order = report.nodes.map(function (node) { return node.name; });
  check('the chain ran in dependency order', order.join(' -> ') ===
    'loadBigQueryAppend -> loadBigQueryOverwrite -> reportFromLoadedTable', order.join(' -> '));
  check('the whole chain succeeded', report.ok === true);
  var written = SpreadsheetApp.openById(P.SHEETS_SOURCE_SPREADSHEET_ID).getSheetByName('PipelineReport').getLastRow();
  testLog('PipelineReport tab now has ' + written + ' rows.');
}


// ===================================================================
// The whole pipeline
// ===================================================================

// What the library is actually for: one call, every declared node, in
// dependency order. This writes to every real fixture - run testList first
// if you want to see the plan before committing to it.
function testRunEverything() {
  var report = NotSoBigData.cli('run');
  check('every declared node succeeded', report.ok === true,
    report.nodes.filter(function (n) { return n.status !== 'success'; })
      .map(function (n) { return n.name + ':' + n.status; }).join(', ') || 'all green');
}
