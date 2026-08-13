// 15-tests-model-dependson.js — model-dependson test category (see PROJECT.md; runAllTests('model-dependson')).


// The four tests below cover the model dependsOn feature (a model
// depending on a move/non-model node, since {{ ref() }} can only reach
// other models) - see src/model.md's "Depending on a move node" design
// note for the full rationale.

function testModelDependsOnMoveNodeOrdersCorrectly() {
  withTemporaryNodes({
    tmpLoadForModel: { kind: 'move', name: 'tmpLoadForModel', source: { type: 'custom', fn: myCustomExtract } },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpDependsOnMove: { sqlFile: 'stg_orders.html', dependsOn: ['tmpLoadForModel'] } }
    }
  }, function () {
    var order = NotSoBigData.cli('list').nodes.map(function (n) { return n.name; });
    check('a model with no ref() to it still runs after a move node named in its own dependsOn',
      order.indexOf('tmpLoadForModel') < order.indexOf('tmpDependsOnMove'), order.join(', '));
  });
}


function testModelDependsOnUnionsWithRefDependencies() {
  withTemporaryNodes({
    tmpLoadForUnion: { kind: 'move', name: 'tmpLoadForUnion', source: { type: 'custom', fn: myCustomExtract } },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        stg_orders: {},
        tmpUnionDependsOn: { sqlFile: 'html/orders_summary.html', dependsOn: ['tmpLoadForUnion'] }
      }
    }
  }, function () {
    var order = NotSoBigData.cli('list').nodes.map(function (n) { return n.name; });
    check('the {{ ref() }}-derived edge is still honored alongside a hand-written dependsOn',
      order.indexOf('stg_orders') < order.indexOf('tmpUnionDependsOn'), order.join(', '));
    check('the hand-written dependsOn edge is honored too, not replaced by ref()',
      order.indexOf('tmpLoadForUnion') < order.indexOf('tmpUnionDependsOn'), order.join(', '));
  });
}


// Proves override (not merge) by making the registry-wide default's move
// node fail: a model that inherits the default must get skipped by that
// failure, while a model with its own dependsOn - naming a move node that
// succeeds - must still run, showing it never inherited the default at
// all. Ordering alone can't distinguish "overridden" from "merged", since
// Kahn's algorithm doesn't reveal the absence of an edge - this does.
function testModelDependsOnEntryOverridesRegistryDefault() {
  withTemporaryNodes({
    tmpDefaultMoveBoom: {
      kind: 'move', name: 'tmpDefaultMoveBoom',
      source: { type: 'drive', fileId: 'this-is-not-a-real-drive-file-id', fileType: 'csv' }
    },
    tmpOwnMove: { kind: 'move', name: 'tmpOwnMove', source: { type: 'custom', fn: myCustomExtract } },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      dependsOn: ['tmpDefaultMoveBoom'],
      models: {
        tmpInheritsRegistryDefault: { sqlFile: 'stg_orders.html' },
        tmpOverridesRegistryDefault: { sqlFile: 'stg_orders.html', dependsOn: ['tmpOwnMove'] }
      }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpDefaultMoveBoom,tmpOwnMove,tmpInheritsRegistryDefault,tmpOverridesRegistryDefault');
    check('the registry default\'s move node reports failed', statusOf(report, 'tmpDefaultMoveBoom') === 'failed');
    check('a model with no dependsOn of its own inherits the registry-wide default and is skipped by its failure',
      statusOf(report, 'tmpInheritsRegistryDefault') === 'skipped');
    check('a model with its own dependsOn overrides the registry default entirely and still runs',
      statusOf(report, 'tmpOverridesRegistryDefault') === 'success');
  });
}


function testModelMalformedDependsOnFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpBadDependsOn: { sqlFile: 'stg_orders.html', dependsOn: 'notAnArray' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpBadDependsOn'; })[0];
    check('a non-array dependsOn on a model is reported failed by a dry "list" run, not thrown for the whole project',
      !!node && node.status === 'failed' && node.error.indexOf('is not an array') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}
