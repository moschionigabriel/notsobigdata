// 18-tests-model-discovery.js — model-discovery test category (see PROJECT.md; runAllTests('model-discovery')).


function testModelRegistryNameCollisionThrows() {
  withTemporaryNodes({
    tmpCollision: { kind: 'move', name: 'tmpCollision', source: { type: 'custom', fn: myCustomExtract } },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpCollision: { sqlFile: 'stg_orders.html' } }
    }
  }, function () {
    try {
      NotSoBigData.cli('list');
      check('a model name colliding with a declared node name throws', false, 'it did not throw');
    } catch (e) {
      check('a model name colliding with a declared node name throws', e.message.indexOf('both named "tmpCollision"') !== -1, e.message);
    }
  });
}


function testModelMultiStatementThrows() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpMultiStatement: { sqlFile: 'html/model_multi_statement.html' } }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpMultiStatement');
    check('a model with a multi-statement SQL body throws',
      message.indexOf('must be a single statement') !== -1, message);
  });
}


function testModelMalformedRegistryThrows() {
  withTemporaryNodes({
    notsobigdataModels: ['not', 'an', 'object']
  }, function () {
    var threw = null;
    try {
      NotSoBigData.cli('list');
    } catch (e) {
      threw = e;
    }
    check('a structurally malformed notsobigdataModels throws instead of silently behaving like "not declared"',
      !!threw && threw.message.indexOf('notsobigdataModels must be an object') !== -1, threw ? threw.message : 'did not throw');
  });
}


function testModelTopLevelVarRejected() {
  withTemporaryNodes({
    tmpOldStyleModel: { kind: 'model', sqlFile: 'stg_orders.html' }
  }, function () {
    var threw = null;
    try {
      NotSoBigData.cli('list');
    } catch (e) {
      threw = e;
    }
    check('a model declared as its own top-level var is rejected with a clear redirect',
      !!threw && threw.message.indexOf('notsobigdataModels.models instead') !== -1, threw ? threw.message : 'did not throw');
  });
}


// Regression coverage for a second /release finish pass's independent
// review finding: expandModelNodes() used to let any one model's own
// read/parse error throw straight out of discoverNodes(), aborting cli()
// for every node in the project - move nodes included - not just the
// broken model. tmpBrokenModel's sqlFile deliberately doesn't exist;
// tmpUnrelatedMove has nothing to do with it (no shared dependsOn, no ref()
// between them) and must still run to a normal success, proving the
// broken model's failure is now isolated to itself.
function testModelBrokenModelDoesNotBlockUnrelatedNode() {
  withTemporaryNodes({
    tmpUnrelatedMove: { kind: 'move', name: 'tmpUnrelatedMove', source: { type: 'custom', fn: myCustomExtract } },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpBrokenModel: { sqlFile: 'html/model_does_not_exist.html' } }
    }
  }, function () {
    var rows = runOne('tmpUnrelatedMove');
    check('an unrelated move node still runs fine even though a sibling model\'s .html file is missing',
      rows.length === 3, JSON.stringify(rows));
  });
}
