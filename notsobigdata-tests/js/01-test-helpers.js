// 01-test-helpers.js — Assertion helpers shared by every test file below.

// ===================================================================
// Assertion helpers
// ===================================================================

// Set (and reset) by runAllTests() around the tests it runs, so a whole
// run logs just its overall summary instead of every PASS/FAIL line and
// every ad hoc Logger.log a test makes along the way. Running a single
// test function directly from the editor (QUIET_TESTS is false by
// default) still logs everything - that per-step detail is exactly what
// you want once you already know which test failed and are looking at it
// on its own.
var QUIET_TESTS = false;

// Logs the result and *throws* on failure, which is the whole point: it
// used to only log and return a boolean, so runAllTests - which reports a
// test as OK whenever it didn't throw - printed OK for tests whose
// assertions had all failed. A suite that can go green while failing is
// worse than no suite, and this project found out the expensive way: a
// data-loss bug in the empty-extract guards survived a fully green run
// because its three tests asserted against a source shape that was already
// empty, and nothing about the output said so.
//
// The tradeoff is that a test stops at its first failed assertion instead
// of reporting all of them. Worth it. runAllTests catches per test, so the
// rest of the suite still runs, and withTemporaryNodes cleans up in a
// finally block, so a throw here can't leave a poisoned node behind.
function check(label, passed, detail) {
  var line = (passed ? 'PASS' : 'FAIL') + ': ' + label + (detail ? ' - ' + detail : '');
  if (!QUIET_TESTS) {
    Logger.log(line);
  }
  if (!passed) {
    throw new Error(line);
  }
  return passed;
}

// Same idea as check() above but for a test's own informational
// Logger.log calls (e.g. "here's what got extracted") rather than a
// PASS/FAIL assertion - gated by the same QUIET_TESTS flag so those don't
// spam a runAllTests() run either.
function testLog(message) {
  if (!QUIET_TESTS) {
    Logger.log(message);
  }
}

// Runs exactly one declared node and hands back what it produced. Every
// fixture in this project is a top-level var, so a bare cli('run') would
// fire all of them at once - selecting by name is how a single test
// exercises a single node.
function runOne(name) {
  var report = NotSoBigData.cli('run --select ' + name);
  var node = report.nodes[0];
  if (!node || node.status !== 'success') {
    throw new Error(name + ' reported "' + (node ? node.status : 'missing') + '"' + (node && node.error ? ': ' + node.error : ''));
  }
  return node.result;
}

// Runs a node that is expected to fail, and returns its error message.
function runOneExpectingFailure(name) {
  var report = NotSoBigData.cli('run --select ' + name);
  var node = report.nodes[0];
  if (!node || node.status !== 'failed') {
    throw new Error(name + ' was expected to fail but reported "' + (node ? node.status : 'missing') + '".');
  }
  return node.error;
}

function statusOf(report, name) {
  var match = report.nodes.filter(function (node) { return node.name === name; })[0];
  return match ? match.status : 'missing';
}

// Declares temporary nodes for the duration of fn(). The tests that need a
// *broken* graph - a dependency cycle, a node that always throws - use this
// rather than declaring those at the top level, because a permanently
// broken node would make every plain cli('run') fail. Assigning onto
// globalThis is the same thing a top-level "var" does as far as cli()'s
// scan is concerned, and the finally block keeps a failed assertion from
// leaving a poisoned node behind for every later test.
function withTemporaryNodes(nodes, fn) {
  Object.keys(nodes).forEach(function (key) { globalThis[key] = nodes[key]; });
  try {
    return fn();
  } finally {
    Object.keys(nodes).forEach(function (key) { delete globalThis[key]; });
  }
}
