// 14-tests-model-core.js — model-core test category (see PROJECT.md; runAllTests('model-core')).


// ===================================================================
// model kind
//
// The two fixture models (stg_orders.html / orders_summary.html) are
// self-contained SELECT literals rather than reads against the shared
// test_orders table - a model's own name always becomes its output
// relation name (config.name is forced from the notsobigdataModels.models
// key, dbt-style), which can't be parameterized through Script Properties
// the way move's read/write *targets* are, since {{ ref() }} calls have to
// name that same identifier literally inside a static .html file. Only
// projectId/dataset are parameterized here - the model names themselves
// are code, like a variable name, not a pre-existing resource pointer.
// ===================================================================

function testModelViewDependencyOrderAndTableMaterialization() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        stg_orders: { sqlFile: 'stg_orders.html' },
        orders_summary: { sqlFile: 'html/orders_summary.html', materialized: 'table' }
      }
    },
    tmpReadOrdersSummary: {
      kind: 'move', name: 'tmpReadOrdersSummary', dependsOn: ['orders_summary'],
      source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: 'orders_summary' }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select stg_orders,orders_summary,tmpReadOrdersSummary');
    check('model + move pipeline reports ok', report.ok, JSON.stringify(report.nodes));

    var order = report.nodes.map(function (n) { return n.name; });
    check('stg_orders runs before orders_summary', order.indexOf('stg_orders') < order.indexOf('orders_summary'));
    check('orders_summary runs before the move node reading it back', order.indexOf('orders_summary') < order.indexOf('tmpReadOrdersSummary'));

    var byName = {};
    report.nodes.forEach(function (n) { byName[n.name] = n; });
    check('stg_orders materialized as a view (the default)', byName.stg_orders.result.materialized === 'view', byName.stg_orders.result.materialized);
    check('orders_summary materialized as a table (explicit override)', byName.orders_summary.result.materialized === 'table', byName.orders_summary.result.materialized);

    var rows = byName.tmpReadOrdersSummary.result;
    var aliceRow = rows.slice(1).filter(function (row) { return row[0] === 'alice'; })[0];
    check('orders_summary aggregated alice to 2 orders via ref()', !!aliceRow && String(aliceRow[1]) === '2', JSON.stringify(rows));
  });
}
