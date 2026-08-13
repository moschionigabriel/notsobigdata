// 10-tests-cli.js — cli test category (see PROJECT.md; runAllTests('cli')).

// ===================================================================
// Tests — cli() itself
// ===================================================================

// Run this one first. It proves the eval() install landed AND that the
// global scan can see the nodes above; if it reports 0 nodes, nothing else
// in this file will make sense.
// Note these tests don't re-log what they get back: cli() already logs its
// own output, so a Logger.log(message) here would print the whole thing
// twice. Same rule throughout this file - the library owns per-node and
// per-command logging, the tests only add PASS/FAIL lines and anything the
// library doesn't already say.
function testHello() {
  var message = NotSoBigData.cli('hello');
  check('hello reports the library loaded', message.indexOf('loaded OK') !== -1);
  check('hello discovered the declared nodes', message.indexOf('extractSheets (move)') !== -1);
  check('hello reports the unknown kind as ignored', message.indexOf('deliberateTypoKind') !== -1);
}


function testHelp() {
  var message = NotSoBigData.cli('help');
  check('help lists the commands', message.indexOf('cli("run")') !== -1);
}


// list resolves and orders everything without executing any of it - the
// safe way to see what a bare cli('run') would actually do to your real
// Sheets, Drive files and BigQuery tables.
function testList() {
  var report = NotSoBigData.cli('list');
  check('list planned every node without running any', report.nodes.every(function (node) {
    return node.status === 'planned';
  }), report.nodes.length + ' nodes planned - see the PLAN lines above for the order');
}


// The ordering guarantee, checked against the real declared graph rather
// than a toy one: every node must appear after everything it dependsOn.
function testDependencyOrder() {
  var report = NotSoBigData.cli('list');
  var order = report.nodes.map(function (node) { return node.name; });
  var byName = {};
  report.nodes.forEach(function (node) { byName[node.name] = node; });

  var violations = [];
  [
    ['loadSheetsOverwrite', 'loadSheetsAppend'],
    ['loadSheetsAppend', 'emptyGuardSheets'],
    ['loadSheetsRangeOverwrite', 'loadSheetsRangeAppendNoHeader'],
    ['loadDriveCsvOverwrite', 'emptyGuardDriveCsv'],
    ['loadDriveXlsx', 'emptyGuardDriveXlsx'],
    ['loadBigQueryAppend', 'loadBigQueryOverwrite'],
    ['loadBigQueryOverwrite', 'reportFromLoadedTable']
  ].forEach(function (pair) {
    if (order.indexOf(pair[0]) > order.indexOf(pair[1])) {
      violations.push(pair[0] + ' should come before ' + pair[1]);
    }
  });

  check('every node runs after what it dependsOn', violations.length === 0,
    violations.join('; ') || 'checked ' + order.length + ' nodes against the declared edges');
}


function testSelectByKind() {
  var report = NotSoBigData.cli('list --select move');
  check('--select move matched every move node', report.nodes.length > 10, report.nodes.length + ' nodes');
}


function testSelectByName() {
  var report = NotSoBigData.cli('list --select extractSheets');
  check('--select by name took exactly that node', report.nodes.length === 1 && report.nodes[0].name === 'extractSheets');
}


function testSelectCommaList() {
  var report = NotSoBigData.cli('list --select extractSheets,extractDriveCsv');
  check('--select accepts a comma list', report.nodes.length === 2);
}


function testExclude() {
  var all = NotSoBigData.cli('list').nodes.length;
  var report = NotSoBigData.cli('list --exclude extractSheets');
  check('--exclude dropped one node', report.nodes.length === all - 1, report.nodes.length + ' of ' + all);
}


// --select selects exactly what it names; it does not drag in upstreams.
function testSelectDoesNotPullUpstreams() {
  var report = NotSoBigData.cli('list --select emptyGuardSheets');
  check('--select left the upstream nodes out', report.nodes.length === 1 && report.nodes[0].name === 'emptyGuardSheets');
}


function testUnknownSelectorThrows() {
  try {
    NotSoBigData.cli('list --select thisNodeDoesNotExist');
    check('unknown selector throws', false, 'it did not throw');
  } catch (e) {
    check('unknown selector throws', e.message.indexOf('matched no kind and no node name') !== -1, e.message);
  }
}


function testUnknownCommandThrows() {
  try {
    NotSoBigData.cli('deploy');
    check('unknown command throws', false, 'it did not throw');
  } catch (e) {
    check('unknown command throws', e.message.indexOf('unknown command') !== -1, e.message);
  }
}


// A cycle is caught before anything runs, and the error names the nodes
// stuck in it. Declared temporarily so a permanently broken graph doesn't
// poison every other test - see withTemporaryNodes above.
function testCycleThrows() {
  withTemporaryNodes({
    tmpCycleA: { kind: 'move', name: 'tmpCycleA', dependsOn: ['tmpCycleB'], source: { type: 'custom', fn: myCustomExtract } },
    tmpCycleB: { kind: 'move', name: 'tmpCycleB', dependsOn: ['tmpCycleA'], source: { type: 'custom', fn: myCustomExtract } }
  }, function () {
    try {
      NotSoBigData.cli('list --select tmpCycleA,tmpCycleB');
      check('a dependency cycle throws', false, 'it did not throw');
    } catch (e) {
      check('a dependency cycle throws', e.message.indexOf('forms a cycle') !== -1, e.message);
    }
  });
}


function testMissingDependencyThrows() {
  withTemporaryNodes({
    tmpOrphan: { kind: 'move', name: 'tmpOrphan', dependsOn: ['nodeThatDoesNotExist'], source: { type: 'custom', fn: myCustomExtract } }
  }, function () {
    try {
      NotSoBigData.cli('list --select tmpOrphan');
      check('dependsOn on a missing node throws', false, 'it did not throw');
    } catch (e) {
      check('dependsOn on a missing node throws', e.message.indexOf('not a declared node') !== -1, e.message);
    }
  });
}


// The failure contract: the failed node is recorded, everything downstream
// is skipped transitively, and unrelated branches still run.
function testFailureSkipsDownstream() {
  withTemporaryNodes({
    tmpBoom: {
      kind: 'move', name: 'tmpBoom',
      source: { type: 'drive', fileId: 'this-is-not-a-real-drive-file-id', fileType: 'csv' }
    },
    tmpChild: { kind: 'move', name: 'tmpChild', dependsOn: ['tmpBoom'], source: { type: 'custom', fn: myCustomExtract } },
    tmpGrandchild: { kind: 'move', name: 'tmpGrandchild', dependsOn: ['tmpChild'], source: { type: 'custom', fn: myCustomExtract } },
    tmpUnrelated: { kind: 'move', name: 'tmpUnrelated', source: { type: 'custom', fn: myCustomExtract } }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpBoom,tmpChild,tmpGrandchild,tmpUnrelated');
    check('the broken node reports failed', statusOf(report, 'tmpBoom') === 'failed');
    check('its direct dependent is skipped', statusOf(report, 'tmpChild') === 'skipped');
    check('the skip propagates transitively', statusOf(report, 'tmpGrandchild') === 'skipped');
    check('an unrelated node still ran', statusOf(report, 'tmpUnrelated') === 'success');
    check('the report is marked not ok', report.ok === false);
  });
}


// The one failure mode this whole design has to guard against: a config
// object declared inside a function is invisible to the global scan. This
// is the automated version of "move a config into a function and see what
// happens" - it must stay invisible, and hello() must say so calmly.
function testFunctionScopedConfigIsInvisible() {
  var hiddenFromScan = {
    kind: 'move',
    name: 'hiddenFromScan',
    source: { type: 'custom', fn: myCustomExtract }
  };
  var message = NotSoBigData.cli('hello');
  check('a config declared inside a function is not discovered',
    message.indexOf('hiddenFromScan') === -1,
    'local variable was ' + (hiddenFromScan ? 'created' : 'not created') + ', and correctly not found by the scan');
  try {
    NotSoBigData.cli('list --select hiddenFromScan');
    check('selecting an undiscovered node throws', false, 'it did not throw');
  } catch (e) {
    check('selecting an undiscovered node throws', e.message.indexOf('matched no kind and no node name') !== -1, e.message);
  }
}


// Regression coverage for the "fetchProbe() must not let node options
// override muteHttpExceptions" fix (src/cli.md's fetchProbe() note, updated
// 2026-08-11). cli('debug') forces muteHttpExceptions:true internally so a
// non-2xx response never masks as an "error"/"missing_scope" - before this
// fix, a node whose own options set muteHttpExceptions:false (plausible if
// the same options object is reused for the real fetch and the probe)
// silently overrode that. This only exercises the "doesn't regress the
// normal ok path" half of the fix in real Apps Script - there is no
// fixture endpoint in this project that reliably returns a non-2xx status
// (every existing url/api fixture points at a reachable Script Property),
// so the actual bug (a non-2xx response getting misreported once
// muteHttpExceptions:false leaked through) was verified deterministically
// outside Apps Script instead: a standalone Node reproduction of
// fetchProbe()'s options-merge logic, confirming muteHttpExceptions stays
// true regardless of what a node's own options set.
function testDebugProbeIgnoresMuteHttpExceptionsOverride() {
  withTemporaryNodes({
    tmpDebugMuteOverride: {
      kind: 'move', name: 'tmpDebugMuteOverride',
      source: { type: 'api', url: P.API_SOURCE_URL_FLAT, options: { muteHttpExceptions: false } }
    }
  }, function () {
    var report = NotSoBigData.cli('debug --select tmpDebugMuteOverride');
    var sourceCheck = report.checks.filter(function (c) { return c.node === 'tmpDebugMuteOverride' && c.role === 'source'; })[0];
    check('a source declaring its own options.muteHttpExceptions: false still reports "ok", not misreported as an error',
      !!sourceCheck && sourceCheck.status === 'ok',
      sourceCheck ? JSON.stringify(sourceCheck) : 'check missing from report');
  });
}
