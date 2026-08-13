// 03-fixtures-extract.js — Declared move() nodes with a source but no target — nothing is written,
// these only prove extraction works. Backs the 'extract'/'bigquery' test categories.

// ===================================================================
// Declared nodes — extract only (no target, so nothing is written)
// ===================================================================

var extractSheets = {
  kind: 'move',
  name: 'extractSheets',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE }
};

var extractDriveCsv = {
  kind: 'move',
  name: 'extractDriveCsv',
  source: { type: 'drive', fileId: P.DRIVE_CSV_FILE_ID, fileType: 'csv' }
};

var extractDriveXlsx = {
  kind: 'move',
  name: 'extractDriveXlsx',
  source: { type: 'drive', fileId: P.DRIVE_XLSX_FILE_ID, fileType: 'xlsx' }
};

var extractDriveJson = {
  kind: 'move',
  name: 'extractDriveJson',
  source: { type: 'drive', fileId: P.DRIVE_JSON_FILE_ID, fileType: 'json' }
};

var extractBigQueryTable = {
  kind: 'move',
  name: 'extractBigQueryTable',
  source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_TABLE }
};

var extractBigQueryQuery = {
  kind: 'move',
  name: 'extractBigQueryQuery',
  source: {
    type: 'bigquery',
    projectId: P.BIGQUERY_PROJECT_ID,
    query: 'SELECT customer, SUM(amount) AS total FROM ' + P.BIGQUERY_DATASET + '.' + P.BIGQUERY_TABLE + ' GROUP BY customer'
  }
};

var extractBigQueryQueryFile = {
  kind: 'move',
  name: 'extractBigQueryQueryFile',
  source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, queryFileId: P.BIGQUERY_QUERY_FILE_ID }
};

var extractApiFlat = {
  kind: 'move',
  name: 'extractApiFlat',
  source: { type: 'api', url: P.API_SOURCE_URL_FLAT }
};

// Edge case: each object has nested objects (address, company). Since the
// objectsToRows fix for the "[object Object]" data-loss bug, these no
// longer pass through as raw JS objects - they land as JSON.stringify'd
// text in their cell, so writing them to any target is now safe.
var extractApiNested = {
  kind: 'move',
  name: 'extractApiNested',
  source: { type: 'api', url: P.API_SOURCE_URL_NESTED }
};

// "envelope" only, no pagination - GitHub's search API wraps its results
// as {"items": [...], "total_count": ...} instead of a bare array. No auth,
// no Script Properties beyond the URL itself needed.
var extractApiEnveloped = {
  kind: 'move',
  name: 'extractApiEnveloped',
  source: { type: 'api', url: P.API_SOURCE_URL_ENVELOPED, envelope: 'items' }
};

// BigQuery's own tabledata.list REST endpoint - shared by extractApiPaginated
// below and the maxPages-cap test further down, so both hit the same real,
// 3-row test_orders sample the same way. maxResults=1 forces one row per
// page, so a correct unlimited walk makes exactly 3 requests.
function bigQueryTableDataUrl() {
  return 'https://www.googleapis.com/bigquery/v2/projects/' + P.BIGQUERY_PROJECT_ID +
    '/datasets/' + P.BIGQUERY_DATASET + '/tables/' + P.BIGQUERY_TABLE + '/data?maxResults=1';
}

// "envelope" + "pagination" together, against a real multi-page Google
// REST API - BigQuery's own tabledata.list endpoint, reusing the
// BIGQUERY_* properties and the script's own OAuth token (same
// ScriptApp.getOAuthToken() pattern loadDriveXlsx already uses elsewhere in
// this file). maxResults=1 forces one row per page against the 3-row
// test_orders sample, so a correct run makes 3 real requests and the
// pagination test below can assert on that exact count. Each row still
// arrives in BigQuery's raw {f: [{v: ...}, ...]} cell-wrapper shape (the
// same shape extractBigQuery unwraps by hand) - this fixture is proving
// the pagination/envelope plumbing walks every page correctly, not
// producing directly-usable output; a real pipeline reading BigQuery
// would use a "bigquery" source instead; this is only useful when you
// need to hand-authenticate against a REST API that happens to be
// BigQuery's.
var extractApiPaginated = {
  kind: 'move',
  name: 'extractApiPaginated',
  source: {
    type: 'api',
    url: bigQueryTableDataUrl(),
    options: { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } },
    envelope: 'rows',
    pagination: { param: 'pageToken', tokenPath: 'pageToken', maxPages: 10 }
  }
};

var extractCustom = {
  kind: 'move',
  name: 'extractCustom',
  source: { type: 'custom', fn: myCustomExtract }
};

var extractUrlCsv = {
  kind: 'move',
  name: 'extractUrlCsv',
  source: { type: 'url', url: P.URL_SOURCE_CSV, fileType: 'csv' }
};

// Same file as extractUrlCsv, but the blob-form URL GitHub's own file-view
// UI gives you - proves rewriteGithubBlobUrl() fires and the fetch still
// lands on the same raw content.
var extractUrlGithubBlob = {
  kind: 'move',
  name: 'extractUrlGithubBlob',
  source: { type: 'url', url: P.URL_SOURCE_GITHUB_BLOB_CSV, fileType: 'csv' }
};

var extractUrlJson = {
  kind: 'move',
  name: 'extractUrlJson',
  source: { type: 'url', url: P.URL_SOURCE_JSON, fileType: 'json' }
};

// Exercises the temp-Google-Sheet xlsx conversion path (extractUrlXlsx) -
// check the notsobigdata Drive folder after running this to confirm the
// temp file it creates was also cleaned up, not just that the run passed.
var extractUrlXlsx = {
  kind: 'move',
  name: 'extractUrlXlsx',
  source: { type: 'url', url: P.URL_SOURCE_XLSX, fileType: 'xlsx' }
};

// Reject-fast check: an unsupported fileType on a url source should throw
// the same readable error the drive source already gives, not something
// more cryptic that leaks how the extractor is implemented. The
// deliberately-failing node itself is declared inside
// testExtractUrlRejectsUnsupportedFileType via withTemporaryNodes, not here
// as a permanent top-level var - a permanently broken node would fail every
// plain cli('run'), same reasoning as the bigquery control nodes in
// 06-fixtures-bigquery-targets.js (this one was missed and broke
// testRunEverything until caught).
