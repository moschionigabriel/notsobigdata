// 20-tests-model-compile.js — model-compile test category (see PROJECT.md; runAllTests('model-compile')).


// ===================================================================
// Tests — the model kind, cli('compile')
// ===================================================================

// Same stg_orders/orders_summary view+table+ref() pipeline
// testModelViewDependencyOrderAndTableMaterialization already proves runs
// correctly - reused here to prove compile resolves the exact same ref()
// into the same fully-qualified relation, without ever touching BigQuery
// (no .result, no .ms - those only ever appear on a real "run").
function testCompileResolvesRefWithoutExecuting() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        stg_orders: { sqlFile: 'stg_orders.html' },
        orders_summary: { sqlFile: 'html/orders_summary.html', materialized: 'table' }
      }
    }
  }, function () {
    var report = NotSoBigData.cli('compile --select stg_orders,orders_summary');
    check('compile reports ok', report.ok, JSON.stringify(report.nodes));

    var byName = {};
    report.nodes.forEach(function (n) { byName[n.name] = n; });
    check('stg_orders (no ref() of its own) is planned, not executed',
      byName.stg_orders.status === 'planned' && byName.stg_orders.result === undefined, JSON.stringify(byName.stg_orders));
    check('orders_summary is planned and carries compiledSql',
      byName.orders_summary.status === 'planned' && typeof byName.orders_summary.compiledSql === 'string', JSON.stringify(byName.orders_summary));
    check('orders_summary\'s {{ ref(\'stg_orders\') }} was substituted with the real relation, not left as a template',
      byName.orders_summary.compiledSql.indexOf('{{') === -1 &&
      byName.orders_summary.compiledSql.indexOf('`' + P.BIGQUERY_PROJECT_ID + '.' + P.BIGQUERY_DATASET + '.stg_orders`') !== -1,
      byName.orders_summary.compiledSql);

    if (report.manifest.written) {
      DriveApp.getFileById(report.manifest.fileId).setTrashed(true);
    }
  });
}


// A move node has no {{ }}-style templating to resolve, so it should be
// exactly as boring under compile as it already is under list.
function testCompileMoveNodeReportsPlannedWithNoCompiledSql() {
  var report = NotSoBigData.cli('compile --select extractSheets');
  var node = report.nodes[0];
  check('a move node under compile is just planned, same as under list',
    node.status === 'planned' && node.compiledSql === undefined, JSON.stringify(node));
  if (report.manifest.written) {
    DriveApp.getFileById(report.manifest.fileId).setTrashed(true);
  }
}


// Same fixture/setup as testModelRefToNonBigQueryMoveTargetFailsAtList
// above, run under "compile" instead of "list" - a discoveryError is
// checked before COMPILERS is ever consulted (see runNodes()), so it must
// fail the exact same way under both dry-run commands, not just "list".
function testCompileSurfacesDiscoveryErrorsSameAsList() {
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
    var report = NotSoBigData.cli('compile --select tmpRefsSheetsMoveNode');
    var node = report.nodes[0];
    check('a ref() naming a real move node whose target is not bigquery fails at compile the same way it fails at list',
      node.status === 'failed' && node.error.indexOf('does not match a declared model or a move node with a bigquery target') !== -1,
      node.status + ': ' + node.error);
    if (report.manifest.written) {
      DriveApp.getFileById(report.manifest.fileId).setTrashed(true);
    }
  });
}


// compile writes its own manifest file, entirely separate from the run
// manifest - calling compile must never disturb the record of what the
// last real run actually did.
function testCompileManifestWrittenSeparatelyFromRunManifest() {
  var runReport = NotSoBigData.cli('run --select extractSheets');
  check('run wrote its own manifest', runReport.manifest.written === true, JSON.stringify(runReport.manifest));

  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { stg_orders: { sqlFile: 'stg_orders.html' } }
    }
  }, function () {
    var compileReport = NotSoBigData.cli('compile --select stg_orders');
    check('compile wrote its own manifest', compileReport.manifest.written === true, JSON.stringify(compileReport.manifest));
    check('the compile manifest is a different file from the run manifest',
      compileReport.manifest.fileId !== runReport.manifest.fileId,
      compileReport.manifest.fileId + ' vs ' + runReport.manifest.fileId);

    var compileContent = JSON.parse(DriveApp.getFileById(compileReport.manifest.fileId).getBlob().getDataAsString());
    check('the compile manifest is well-formed and carries compiledSql',
      compileContent.notsobigdata === 'manifest' && typeof compileContent.nodes[0].compiledSql === 'string',
      JSON.stringify(compileContent));

    var runContent = JSON.parse(DriveApp.getFileById(runReport.manifest.fileId).getBlob().getDataAsString());
    check('the run manifest is untouched by the compile call',
      runContent.command === 'run --select extractSheets', JSON.stringify(runContent));

    DriveApp.getFileById(compileReport.manifest.fileId).setTrashed(true);
  });
  DriveApp.getFileById(runReport.manifest.fileId).setTrashed(true);
}


// enabled: false must skip the write entirely and report why, same
// contract testManifestDisabled already proves for the run manifest -
// via the compile manifest's own, independent global.
function testCompileManifestDisabled() {
  withTemporaryNodes({ notsobigdataCompileManifest: { enabled: false } }, function () {
    var report = NotSoBigData.cli('compile --select extractSheets');
    check('compile manifest reports disabled', report.manifest.written === false && report.manifest.reason === 'disabled', JSON.stringify(report.manifest));
  });
}


// Regression coverage for the "prevent manifest/compile-manifest target
// collision" fix (src/cli.md's "Manifest target collision now caught,
// writers deduplicated" note). Before this fix, pointing
// notsobigdataManifest and notsobigdataCompileManifest at the same
// folderId + fileName silently let whichever command ran most recently
// overwrite the other's manifest, with no error either time. Checked from
// both directions - run() then compile() - since writeManifestFile() is
// called once from each side with the roles (config/otherConfig) swapped.
function testManifestCompileManifestCollisionRefusesToWrite() {
  withTemporaryNodes({
    notsobigdataManifest: { folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'notsobigdata-manifest-collision-test.json' },
    notsobigdataCompileManifest: { folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'notsobigdata-manifest-collision-test.json' },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { stg_orders: { sqlFile: 'stg_orders.html' } }
    }
  }, function () {
    var runReport = NotSoBigData.cli('run --select extractSheets');
    check('run refuses to write when it would collide with the compile manifest\'s own target',
      runReport.manifest.written === false && runReport.manifest.reason === 'collision'
        && runReport.manifest.error.indexOf('resolve to the same Drive file') !== -1,
      JSON.stringify(runReport.manifest));

    var compileReport = NotSoBigData.cli('compile --select stg_orders');
    check('compile refuses to write when it would collide with the run manifest\'s own target',
      compileReport.manifest.written === false && compileReport.manifest.reason === 'collision'
        && compileReport.manifest.error.indexOf('resolve to the same Drive file') !== -1,
      JSON.stringify(compileReport.manifest));
  });
}

