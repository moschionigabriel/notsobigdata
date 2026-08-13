// 24-tests-regressions.js — regressions test category (see PROJECT.md; runAllTests('regressions')).


// ===================================================================
// Tests — regressions found by the release/5 review
//
// The empty-extract guards already had tests, and they all passed while
// the guard was broken. Every one of them used a custom fn returning [] -
// a shape that was already empty. The sources that *don't* hand back []
// for "no data" (bigquery returns [headers]; sheets and csv return
// [['']]) were never covered, which is exactly how a data-loss bug
// survived a full green suite. These cover those cases.
// ===================================================================

function testExtractBigQueryEmptyResultIsEmpty() {
  withTemporaryNodes({
    tmpEmptyQuery: {
      kind: 'move',
      name: 'tmpEmptyQuery',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT * FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_TABLE + ' WHERE 1 = 0'
      }
    }
  }, function () {
    var rows = runOne('tmpEmptyQuery');
    check('a zero-row query extracts as [] rather than a lone header row',
      rows.length === 0, 'got ' + rows.length + ' row(s): ' + JSON.stringify(rows));
  });
}


// The actual data-loss scenario, end to end: a scheduled overwrite whose
// source came back empty must leave the destination table alone. Before
// the fix this emptied the table.
function testEmptyBigQueryResultDoesNotTruncateTarget() {
  runOne('loadBigQueryOverwrite');
  withTemporaryNodes({
    tmpCountLoaded: {
      kind: 'move',
      name: 'tmpCountLoaded',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT COUNT(*) AS n FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_LOAD_TABLE
      }
    },
    tmpEmptyIntoLoaded: {
      kind: 'move',
      name: 'tmpEmptyIntoLoaded',
      source: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        query: 'SELECT * FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_LOAD_TABLE + ' WHERE 1 = 0'
      },
      target: {
        type: 'bigquery',
        projectId: P.BIGQUERY_PROJECT_ID,
        dataset: P.BIGQUERY_DATASET,
        table: P.BIGQUERY_LOAD_TABLE,
        mode: 'overwrite'
      }
    }
  }, function () {
    var before = Number(runOne('tmpCountLoaded')[1][0]);
    runOne('tmpEmptyIntoLoaded');
    var after = Number(runOne('tmpCountLoaded')[1][0]);
    check('an empty query result left the destination table intact',
      before > 0 && after === before, 'before=' + before + ' after=' + after);
  });
}


function testExtractSheetsBlankRangeIsEmpty() {
  withTemporaryNodes({
    tmpBlankRange: {
      kind: 'move',
      name: 'tmpBlankRange',
      // Far outside the fixture data, so this is reliably blank. Not a
      // resource identifier, so it stays inline rather than in a property.
      source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: 'Z100:Z101' }
    }
  }, function () {
    var rows = runOne('tmpBlankRange');
    check('a blank sheet range extracts as [] rather than [[""]]',
      rows.length === 0, 'got ' + rows.length + ' row(s): ' + JSON.stringify(rows));
  });
}


// A selector token that is both a kind and a node name used to resolve
// silently to the kind, so "--exclude move" would drop every move node.
function testAmbiguousSelectorThrows() {
  withTemporaryNodes({
    move: { kind: 'move', name: 'move', source: { type: 'custom', fn: myCustomExtract } }
  }, function () {
    var message = '';
    try {
      NotSoBigData.cli('list --exclude move');
    } catch (error) {
      message = error.message;
    }
    check('a token that is both a kind and a node name is rejected',
      /ambiguous/.test(message), message || 'no error thrown');
  });
}


// A node named __proto__ used to vanish from every internal lookup map,
// and got reported as a cycle despite having no dependencies at all.
function testProtoNamedNodeOrdersCorrectly() {
  withTemporaryNodes({
    protoNamed: { kind: 'move', name: '__proto__', source: { type: 'custom', fn: myCustomExtract } },
    protoDependent: {
      kind: 'move',
      name: 'protoDependent',
      dependsOn: ['__proto__'],
      source: { type: 'custom', fn: myCustomExtract }
    }
  }, function () {
    var report = NotSoBigData.cli('list --select __proto__,protoDependent');
    var order = report.nodes.map(function (node) { return node.name; });
    check('a node named __proto__ orders normally instead of being called a cycle',
      order.join(' -> ') === '__proto__ -> protoDependent', order.join(' -> '));
  });
}


// A move node named __proto__ with a bigquery target used to pass
// discovery-time ref() validation (the moveBigQueryTargets index is built
// with emptyMap(), so it stored the __proto__ key correctly) but then fail
// at actual run time - the per-model moveRefTargets map was a plain {}
// and silently swallowed the __proto__-keyed assignment (sets the
// prototype, not an own property) instead of storing the resolved table
// ref, so model()'s resolveRef found nothing there and threw.
function testModelRefProtoNamedMoveNodeResolves() {
  withTemporaryNodes({
    protoNamedMove: {
      kind: 'move', name: '__proto__',
      source: { type: 'custom', fn: myCustomExtract },
      target: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_REF_TEST_TABLE, mode: 'overwrite' }
    },
    notsobigdataModels: {
      projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET,
      models: { tmpRefsProtoNamedMove: { sqlFile: 'html/model_ref_to_proto_named_move_node.html', materialized: 'table' } }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select __proto__,tmpRefsProtoNamedMove');
    check('ref() to a move node literally named __proto__ resolves instead of silently failing at run time',
      report.ok, JSON.stringify(report.nodes));
  });
}


// "--select a, b" (a space after the comma) used to report
// 'unknown option "b"'.
function testSelectorTolerateSpaceAfterComma() {
  var report = NotSoBigData.cli('list --select extractSheets, extractCustom');
  check('a space after the comma in a selector list is accepted',
    report.nodes.length === 2, JSON.stringify(report.nodes.map(function (n) { return n.name; })));
}


// Needs a Drive JSON fixture whose content is an envelope rather than a
// bare array, e.g. {"data": [{"a": 1}]}. Create one in the notsobigdata
// Drive folder and set DRIVE_JSON_ENVELOPE_FILE_ID to run it; skipped
// otherwise so the suite stays green on a machine that hasn't made it.
function testJsonEnvelopeReportsAClearError() {
  if (!P.DRIVE_JSON_ENVELOPE_FILE_ID) {
    Logger.log('SKIP: testJsonEnvelopeReportsAClearError - set DRIVE_JSON_ENVELOPE_FILE_ID to run it.');
    return;
  }
  withTemporaryNodes({
    tmpEnvelopeJson: {
      kind: 'move',
      name: 'tmpEnvelopeJson',
      source: { type: 'drive', fileType: 'json', fileId: P.DRIVE_JSON_ENVELOPE_FILE_ID }
    }
  }, function () {
    var message = runOneExpectingFailure('tmpEnvelopeJson');
    check('an envelope-shaped JSON payload reports a move() message, not a raw TypeError',
      /expected a JSON array of objects/.test(message) && !/is not a function/.test(message), message);
  });
}
