// 11-tests-extract.js — extract test category (see PROJECT.md; runAllTests('extract')).


// Runs a throwaway url-source node pointed at an arbitrary URL, for a test
// that needs to build the URL itself (P.URL_SOURCE_GITHUB_BLOB_CSV plus a
// suffix) rather than reusing a fixed top-level fixture.
function runOneCustomUrl(url) {
  return withTemporaryNodes({
    tmpCustomUrlExtract: { kind: 'move', name: 'tmpCustomUrlExtract', source: { type: 'url', url: url, fileType: 'csv' } }
  }, function () {
    return runOne('tmpCustomUrlExtract');
  });
}


// ===================================================================
// Tests — the move kind, extract
// ===================================================================

function testExtractSheets() {
  testLog(runOne('extractSheets'));
}


function testExtractDriveCsv() {
  testLog(runOne('extractDriveCsv'));
}


function testExtractDriveXlsx() {
  testLog(runOne('extractDriveXlsx'));
}


function testExtractDriveJson() {
  testLog(runOne('extractDriveJson'));
}


function testExtractApiFlat() {
  var rows = runOne('extractApiFlat');
  testLog('header: ' + rows[0] + '; ' + (rows.length - 1) + ' data rows');
}


function testExtractApiNested() {
  var rows = runOne('extractApiNested');
  var addressIndex = rows[0].indexOf('address');
  var cell = rows[1][addressIndex];
  check('nested "address" field is stringified into its cell, not a raw object',
    typeof cell === 'string', 'got ' + typeof cell + ': ' + cell);
  var parsed = JSON.parse(cell);
  check('the stringified cell round-trips back to the original nested shape',
    parsed && typeof parsed.city === 'string', JSON.stringify(parsed));
}


function testExtractApiEnveloped() {
  var rows = runOne('extractApiEnveloped');
  check('envelope unwrapped GitHub\'s {"items": [...]} into real data rows', rows.length > 1, 'got ' + rows.length + ' row(s) total');
}


function testExtractApiPaginated() {
  var rows = runOne('extractApiPaginated');
  check('pagination walked all 3 single-row pages of the test_orders sample',
    rows.length - 1 === 3, 'got ' + (rows.length - 1) + ' data row(s), expected 3');
}


// maxPages caps the walk before the sample's natural end (3 pages, one row
// each) - proves the safety cap actually stops the loop rather than just
// being validated and ignored. Same real BigQuery endpoint as
// extractApiPaginated above, just capped to 1 page instead of 10.
function testExtractApiPaginatedRespectsMaxPages() {
  withTemporaryNodes({
    tmpPaginatedCapped: {
      kind: 'move', name: 'tmpPaginatedCapped',
      source: {
        type: 'api',
        url: bigQueryTableDataUrl(),
        options: { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } },
        envelope: 'rows',
        pagination: { param: 'pageToken', tokenPath: 'pageToken', maxPages: 1 }
      }
    }
  }, function () {
    var rows = runOne('tmpPaginatedCapped');
    check('maxPages stopped the walk after 1 page', rows.length - 1 === 1, 'got ' + (rows.length - 1) + ' data row(s), expected 1');
  });
}


// Both reject-fast checks below use P.API_SOURCE_URL_FLAT only as a valid
// "url" to satisfy the source's own required-field check - extractPaginated
// validates tokenPath/maxPages before ever calling fetchPage, so neither
// test actually reaches the network.
function testExtractApiPaginationRejectsMissingTokenPath() {
  withTemporaryNodes({
    tmpNoTokenPath: {
      kind: 'move', name: 'tmpNoTokenPath',
      source: { type: 'api', url: P.API_SOURCE_URL_FLAT, pagination: { param: 'page', maxPages: 5 } }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpNoTokenPath');
    check('pagination without tokenPath is rejected', error.indexOf('tokenPath') !== -1, error);
  });
}


function testExtractApiPaginationRejectsMissingMaxPages() {
  withTemporaryNodes({
    tmpNoMaxPages: {
      kind: 'move', name: 'tmpNoMaxPages',
      source: { type: 'api', url: P.API_SOURCE_URL_FLAT, pagination: { param: 'page', tokenPath: 'nextPageToken' } }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpNoMaxPages');
    check('pagination without maxPages is rejected', error.indexOf('maxPages') !== -1, error);
  });
}


function testExtractApiPaginationRejectsMissingParam() {
  withTemporaryNodes({
    tmpNoParam: {
      kind: 'move', name: 'tmpNoParam',
      source: { type: 'api', url: P.API_SOURCE_URL_FLAT, pagination: { tokenPath: 'nextPageToken', maxPages: 5 } }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpNoParam');
    check('api source pagination without "param" is rejected', error.indexOf('"param"') !== -1, error);
  });
}


function testExtractCustom() {
  testLog(runOne('extractCustom'));
}


function testExtractCustomRejectsNonFunction() {
  withTemporaryNodes({
    tmpNotAFunction: { kind: 'move', name: 'tmpNotAFunction', source: { type: 'custom', fn: 'myCustomExtract' } }
  }, function () {
    var error = runOneExpectingFailure('tmpNotAFunction');
    check('a custom source needs a function, not a name', error.indexOf('to be a function') !== -1, error);
  });
}


function testExtractCustomRejectsBadShape() {
  withTemporaryNodes({
    tmpBadShape: { kind: 'move', name: 'tmpBadShape', source: { type: 'custom', fn: myCustomExtractBadShape } }
  }, function () {
    var error = runOneExpectingFailure('tmpBadShape');
    check('a custom source must return a 2D array', error.indexOf('2D array') !== -1, error);
  });
}


function testExtractUrlCsv() {
  testLog(runOne('extractUrlCsv'));
}


// Proves rewriteGithubBlobUrl() actually fires and lands on the same
// content as the equivalent raw.githubusercontent.com URL, not just that
// the blob-form URL happens to also work on its own.
function testExtractUrlGithubBlob() {
  var viaBlob = runOne('extractUrlGithubBlob');
  var viaRaw = runOne('extractUrlCsv');
  check('a github.com blob URL is rewritten to raw.githubusercontent.com and fetches the same content',
    JSON.stringify(viaBlob) === JSON.stringify(viaRaw),
    'blob-form fetch returned ' + viaBlob.length + ' row(s), raw-form returned ' + viaRaw.length + ' row(s)');
}


// Regression coverage for the "rewriteGithubBlobUrl() must not forward
// query string/fragment" fix (src/move.md's dated note on the same
// function). A blob URL copied with a trailing "?raw=true" (the exact
// suffix GitHub's own UI appends to some blob links) or a "#L10-L20"
// line-range fragment used to carry that suffix straight into the
// rewritten raw.githubusercontent.com URL. This only proves the fix
// doesn't regress the happy path (fetches the same content either way,
// with the query/fragment correctly dropped before the raw URL is built)
// - it can't prove the original bug via an observable live-HTTP failure,
// since raw.githubusercontent.com happens to tolerate an unrecognized
// trailing query string/fragment without erroring either way. The actual
// URL-construction bug (a query string ending up forwarded at all) was
// verified deterministically outside Apps Script instead: a standalone
// Node reproduction of rewriteGithubBlobUrl()'s own regex/split logic.
function testExtractUrlGithubBlobWithQueryStringAndFragment() {
  var withQuery = runOneCustomUrl(P.URL_SOURCE_GITHUB_BLOB_CSV + '?raw=true');
  var withFragment = runOneCustomUrl(P.URL_SOURCE_GITHUB_BLOB_CSV + '#L1-L5');
  var viaRaw = runOne('extractUrlCsv');
  check('a blob URL with a trailing "?query" still fetches the plain raw file content',
    JSON.stringify(withQuery) === JSON.stringify(viaRaw),
    'query-suffixed fetch returned ' + withQuery.length + ' row(s), raw-form returned ' + viaRaw.length + ' row(s)');
  check('a blob URL with a trailing "#fragment" still fetches the plain raw file content',
    JSON.stringify(withFragment) === JSON.stringify(viaRaw),
    'fragment-suffixed fetch returned ' + withFragment.length + ' row(s), raw-form returned ' + viaRaw.length + ' row(s)');
}


function testExtractUrlJson() {
  var rows = runOne('extractUrlJson');
  testLog('header: ' + rows[0] + '; ' + (rows.length - 1) + ' data rows');
}


// Exercises the temp-Google-Sheet conversion path. Check the notsobigdata
// Drive folder by hand after running this - the temp file it creates
// (named notsobigdata-xlsx-import-<uuid>) must be gone afterward, same as
// extractDriveXlsx's own temp copy.
function testExtractUrlXlsx() {
  testLog(runOne('extractUrlXlsx'));
}


function testExtractUrlRejectsUnsupportedFileType() {
  withTemporaryNodes({
    tmpUrlUnsupportedFileType: {
      kind: 'move', name: 'tmpUrlUnsupportedFileType',
      source: { type: 'url', url: P.URL_SOURCE_CSV, fileType: 'txt' }
    }
  }, function () {
    var error = runOneExpectingFailure('tmpUrlUnsupportedFileType');
    check('an unsupported url source fileType is rejected',
      error.indexOf('unsupported url source fileType') !== -1, error);
  });
}
