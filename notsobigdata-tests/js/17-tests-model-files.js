// 17-tests-model-files.js — model-files test category (see PROJECT.md; runAllTests('model-files')).


function testModelSqlFileDefaultsToNodeName() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { stg_orders: {} }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select stg_orders');
    check('sqlFile defaults to "<name>.html" when omitted', report.ok, JSON.stringify(report.nodes));
  });
}


// The five tests below cover fixes from /release finish's simplify +
// independent review pass, not the original feature PR - see
// src/model.md's "Fixes from /release finish's..." section for why each
// one was a real gap worth a regression test.

// Note these four "bad tag/id" fixtures assert against cli('list')'s
// returned report, not a thrown exception - a second /release finish pass
// fixed expandModelNodes() to report this class of error as that one
// node's own "failed" status (surfaced even by a dry "list" run, so a
// config mistake is still caught before anything executes for real)
// rather than letting it abort discovery for the whole project. See
// src/model.md's second "Fixes from /release finish's..." section.
function testModelMultipleSqlTagsWithoutIdsFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpTwoTags: { sqlFile: 'html/model_two_tags.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpTwoTags'; })[0];
    check('a .html file with more than one sql tag but no ids is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('needs an "id"') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


// The tests below cover the shared-.html-file capability added after the
// original model() v1 PR - see src/model.md's tag-count-dispatch note.

function testModelNoTagWholeFileIsSql() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpNoTags: { sqlFile: 'html/model_no_tags_at_all.html' } }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpNoTags');
    check('a .html file with no <script> tag at all uses the whole file as the SQL', report.ok, JSON.stringify(report.nodes));
  });
}


function testModelSharedFileResolvesByIdAndOrdersCorrectly() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: {
        tmpSharedStgOrders: { sqlFile: 'html/pipeline_shared.html' },
        tmpSharedOrdersSummary: { sqlFile: 'html/pipeline_shared.html', materialized: 'table' }
      }
    },
    tmpReadSharedSummary: {
      kind: 'move', name: 'tmpReadSharedSummary', dependsOn: ['tmpSharedOrdersSummary'],
      source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: 'tmpSharedOrdersSummary' }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpSharedStgOrders,tmpSharedOrdersSummary,tmpReadSharedSummary');
    check('two models sharing one .html file both run ok', report.ok, JSON.stringify(report.nodes));
    var order = report.nodes.map(function (n) { return n.name; });
    check('the model ref()d by the other still runs first, same file or not',
      order.indexOf('tmpSharedStgOrders') < order.indexOf('tmpSharedOrdersSummary'));
    var byName = {};
    report.nodes.forEach(function (n) { byName[n.name] = n; });
    var rows = byName.tmpReadSharedSummary.result;
    var aliceRow = rows.slice(1).filter(function (row) { return row[0] === 'alice'; })[0];
    check('the shared-file model aggregated alice to 2 orders via ref()', !!aliceRow && String(aliceRow[1]) === '2', JSON.stringify(rows));
  });
}


function testModelSingleTagMismatchedIdFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpMismatchedSingleId: { sqlFile: 'html/model_single_tag_wrong_id.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpMismatchedSingleId'; })[0];
    check('a single tag whose id does not match the model name is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('does not match model') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


function testModelSharedFileNoIdMatchFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpNoIdMatch: { sqlFile: 'html/model_shared_no_id_match.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpNoIdMatch'; })[0];
    check('a shared file with no tag id matching the model name is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('has no <script type="text/sql" id="tmpNoIdMatch">') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}


function testModelSharedFileDuplicateIdFailsAtList() {
  withTemporaryNodes({
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpDuplicateTag: { sqlFile: 'html/model_shared_duplicate_id.html' } }
    }
  }, function () {
    var node = NotSoBigData.cli('list').nodes.filter(function (n) { return n.name === 'tmpDuplicateTag'; })[0];
    check('a shared file with two tags sharing the same id is reported failed by a dry "list" run',
      !!node && node.status === 'failed' && node.error.indexOf('ids must be unique') !== -1,
      node ? node.status + ': ' + node.error : 'node missing from report');
  });
}
