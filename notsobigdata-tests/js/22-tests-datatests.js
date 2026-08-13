// 22-tests-datatests.js — datatests test category (see PROJECT.md; runAllTests('datatests')).


// ===================================================================
// Tests — the move kind, data tests (config.tests)
// ===================================================================

// onFailure: 'raise' (the default) aborts the node like any other move()
// misconfiguration, which means a dependent node is skipped exactly the
// same way testFailureSkipsDownstream already proves for a broken
// connector - this is the same failure-propagation contract, just
// triggered by a failed data test instead.
function testDataTestsRaiseBlocksDownstream() {
  withTemporaryNodes({
    tmpTestsRaise: {
      kind: 'move', name: 'tmpTestsRaise',
      source: { type: 'custom', fn: myCustomExtractForDataTests },
      tests: [{ column: 'status', check: 'accepted_values', values: ['open', 'closed', 'refunded'] }]
    },
    tmpTestsRaiseChild: {
      kind: 'move', name: 'tmpTestsRaiseChild',
      dependsOn: ['tmpTestsRaise'],
      source: { type: 'custom', fn: myCustomExtract }
    }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpTestsRaise,tmpTestsRaiseChild');
    var failedNode = report.nodes.filter(function (n) { return n.name === 'tmpTestsRaise'; })[0];
    check('a failing "raise" test fails the node', statusOf(report, 'tmpTestsRaise') === 'failed', failedNode && failedNode.error);
    check('the failure names the failing check', failedNode && failedNode.error.indexOf('accepted_values') !== -1, failedNode && failedNode.error);
    check('a dependent node is skipped, same as any other move() failure', statusOf(report, 'tmpTestsRaiseChild') === 'skipped');
  });
}


// onFailure: 'discard_row' drops just the offending row and lets the node
// succeed with the rest - unlike the "raise" case above, nothing
// downstream is blocked.
function testDataTestsDiscardRowKeepsGoodRows() {
  withTemporaryNodes({
    tmpTestsDiscard: {
      kind: 'move', name: 'tmpTestsDiscard',
      source: { type: 'custom', fn: myCustomExtractForDataTests },
      tests: [{ column: 'status', check: 'accepted_values', values: ['open', 'closed', 'refunded'] }],
      onTestFailure: 'discard_row'
    }
  }, function () {
    var rows = runOne('tmpTestsDiscard');
    check('the bad row was dropped, the good rows kept', rows.length === 3,
      JSON.stringify(rows) + ' (expected header + 2 good rows)');
    check('testResults reports what was discarded',
      !!rows.testResults && rows.testResults.discarded === 1, JSON.stringify(rows.testResults));
  });
}


// not_null and unique checked together against the same fixture (one
// blank order_id, one duplicate) - both failures should be named in a
// single combined error, since every declared test runs before "raise"
// decides anything.
function testDataTestsNotNullAndUnique() {
  withTemporaryNodes({
    tmpTestsUniqueness: {
      kind: 'move', name: 'tmpTestsUniqueness',
      source: { type: 'custom', fn: myCustomExtractForUniquenessTest },
      tests: [
        { column: 'order_id', check: 'not_null' },
        { column: 'order_id', check: 'unique' }
      ]
    }
  }, function () {
    var error = runOneExpectingFailure('tmpTestsUniqueness');
    check('both not_null and unique failures are named in one combined error',
      error.indexOf('not_null') !== -1 && error.indexOf('unique') !== -1, error);
  });
}


// A test naming a column that doesn't exist is a config mistake, reported
// clearly - same posture as every other move() misconfiguration.
function testDataTestsUnknownColumnThrows() {
  withTemporaryNodes({
    tmpTestsBadColumn: {
      kind: 'move', name: 'tmpTestsBadColumn',
      source: { type: 'custom', fn: myCustomExtract },
      tests: [{ column: 'thisColumnDoesNotExist', check: 'not_null' }]
    }
  }, function () {
    var error = runOneExpectingFailure('tmpTestsBadColumn');
    check('an unknown test column is reported clearly', error.indexOf('no such column') !== -1, error);
  });
}


// ===================================================================
// Tests — release/6 review regressions
//
// A check name shaped like an Object.prototype property (e.g.
// "constructor") used to pass validateTest's "is this known" guard on a
// plain {} lookup, and then always report every row as passing - the
// worst possible failure mode for a data-quality feature. This proves the
// fix: the check is rejected outright, the same as any other unknown
// check name.
// ===================================================================

function testDataTestsPrototypeShapedCheckNameIsRejected() {
  withTemporaryNodes({
    tmpTestsProtoCheck: {
      kind: 'move', name: 'tmpTestsProtoCheck',
      source: { type: 'custom', fn: myCustomExtractForDataTests },
      tests: [{ column: 'status', check: 'constructor' }]
    }
  }, function () {
    var error = runOneExpectingFailure('tmpTestsProtoCheck');
    check('a check name shaped like an Object.prototype property is rejected, not silently always-passing',
      error.indexOf('unsupported "check"') !== -1, error);
  });
}


// A misconfigured test used to pass silently whenever the extract came
// back with zero rows, since validation ran after the empty-data
// short-circuit instead of before it.
function testDataTestsValidatedEvenWhenExtractIsEmpty() {
  withTemporaryNodes({
    tmpTestsBadOnEmptyExtract: {
      kind: 'move', name: 'tmpTestsBadOnEmptyExtract',
      source: { type: 'custom', fn: myCustomExtractEmpty },
      tests: [{ column: 'status', check: 'not_a_real_check' }]
    }
  }, function () {
    var error = runOneExpectingFailure('tmpTestsBadOnEmptyExtract');
    check('a misconfigured test throws even against an empty extract',
      error.indexOf('unsupported "check"') !== -1, error);
  });
}


// Number('') and Number(null) are both 0 in JS, so a blank cell used to
// silently satisfy a min/max test as if it actually held zero.
function testDataTestsMinTreatsBlankAsMissingNotZero() {
  withTemporaryNodes({
    tmpTestsMinBlank: {
      kind: 'move', name: 'tmpTestsMinBlank',
      source: { type: 'custom', fn: function () { return [['amount'], ['10'], ['']]; } },
      tests: [{ column: 'amount', check: 'min', value: 0 }]
    }
  }, function () {
    var error = runOneExpectingFailure('tmpTestsMinBlank');
    check('a blank cell fails a min test instead of passing as 0', error.indexOf('"min"') !== -1, error);
  });
}


// An invalid regex pattern used to only surface as a raw SyntaxError,
// buried inside the per-row loop, on whichever run first had data to
// check it against.
function testDataTestsInvalidRegexPatternThrowsClearly() {
  withTemporaryNodes({
    tmpTestsBadRegex: {
      kind: 'move', name: 'tmpTestsBadRegex',
      source: { type: 'custom', fn: myCustomExtractForDataTests },
      tests: [{ column: 'status', check: 'regex', pattern: '[unterminated' }]
    }
  }, function () {
    var error = runOneExpectingFailure('tmpTestsBadRegex');
    check('an invalid regex pattern is reported as a move() config error, not a raw SyntaxError',
      error.indexOf('invalid "pattern"') !== -1, error);
  });
}
