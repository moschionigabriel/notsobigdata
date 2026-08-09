// Flattens an array of plain objects into a 2D array: a header row made
// from the union of every element's keys (not just the first element's —
// JSON/API payloads commonly have optional fields that only show up on
// some records), followed by one row per element. Keys an element doesn't
// have become blank cells rather than throwing. A value that's itself an
// object or array (a nested field like the YouTube Data API's snippet/
// statistics) is JSON.stringify'd into its cell rather than flattened
// into further columns - see the comment inline below for why.
function objectsToRows(objects) {
  // Checked before the emptiness test, not after: an envelope like
  // {"data": [...]} - the most common JSON API shape there is - has no
  // .length, so it slips past an emptiness check and dies inside reduce()
  // with "objects.reduce is not a function". Every other misconfiguration
  // in this file reports itself with a "move(): ..." message; this one
  // should too, since the fix (unwrap the envelope) isn't obvious from a
  // raw TypeError.
  if (!Array.isArray(objects)) {
    throw new Error(
      'move(): expected a JSON array of objects, got ' +
      (objects === null ? 'null' : typeof objects) +
      '. If the payload wraps its rows in an envelope like {"data": [...]}, ' +
      'unwrap it first with a "custom" source.'
    );
  }
  if (objects.length === 0) {
    return [];
  }
  var headers = objects.reduce(function (keys, obj) {
    Object.keys(obj).forEach(function (key) {
      if (keys.indexOf(key) === -1) {
        keys.push(key);
      }
    });
    return keys;
  }, []);
  var rows = [headers].concat(objects.map(function (obj) {
    return headers.map(function (key) {
      var value = obj[key];
      if (value === undefined) {
        return '';
      }
      // Nested object/array values pass straight through the
      // union-of-keys flattening above - it only looks at top-level
      // keys. Left as a raw JS object, the cell is lossy everywhere
      // downstream: rowsToCsv() stringifies with String(), which turns
      // any object into the literal text "[object Object]" - not an
      // error, just silently wrong data reaching the bigquery/drive-csv
      // targets - and Range.setValues() (sheets/drive-xlsx) has no
      // defined behavior for a raw object cell either. JSON.stringify
      // keeps the value inspectable as real JSON text and turns the
      // cell into a plain string primitive before it reaches any
      // target, fixing every exposure at once. null is excluded on
      // purpose - JSON.stringify(null) is the text "null", which would
      // replace today's correct behavior (a raw null renders as a
      // blank cell in rowsToCsv) with the literal word "null" showing
      // up instead.
      return (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value;
    });
  }));
  return rows;
}

// Looks up a dot-path ('items', 'data.results') inside a parsed JSON
// value. Shared by the api source's "envelope" (where the row array lives
// in the response body) and "pagination.tokenPath" (where the next-page
// token lives) - both are "find this value somewhere inside a nested
// object" in the same way, just pointed at different paths. Walks off the
// end of a missing branch by returning undefined rather than throwing, so
// a token path that's absent on the last page (the normal way a paginated
// API says "no more pages") reads as "no next token" instead of a crash.
//
// Checked with hasOwnProperty rather than a plain value[key] lookup - a
// path segment that names an inherited Object.prototype member (a real
// page shaped {"nextPageToken": ...} has no key literally called
// "constructor", but a tokenPath typo'd or copy-pasted as "constructor"
// would otherwise resolve to the built-in Object constructor instead of
// undefined) must still read as "not found", the same lesson this file
// already learned once from CELL_CHECKS/KNOWN_CHECKS (see move.md).
function resolvePath(obj, path) {
  return path.split('.').reduce(function (value, key) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, key)) {
      return undefined;
    }
    return value[key];
  }, obj);
}

// True when a grid holds no actual content - either no rows at all, or
// nothing but blank cells.
//
// This exists because "no data" doesn't arrive as [] from every source.
// Sheets never hands back an empty grid: getValues() on an empty sheet or
// a misconfigured range returns [['']] - one row, one blank cell - and
// Utilities.parseCsv('') does the same. Counted naively that is "1 row of
// data", which sails straight past the guards below that stop a target
// being wiped by an empty extract (they all test rows.length === 0).
//
// So every extractor that can produce this shape normalizes it to [],
// which is already what the objectsToRows path returns for an empty
// payload. One contract, one meaning: an extract with no data is [].
function isBlankGrid(rows) {
  return !rows.length || rows.every(function (row) {
    return row.every(function (cell) {
      return cell === '' || cell === null || cell === undefined;
    });
  });
}

function extractSheets(source) {
  if (!source.spreadsheetId) {
    throw new Error('move(): sheets source requires "spreadsheetId".');
  }
  var spreadsheet = SpreadsheetApp.openById(source.spreadsheetId);
  var range = source.range
    ? spreadsheet.getRange(source.range)
    : spreadsheet.getActiveSheet().getDataRange();
  var values = range.getValues();
  return isBlankGrid(values) ? [] : values;
}

// Reads a Drive file's full text content. Shared by the drive csv/json
// extractors and the bigquery queryFileId mode, so there's one place that
// knows how to turn a Drive file id into text.
function readDriveFileText(fileId) {
  return DriveApp.getFileById(fileId).getBlob().getDataAsString();
}

function extractDriveCsv(fileId) {
  var values = Utilities.parseCsv(readDriveFileText(fileId));
  return isBlankGrid(values) ? [] : values;
}

function extractDriveJson(fileId) {
  return objectsToRows(JSON.parse(readDriveFileText(fileId)));
}

// Apps Script has no native XLSX parser, so this converts the file to a
// temporary Google Sheet via the Advanced Drive Service, reads it with
// SpreadsheetApp, and always deletes the temp copy afterward — including
// on error — so a failed extract never leaves an orphan file in the
// user's Drive. Sets both "name" (Drive API v3) and "title" (v2), since
// which one the Advanced Drive Service expects depends on the API
// version configured in the consumer's appsscript.json — the unused one
// is simply ignored by whichever version is active.
function extractDriveXlsx(fileId) {
  var tempFileName = 'notsobigdata-xlsx-import-' + fileId;
  var tempFileMetadata = Drive.Files.copy(
    { name: tempFileName, title: tempFileName, mimeType: MimeType.GOOGLE_SHEETS },
    fileId
  );
  try {
    var spreadsheet = SpreadsheetApp.openById(tempFileMetadata.id);
    var values = spreadsheet.getActiveSheet().getDataRange().getValues();
    return isBlankGrid(values) ? [] : values;
  } finally {
    Drive.Files.remove(tempFileMetadata.id);
  }
}

function extractDrive(source) {
  if (!source.fileId) {
    throw new Error('move(): drive source requires "fileId".');
  }
  switch (source.fileType) {
    case 'csv':
      return extractDriveCsv(source.fileId);
    case 'json':
      return extractDriveJson(source.fileId);
    case 'xlsx':
      return extractDriveXlsx(source.fileId);
    default:
      throw new Error('move(): unsupported drive source fileType "' + source.fileType + '". Expected "csv", "json", or "xlsx".');
  }
}

// A URL pasted straight from the GitHub UI points at an HTML page
// (github.com/.../blob/...), not the file's raw bytes - rewriting it to
// the equivalent raw.githubusercontent.com URL is the one host-specific
// convenience the url source makes, so a link copied out of a browser tab
// works without the pipeline author having to know "raw" links exist.
// Anything that isn't that exact shape (including an already-raw URL, or
// any non-GitHub host - Kaggle included, which needs authenticated API
// access this library deliberately doesn't take on) passes through
// unchanged.
function rewriteGithubBlobUrl(url) {
  var match = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/.exec(url);
  return match ? 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2] + '/' + match[3] : url;
}

// Fetches a URL's body as text. Shared by extractUrlCsv/Json below - the
// url source's equivalent of readDriveFileText.
function readUrlText(url, options) {
  var response = UrlFetchApp.fetch(url, options || {});
  assertHttpOk(response, 'move(): url source request to "' + url + '" failed');
  return response.getContentText();
}

function extractUrlCsv(url, options) {
  var values = Utilities.parseCsv(readUrlText(url, options));
  return isBlankGrid(values) ? [] : values;
}

function extractUrlJson(url, options) {
  return objectsToRows(JSON.parse(readUrlText(url, options)));
}

// Mirrors extractDriveXlsx's temp-Google-Sheet trick, but starting from a
// fetched blob instead of an existing Drive file id: Drive.Files.insert
// converts on upload when given a GOOGLE_SHEETS mimeType, same as
// Files.copy does on an existing file. The temp file lives in the user's
// own Drive only for the duration of this call and is always removed,
// including on error, so a failed conversion never leaves an orphan
// behind - same guarantee extractDriveXlsx makes for its own temp copy.
function extractUrlXlsx(url, options) {
  var response = UrlFetchApp.fetch(url, options || {});
  assertHttpOk(response, 'move(): url source request to "' + url + '" failed');
  var tempFileName = 'notsobigdata-xlsx-import-' + Utilities.getUuid();
  var tempFileMetadata = Drive.Files.insert(
    { name: tempFileName, title: tempFileName, mimeType: MimeType.GOOGLE_SHEETS },
    response.getBlob()
  );
  try {
    var spreadsheet = SpreadsheetApp.openById(tempFileMetadata.id);
    var values = spreadsheet.getActiveSheet().getDataRange().getValues();
    return isBlankGrid(values) ? [] : values;
  } finally {
    Drive.Files.remove(tempFileMetadata.id);
  }
}

function extractUrl(source) {
  if (!source.url) {
    throw new Error('move(): url source requires "url".');
  }
  var url = rewriteGithubBlobUrl(source.url);
  switch (source.fileType) {
    case 'csv':
      return extractUrlCsv(url, source.options);
    case 'json':
      return extractUrlJson(url, source.options);
    case 'xlsx':
      return extractUrlXlsx(url, source.options);
    default:
      throw new Error('move(): unsupported url source fileType "' + source.fileType + '". Expected "csv", "json", or "xlsx".');
  }
}

// Resolves the SQL text for a bigquery source: a whole table (existing
// behavior, backward compatible), a raw query string, or a query read
// from a Drive .sql file. Exactly one of table/query/queryFileId must be
// given - mixing modes is almost certainly a config mistake worth
// surfacing rather than silently picking one.
function resolveBigQuerySql(source) {
  var modes = ['table', 'query', 'queryFileId'].filter(function (key) { return !!source[key]; });
  if (modes.length !== 1) {
    throw new Error('move(): bigquery source needs exactly one of "table" (with "dataset"), "query", or "queryFileId" - got ' + (modes.length === 0 ? 'none' : modes.join(', ')) + '.');
  }
  if (!source.projectId) {
    throw new Error('move(): bigquery source requires "projectId".');
  }
  if (source.table) {
    if (!source.dataset) {
      throw new Error('move(): bigquery source with "table" also requires "dataset".');
    }
    return 'SELECT * FROM ' + qualifiedTableRef(source.projectId, source.dataset, source.table);
  }
  if (source.query) {
    return source.query;
  }
  return readDriveFileText(source.queryFileId);
}

// Backtick-quotes a project.dataset.table identifier for interpolation
// into SQL - the one shared form for a BigQuery relation, reused
// everywhere this library builds one: a bigquery source's own table
// above, {{ this }} in runSqlTests below, and model.js's model/ref
// relations. One function means all three agree on the same quoting by
// construction rather than three copies staying in sync by hand.
function qualifiedTableRef(projectId, dataset, table) {
  return '`' + projectId + '.' + dataset + '.' + table + '`';
}

// Strips SQL comments and a trailing ";" - shared by assertReadOnlySelect
// below and assertSingleStatement, so the two checks that read pipeline-
// author-supplied SQL agree on what "the statement" is before either one
// judges it.
function stripSqlComments(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .replace(/;\s*$/, '');
}

// The actual check, taking sql already stripped by stripSqlComments -
// split out from assertSingleStatement below so assertReadOnlySelect can
// reuse the stripped string it already computed for its own SELECT/WITH
// check instead of stripping the same SQL a second time.
function assertSingleStatementStripped(stripped, messagePrefix) {
  if (stripped.indexOf(';') !== -1) {
    throw new Error(messagePrefix + ' must be a single statement - multi-statement scripts (separated by ";") are not allowed.');
  }
}

// Rejects multiple ";"-separated statements. Split out of
// assertReadOnlySelect below so model() can reuse just this half - a
// model is meant to write, so it has no read-only requirement to check,
// but it should still reject a multi-statement script the same way move()
// does. messagePrefix is the caller's own full "move(): ..."/"model(): ..."
// lead-in, so the thrown message reads the same regardless of which
// module raised it.
function assertSingleStatement(sql, messagePrefix) {
  assertSingleStatementStripped(stripSqlComments(sql), messagePrefix);
}

// Guards against a piece of pipeline-author-supplied SQL doing anything
// other than a single read statement. This is a footgun-preventing
// keyword/shape check, not a security boundary: it only strips comments,
// looks at the leading keyword, and rejects multiple ";"-separated
// statements, so it won't catch e.g. a SELECT that calls a mutating
// stored routine.
//
// messagePrefix is the caller's own complete "move(): ..."/"model(): ..."
// lead-in - same convention assertSingleStatement below already uses -
// rather than a bare "context" this function prefixes itself, so the
// thrown message reads the same regardless of which module or which kind
// of SQL (a bigquery source's query, a bigquery target's sqlTests[].query,
// or a model's own tests[].query - runSqlTests below hands every one of
// those through here) raised it.
function assertReadOnlySelect(sql, messagePrefix) {
  var stripped = stripSqlComments(sql);
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error(messagePrefix + ' must be a read-only SELECT (optionally starting with WITH) - it can check data, not change it.');
  }
  assertSingleStatementStripped(stripped, messagePrefix);
}

// Runs a BigQuery query job (Jobs.query) to completion and returns
// whichever response - the initial Jobs.query call, or the last
// getQueryResults poll - ended up job-complete. A caller that wants more
// than that one page (extractBigQuery below) walks pageToken itself from
// there. getQueryResults itself long-polls (waits) for job completion up
// to its own timeout - unlike a load/copy job's plain status check,
// which is why runBigQueryJob above has to back off polling itself - so
// there's no need to sleep client-side between these calls too.
// queryRequest.maxResults, if given, is carried over to every poll call,
// not just the first: the point of setting it at all is a caller that
// only wants a bounded first page (runSqlTests below), and a maxResults
// that stopped applying the moment a job needed more than one poll to
// finish would defeat that.
function runBigQueryQueryJob(queryRequest, projectId) {
  var queryResults = BigQuery.Jobs.query(queryRequest, projectId);
  var jobId = queryResults.jobReference.jobId;
  var pollParams = queryRequest.maxResults ? { maxResults: queryRequest.maxResults } : undefined;
  while (!queryResults.jobComplete) {
    queryResults = pollParams
      ? BigQuery.Jobs.getQueryResults(projectId, jobId, pollParams)
      : BigQuery.Jobs.getQueryResults(projectId, jobId);
  }
  return queryResults;
}

// Reads from BigQuery via the Advanced BigQuery Service - either a whole
// table or the result of a read-only query. The table identifier is
// backtick-quoted since it's interpolated into SQL text, even though
// it's the pipeline author's own declared config, not runtime user
// input. Once the job is done, results are read page by page via
// pageToken so a result set bigger than a single response page isn't
// silently truncated.
function extractBigQuery(source) {
  var sql = resolveBigQuerySql(source);
  assertReadOnlySelect(sql, 'move(): bigquery source.query/queryFileId');
  var queryResults = runBigQueryQueryJob({ query: sql, useLegacySql: false }, source.projectId);
  var jobId = queryResults.jobReference.jobId;

  var headers = queryResults.schema.fields.map(function (field) { return field.name; });
  var rows = [headers];
  var pageToken = null;
  do {
    if (pageToken) {
      queryResults = BigQuery.Jobs.getQueryResults(source.projectId, jobId, { pageToken: pageToken });
    }
    var apiRows = queryResults.rows || [];
    rows = rows.concat(apiRows.map(function (row) {
      return row.f.map(function (cell) { return cell.v; });
    }));
    pageToken = queryResults.pageToken;
  } while (pageToken);

  // A query that matched nothing still comes back with a schema, so rows is
  // [headers] at this point: one row, zero data. Left as-is it would defeat
  // every empty-extract guard downstream and let a WRITE_TRUNCATE load job
  // empty the destination table on the morning an upstream source is late -
  // exactly the unattended-run scenario those guards exist for. Same
  // contract as everywhere else: no data means [].
  if (rows.length === 1) {
    return [];
  }
  return rows;
}

// Adds a query-string parameter to a URL, whether or not it already has
// one - used to attach a resolved pagination token to each page after the
// first. Both the param name and value are URI-encoded since a token is
// server-generated, opaque data, not something move()'s caller composed
// by hand.
function appendQueryParam(url, param, value) {
  var separator = url.indexOf('?') === -1 ? '?' : '&';
  return url + separator + encodeURIComponent(param) + '=' + encodeURIComponent(value);
}

// Walks a cursor-paginated API: calls fetchPage(token) - undefined on the
// first call, then whatever resolvePath(page, options.tokenPath) found on
// the page before it - until that token comes back undefined (tokenPath
// wasn't present on that page at all) or explicit null (tokenPath was
// present but the API set it to null - the other common way a
// cursor-paginated REST API signals "no more pages", alongside just
// omitting the field) - or options.maxPages pages have been fetched,
// whichever comes first.
// Written knowing nothing about HTTP on purpose - fetchPage just has to
// hand back one page's parsed body - even though extractApi below is
// currently its only caller: cli.js's IIFE exposes only cli() (see
// CLAUDE.md, "One public entrypoint"), so this function itself is not
// reachable from a "custom" source's fn the way extractApi's other pieces
// aren't either; a custom source wrapping a native Advanced Service call
// (e.g. YouTube.Search.list()) would have to walk its own pages by hand.
// Every page's rows are accumulated as plain objects and only turned into
// a 2D array once, at the end, via one objectsToRows() call - so the
// header row is the union of every page's keys, the same "optional
// fields don't throw" behavior objectsToRows already gives a single page.
//
// options.maxPages is required, not defaulted, the same fail-loud posture
// as assertReadOnlySelect/resolveBigQuerySql: an API that never stops
// returning a next-page token (a bug on its end, or a misconfigured
// tokenPath that keeps re-reading the same value) would otherwise loop
// until Apps Script's own execution-time limit kills the run.
function extractPaginated(fetchPage, options) {
  if (!options || typeof options.tokenPath !== 'string' || !options.tokenPath) {
    throw new Error('move(): pagination requires "tokenPath".');
  }
  if (typeof options.maxPages !== 'number' || options.maxPages < 1) {
    throw new Error('move(): pagination requires "maxPages" (a positive number) as a safety cap on how many pages to fetch.');
  }
  var allObjects = [];
  var token;
  var pageCount = 0;
  do {
    var page = fetchPage(token);
    var pageObjects = options.envelope ? resolvePath(page, options.envelope) : page;
    if (!Array.isArray(pageObjects)) {
      throw new Error('move(): pagination envelope "' + options.envelope + '" did not resolve to an array on page ' + (pageCount + 1) + '.');
    }
    allObjects = allObjects.concat(pageObjects);
    token = resolvePath(page, options.tokenPath);
    pageCount++;
  } while (token !== undefined && token !== null && pageCount < options.maxPages);
  return objectsToRows(allObjects);
}

// Expects the API to respond with a JSON array of objects, using the same
// key-union flattening as Drive JSON sources - unless "envelope" says the
// array lives somewhere else in the body (e.g. 'items' for a response
// shaped {"items": [...]}), which resolvePath digs out first. Omitting
// "envelope" is byte-identical to this function's original behavior: the
// body itself must already be the array, and objectsToRows' own error
// message is what points a caller at "envelope" (or a "custom" source) if
// it isn't.
//
// "pagination" (optional: {param, tokenPath, maxPages}) hands the actual
// page-walking off to extractPaginated above - this function's only job
// is supplying fetchPage: build the next page's URL by attaching the
// previous page's resolved token as a query param (the first call has no
// token yet, so it fetches source.url unchanged), fetch it, and parse the
// JSON body. See extractPaginated's own comment for why maxPages is
// required whenever pagination is used at all.
function extractApi(source) {
  if (!source.url) {
    throw new Error('move(): api source requires "url".');
  }
  function fetchOnePage(token) {
    var url = token === undefined ? source.url : appendQueryParam(source.url, source.pagination.param, token);
    var response = UrlFetchApp.fetch(url, source.options || {});
    assertHttpOk(response, 'move(): api source request to "' + url + '" failed');
    return JSON.parse(response.getContentText());
  }
  if (source.pagination) {
    if (!source.pagination.param) {
      throw new Error('move(): api source "pagination" requires "param" (the query-string parameter to set with the resolved token on subsequent requests).');
    }
    return extractPaginated(fetchOnePage, {
      envelope: source.envelope,
      tokenPath: source.pagination.tokenPath,
      maxPages: source.pagination.maxPages
    });
  }
  var parsed = fetchOnePage();
  return objectsToRows(source.envelope ? resolvePath(parsed, source.envelope) : parsed);
}

// Runs a user-supplied extractor function from the caller's own Apps
// Script project. source.fn is a direct function reference (not a name
// to look up in global scope) since the config object is built in the
// same scope where the user's function already lives - no eval/global
// lookup needed. The user owns making sure fn's logic is correct; its
// return shape is checked by extract(), same as every other source type.
function extractCustom(source) {
  if (typeof source.fn !== 'function') {
    throw new Error('move(): custom source requires "fn" to be a function - got ' + typeof source.fn + '.');
  }
  return source.fn(source);
}

// Every extractor is expected to return a 2D array (an array of arrays) -
// the same contract move() promises its callers. Checked once, here, for
// every source type, rather than each extractor re-implementing the
// check (or, worse, only some of them checking).
function assertRows(rows, sourceType) {
  if (!Array.isArray(rows) || !rows.every(function (row) { return Array.isArray(row); })) {
    throw new Error('move(): "' + sourceType + '" extractor must return a 2D array (an array of arrays).');
  }
  return rows;
}

function extract(source) {
  switch (source.type) {
    case 'sheets':
      return assertRows(extractSheets(source), 'sheets');
    case 'drive':
      return assertRows(extractDrive(source), 'drive');
    case 'bigquery':
      return assertRows(extractBigQuery(source), 'bigquery');
    case 'api':
      return assertRows(extractApi(source), 'api');
    case 'url':
      return assertRows(extractUrl(source), 'url');
    case 'custom':
      return assertRows(extractCustom(source), 'custom');
    default:
      throw new Error('move(): unsupported source type "' + source.type + '". Expected "sheets", "drive", "bigquery", "api", "url", or "custom".');
  }
}

// Writes a 2D array into a sheet - either "overwrite" (default: clear
// the target area, then write rows starting at its top-left cell) or
// "append" (write rows after the current last row, leaving existing
// content alone). Overwrite is the default here because the common case
// is refreshing a sheet to reflect the latest extract, and undoing an
// accidental overwrite in a spreadsheet is cheap - unlike loadBigQuery
// below, whose default leans the other way for exactly the opposite
// reason.
//
// target.range scopes both modes to part of the sheet instead of the
// whole tab, the same idea as source.range on the extract side - but
// NOT the same notation: this is resolved via sheet.getRange(), which
// (unlike spreadsheet.getRange(), what source.range uses) only accepts
// a plain, sheet-relative range like "B2:D10" - no "SheetName!" prefix,
// since target.sheetName above already picked the sheet. In "overwrite"
// mode only that literal range is cleared, not the entire sheet (which
// may hold other tables or notes); in "append" mode it only pins the
// starting column, since the starting row always comes from the sheet's
// actual last row regardless. Tradeoff worth knowing: clearing only the
// literal given range means if a prior run wrote more rows than this
// run does, cells past the range from that prior run won't get cleared
// - that's the price of not nuking the rest of the sheet on every
// overwrite. Omit target.range to keep the old whole-sheet-clear
// behavior.
//
// target.includeHeader (default true) only matters in "append" mode:
// set it false to append rows.slice(1) instead of the full array,
// skipping the header move() always puts at rows[0] - otherwise every
// append duplicates the header row in the middle of the sheet.
//
// In "overwrite" mode, the clear step only runs when rows is non-empty -
// an empty extract (flaky source, empty query result, misconfigured
// range) leaves existing sheet content alone instead of wiping it out
// for nothing. Same guarding principle as loadBigQuery's WRITE_TRUNCATE
// skip below, applied here since sheets has no equivalent skip-the-job
// escape hatch to lean on.
function loadSheets(rows, target) {
  if (!target.spreadsheetId) {
    throw new Error('move(): sheets target requires "spreadsheetId".');
  }
  var mode = target.mode || 'overwrite';
  if (mode !== 'overwrite' && mode !== 'append') {
    throw new Error('move(): unsupported sheets target mode "' + mode + '". Expected "overwrite" or "append".');
  }

  var spreadsheet = SpreadsheetApp.openById(target.spreadsheetId);
  var sheet = target.sheetName
    ? (spreadsheet.getSheetByName(target.sheetName) || spreadsheet.insertSheet(target.sheetName))
    : spreadsheet.getActiveSheet();

  var startRow = 1;
  var startColumn = 1;
  var anchor = target.range ? sheet.getRange(target.range) : null;
  if (anchor) {
    startRow = anchor.getRow();
    startColumn = anchor.getColumn();
  }

  if (mode === 'overwrite' && rows.length > 0) {
    if (anchor) {
      anchor.clearContent();
    } else {
      sheet.clearContents();
    }
  }

  var rowsToWrite = (mode === 'append' && target.includeHeader === false) ? rows.slice(1) : rows;
  if (mode === 'append' && rowsToWrite.length > 0) {
    startRow = sheet.getLastRow() + 1;
  }
  if (rowsToWrite.length > 0) {
    sheet.getRange(startRow, startColumn, rowsToWrite.length, rowsToWrite[0].length).setValues(rowsToWrite);
  }
  return { spreadsheetId: target.spreadsheetId, sheetName: sheet.getName(), startRow: startRow, startColumn: startColumn, numRows: rowsToWrite.length };
}

// Serializes a 2D array to CSV text, quoting only cells that need it.
// Shared by the drive csv target and the bigquery load job below, which
// uploads its data as CSV too.
function rowsToCsv(rows) {
  return rows.map(function (row) {
    return row.map(function (cell) {
      var value = cell === null || cell === undefined ? '' : String(cell);
      if (/[",\n]/.test(value)) {
        value = '"' + value.replace(/"/g, '""') + '"';
      }
      return value;
    }).join(',');
  }).join('\n');
}

// Reverses objectsToRows: turns a header row + data rows back into an
// array of plain objects, keyed by the header. Shared by the drive json
// target and the api target, which both expect objects rather than raw
// rows on the way out - mirroring what their extract-side counterparts
// expect on the way in.
function rowsToObjects(rows) {
  if (rows.length === 0) {
    return [];
  }
  var headers = rows[0];
  return rows.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (key, i) {
      obj[key] = row[i];
    });
    return obj;
  });
}

// Resolves which existing file (if any) a drive target should overwrite:
// "fileId" directly, if given; otherwise, if target.upsertByName is set,
// a by-name lookup within target.folderId. Returns null when there's
// nothing to overwrite yet, meaning the caller should create a new file
// instead. Drive allows duplicate filenames, so a lookup that finds more
// than one match throws rather than guessing which one to overwrite -
// delete the duplicates or pass "fileId" explicitly instead.
function resolveDriveTargetFileId(target) {
  if (target.fileId || !target.upsertByName) {
    return target.fileId || null;
  }
  if (!target.folderId || !target.fileName) {
    throw new Error('move(): drive target with "upsertByName" requires both "folderId" and "fileName".');
  }
  var matches = DriveApp.getFolderById(target.folderId).getFilesByName(target.fileName);
  if (!matches.hasNext()) {
    return null;
  }
  var fileId = matches.next().getId();
  if (matches.hasNext()) {
    throw new Error('move(): drive target "upsertByName" found more than one file named "' + target.fileName + '" in the given folder - move() won\'t guess which one to overwrite. Delete the duplicates or pass "fileId" explicitly instead.');
  }
  return fileId;
}

// Resolves a drive target down to either an existing file to overwrite
// (via resolveDriveTargetFileId above) or confirmation there's enough
// to create a new one instead ("folderId" + "fileName") - one shared
// validation for both cases, called before any expensive work (CSV/JSON
// serialization, building a temp xlsx export) so a misconfigured target
// throws before that work happens rather than after. Returns the file
// id to overwrite, or null when the caller should create a new file.
function resolveDriveWriteTarget(target) {
  var fileId = resolveDriveTargetFileId(target);
  if (!fileId && (!target.folderId || !target.fileName)) {
    throw new Error('move(): drive target requires either "fileId" (to overwrite an existing file) or both "folderId" and "fileName" (to create - or with "upsertByName", find-or-create - one).');
  }
  return fileId;
}

// Writes text content to an already-resolved drive target: overwrite
// fileId if given, otherwise create a new file from target.folderId +
// target.fileName (both already validated by resolveDriveWriteTarget).
// Shared by the drive csv and json targets, which only differ in how
// they serialize rows and which mimeType they create a new file with.
function writeDriveText(fileId, target, content, mimeType) {
  if (fileId) {
    DriveApp.getFileById(fileId).setContent(content);
    return fileId;
  }
  return DriveApp.getFolderById(target.folderId).createFile(target.fileName, content, mimeType).getId();
}

// True when a drive target has an existing file to protect (a resolved
// fileId) and nothing was extracted to replace its content with - the
// case where loadDriveCsv/loadDriveJson/loadDriveXlsx should each skip
// their destructive write and hand the existing fileId back untouched,
// rather than overwriting real data with an empty file. A brand-new file
// (no fileId yet) still gets created even with zero rows, since there's
// no prior data at risk in that case - so this only fires when fileId is
// truthy.
function isEmptyDriveOverwrite(fileId, rows) {
  return !!(fileId && rows.length === 0);
}

function loadDriveCsv(rows, target) {
  var fileId = resolveDriveWriteTarget(target);
  if (isEmptyDriveOverwrite(fileId, rows)) {
    return fileId;
  }
  return writeDriveText(fileId, target, rowsToCsv(rows), MimeType.CSV);
}

function loadDriveJson(rows, target) {
  var fileId = resolveDriveWriteTarget(target);
  if (isEmptyDriveOverwrite(fileId, rows)) {
    return fileId;
  }
  return writeDriveText(fileId, target, JSON.stringify(rowsToObjects(rows)), MimeType.PLAIN_TEXT);
}

// Throws a descriptive move() error if a UrlFetchApp response wasn't a
// 2xx. Shared by loadDriveXlsx's xlsx export fetch below and loadApi
// further down.
function assertHttpOk(response, messagePrefix) {
  var responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(messagePrefix + ' (HTTP ' + responseCode + ').');
  }
}

// Builds the xlsx file via a temporary Google Sheet (Apps Script has no
// native XLSX writer, mirroring extractDriveXlsx's use of a temp copy in
// the opposite direction). DriveApp's getAs() converter does NOT support
// Google Sheets -> xlsx (confirmed by hand: it throws "Converting from
// application/vnd.google-apps.spreadsheet ... is not supported"), even
// though the Sheets UI's own File > Download > .xlsx does the same
// conversion - so this fetches the same export endpoint the UI uses
// instead, authenticated with the script's own OAuth token. That token
// already carries Drive scope regardless, from this file's other
// Drive.Files.* calls (Apps Script scopes the whole project, not per
// function), so this doesn't add a new permission requirement.
// Overwriting an existing file (via resolveDriveWriteTarget, same as
// the csv/json targets) does need the Advanced Drive Service, though -
// unlike csv/json, DriveApp has no way to replace a file's binary
// content in place, only Drive.Files.update() does. The temp sheet is
// always deleted afterward (permanently, via Drive.Files.remove - the
// same cleanup extractDriveXlsx uses for its own temp copy), including
// on error.
// Same empty-extract guard as loadDriveCsv/loadDriveJson above: skip
// building/exporting the temp spreadsheet entirely when there's an
// existing file to protect and rows is empty.
function loadDriveXlsx(rows, target) {
  var fileId = resolveDriveWriteTarget(target);
  if (isEmptyDriveOverwrite(fileId, rows)) {
    return fileId;
  }
  var tempSpreadsheet = SpreadsheetApp.create('notsobigdata-xlsx-export-' + Utilities.getUuid());
  try {
    if (rows.length > 0) {
      tempSpreadsheet.getActiveSheet().getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    }
    SpreadsheetApp.flush();
    var exportUrl = 'https://docs.google.com/spreadsheets/d/' + tempSpreadsheet.getId() + '/export?format=xlsx';
    var response = UrlFetchApp.fetch(exportUrl, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    assertHttpOk(response, 'move(): failed to export the temporary sheet as xlsx');
    var blob = response.getBlob();
    if (fileId) {
      Drive.Files.update({}, fileId, blob);
      return fileId;
    }
    return DriveApp.getFolderById(target.folderId).createFile(blob.setName(target.fileName)).getId();
  } finally {
    Drive.Files.remove(tempSpreadsheet.getId());
  }
}

function loadDrive(rows, target) {
  switch (target.fileType) {
    case 'csv':
      return loadDriveCsv(rows, target);
    case 'json':
      return loadDriveJson(rows, target);
    case 'xlsx':
      return loadDriveXlsx(rows, target);
    default:
      throw new Error('move(): unsupported drive target fileType "' + target.fileType + '". Expected "csv", "json", or "xlsx".');
  }
}

// Inserts a BigQuery load or copy job, then polls its status - backing
// off the sleep between checks (500ms up to a 5s cap) so a longer-running
// job doesn't cost dozens of Jobs.get round trips at a fixed interval -
// until it reaches DONE, throwing if it finished with an error. Shared by
// every place this file runs a BigQuery write-side job: loadBigQuery's
// direct load, and loadBigQueryStaged's staging load and promotion copy
// below. blob is only meaningful for a load job (a copy job has no data
// to upload, just table references) - pass null/undefined for a copy.
// jobKind ("load"/"copy") only shapes the thrown error message.
function runBigQueryJob(jobConfiguration, projectId, blob, jobKind) {
  var insertedJob = blob
    ? BigQuery.Jobs.insert(jobConfiguration, projectId, blob)
    : BigQuery.Jobs.insert(jobConfiguration, projectId);
  var jobId = insertedJob.jobReference.jobId;
  var status = insertedJob.status;
  var pollIntervalMs = 500;
  while (status.state !== 'DONE') {
    Utilities.sleep(pollIntervalMs);
    pollIntervalMs = Math.min(pollIntervalMs * 2, 5000);
    status = BigQuery.Jobs.get(projectId, jobId).status;
  }
  if (status.errorResult) {
    throw new Error('move(): bigquery ' + jobKind + ' job failed - ' + status.errorResult.message);
  }
  return jobId;
}

// Resolves a bigquery target's "mode" down to the writeDisposition it
// maps to. Shared by loadBigQuery's direct path and loadBigQueryStaged's
// promotion copy below - both need the exact same append/overwrite
// decision, just applied to a different kind of job.
function resolveBigQueryWriteDisposition(mode) {
  var writeDisposition = mode === 'overwrite' ? 'WRITE_TRUNCATE' : mode === 'append' ? 'WRITE_APPEND' : null;
  if (!writeDisposition) {
    throw new Error('move(): unsupported bigquery target mode "' + mode + '". Expected "overwrite" or "append".');
  }
  return writeDisposition;
}

// Resolves target.allowSchemaEvolution + a job's writeDisposition down to
// the schemaUpdateOptions array to attach to a load job's config (or
// undefined to attach nothing) - used only by loadBigQuery's direct load
// path below. NOT used by loadBigQueryStaged's promotion copy job:
// schemaUpdateOptions was tried there too originally, but confirmed by
// hand (against a real project) not to work on a copy job the way it
// does on a load job - see widenDestinationTableForPromotion above,
// which is what the staged path actually uses instead. Takes
// writeDisposition rather than mode directly: "append" and
// "WRITE_APPEND" carry the same fact, and writeDisposition is already
// what the caller has in hand by the time it needs this. Gated to
// WRITE_APPEND specifically because WRITE_TRUNCATE already replaces the
// destination schema wholesale every run - the option would be a no-op
// there, so it's simply not attached rather than thrown on as a
// harmless combination.
function resolveBigQuerySchemaUpdateOptions(target, writeDisposition) {
  return (target.allowSchemaEvolution && writeDisposition === 'WRITE_APPEND')
    ? ['ALLOW_FIELD_ADDITION', 'ALLOW_FIELD_RELAXATION']
    : undefined;
}

// Builds a load job's "configuration.load" body: the shared shape both
// loadBigQuery's direct load and loadBigQueryStaged's staging load use,
// differing only in destination table and writeDisposition.
//
// target.schema is an optional array of BigQuery field defs (e.g.
// [{name: 'order_id', type: 'STRING'}]) to use instead of
// autodetect: true. Autodetect infers types from the CSV header/values,
// which can guess wrong for things like a zero-padded id column
// ("007") silently becoming an INTEGER - pass target.schema when that
// matters; omit it and behavior is unchanged.
function buildBigQueryLoadConfig(destinationTable, writeDisposition, target) {
  var loadConfig = {
    destinationTable: destinationTable,
    sourceFormat: 'CSV',
    skipLeadingRows: 1,
    writeDisposition: writeDisposition
  };
  if (target.schema) {
    loadConfig.schema = { fields: target.schema };
  } else {
    loadConfig.autodetect = true;
  }
  return loadConfig;
}

// Builds a unique staging table id for loadBigQueryStaged below. BigQuery
// table ids only allow letters, digits, and underscores - unlike the
// Drive filenames this project already builds the same way
// (loadDriveXlsx's 'notsobigdata-xlsx-export-' + Utilities.getUuid(),
// where dashes are fine), so getUuid()'s dashes are stripped here.
function resolveStagingTableId(table) {
  return '_notsobigdata_stage_' + table + '_' + Utilities.getUuid().replace(/-/g, '');
}

// Runs a list of {name, query} SQL tests against one relation, substituting
// "{{ this }}" - deliberately reusing dbt's own name for "the table this
// test is about" - with relationRef's fully-qualified, backtick-quoted
// name. Each query is expected to return the rows that violate whatever
// it's checking (referential integrity, an aggregate/volume check, ...);
// zero rows back means the test passed, mirroring dbt's own generic-test
// contract. Gated through assertReadOnlySelect for the same reason a
// bigquery source's query is: this SQL runs under the script's live
// OAuth, and a sql test is pipeline-author-supplied text, not move()'s
// or model()'s own.
//
// Shared by move.js's own loadBigQueryStaged below (relationRef names a
// brand-new staging table) and model.js's model() (relationRef names the
// model's own just-materialized relation) - genuinely the same primitive
// either way: run these queries against that relation, fail loudly if any
// comes back non-empty. messagePrefix is the caller's own complete
// "move(): ..."/"model(): ..." lead-in, same convention
// assertSingleStatement/assertReadOnlySelect already use, so the thrown
// message and every per-entry error reads right regardless of which
// module or which kind of test (a bigquery target's sqlTests, or a
// model's tests) raised it.
//
// Only a bounded first page is read via runBigQueryQueryJob's
// maxResults - getQueryResults already reports totalRows regardless of
// page size, so answering "did any rows come back" (and showing a few
// examples) doesn't need to pull a potentially huge offending-row set
// over the wire just to keep 5 of them, the way an uncapped request
// would for a referential check that legitimately finds thousands of
// violations. Every declared test still runs even after one has already
// failed - collected, not thrown on first sight - so one call surfaces
// every failing test at once, the same posture runTests() takes for
// config.tests. There is no "discard_row" here (yet): a sql test finding
// bad rows can't cheaply undo the write it's checking the way runTests()
// filters an in-memory array before anything is written, and no real user
// has needed it yet - the same "not built speculatively" call move.md
// already makes for referential checks in general.
function runSqlTests(sqlTests, relationRef, messagePrefix) {
  var thisRef = qualifiedTableRef(relationRef.projectId, relationRef.dataset, relationRef.table);
  var failures = [];
  sqlTests.forEach(function (test) {
    if (!test || typeof test.query !== 'string' || !test.query) {
      throw new Error(messagePrefix + ': every entry needs a "query" (a non-empty string).');
    }
    var query = test.query.replace(/\{\{\s*this\s*\}\}/g, thisRef);
    assertReadOnlySelect(query, messagePrefix + '[].query');
    var queryResults = runBigQueryQueryJob({ query: query, useLegacySql: false, maxResults: 5 }, relationRef.projectId);
    var totalRows = Number(queryResults.totalRows || 0);
    if (totalRows > 0) {
      var exampleRows = (queryResults.rows || []).slice(0, 5).map(function (row) {
        return row.f.map(function (cell) { return cell.v; }).join(', ');
      });
      failures.push({ name: test.name || query, count: totalRows, exampleRows: exampleRows });
    }
  });
  if (failures.length) {
    var summary = failures.map(function (f) {
      return '"' + f.name + '" returned ' + f.count + ' failing row(s) (e.g. ' + f.exampleRows.join(' | ') + ')';
    }).join('; ');
    throw new Error(messagePrefix + ' failed against ' + thisRef + ' - ' + summary + '.');
  }
  return { ran: sqlTests.length };
}

// Widens the real destination table's schema to include any column the
// staged table has that it doesn't, by patching the table directly
// (Tables.patch) before loadBigQueryStaged's promotion copy job runs -
// not via the copy job's own schemaUpdateOptions, which was tried first
// and confirmed by hand, against a real project, not to work the way a
// load job's does: a copy job still rejected a schema mismatch with
// schemaUpdateOptions set, failing with "Provided Schema does not match
// Table ... Cannot add fields". Patching the destination ahead of time
// means the copy job never sees a mismatch to reject in the first
// place.
//
// Only additive (a new column, appended as NULLABLE - the only mode
// Tables.patch can add a column as). Does not attempt
// ALLOW_FIELD_RELAXATION's REQUIRED-to-NULLABLE case here - that was
// never confirmed working on either job kind (the schema-evolution
// feature's own GAS test only exercises field addition too) and isn't
// the bug this fixes. Don't assume it works without separately
// verifying it.
//
// If the destination table doesn't exist yet, Tables.get throws and this
// returns without patching anything - there's nothing to widen, and the
// copy job below creates the table fresh from the staged schema, the
// same as a load job would for a brand-new table.
function widenDestinationTableForPromotion(target, stagingTable) {
  var destination;
  try {
    destination = BigQuery.Tables.get(target.projectId, target.dataset, target.table);
  } catch (error) {
    return;
  }
  var existingNames = {};
  destination.schema.fields.forEach(function (field) { existingNames[field.name] = true; });
  var stagedFields = BigQuery.Tables.get(target.projectId, target.dataset, stagingTable).schema.fields;
  var newFields = stagedFields.filter(function (field) { return !existingNames[field.name]; });
  if (!newFields.length) {
    return;
  }
  BigQuery.Tables.patch(
    { schema: { fields: destination.schema.fields.concat(newFields) } },
    target.projectId, target.dataset, target.table
  );
}

// Stages rows into a brand-new scratch table, runs target.sqlTests
// against it, and only if every test passes promotes - via a BigQuery
// copy job, not a second CSV upload - into the real target. A failing
// sql test throws out of runSqlTests before promotion ever runs, so the
// table a pipeline actually reads from is never touched by a batch that
// failed its checks. See README.md's bigquery target section for the
// config shape.
//
// The staging table is created explicitly (BigQuery.Tables.insert)
// rather than left to the load job's own auto-create, specifically so an
// expirationTime can be set before any data lands - a durable,
// BigQuery-side cleanup guarantee that doesn't depend on this script
// execution ever reaching the finally block below. Apps Script's own
// execution-timeout kill doesn't guarantee a finally runs, and this
// project already learned the cost of an unattended process leaving
// scratch resources behind the hard way (see CLAUDE.md's "About
// testing" - Drive load-test fixtures piling up to 30 files before
// anyone noticed). The finally block is still the primary cleanup path;
// expirationTime is a backstop, not a substitute for it.
function loadBigQueryStaged(rows, target, writeDisposition) {
  var stagingTable = resolveStagingTableId(target.table);
  BigQuery.Tables.insert(
    {
      tableReference: { projectId: target.projectId, datasetId: target.dataset, tableId: stagingTable },
      expirationTime: String(Date.now() + 60 * 60 * 1000)
    },
    target.projectId,
    target.dataset
  );
  try {
    var blob = Utilities.newBlob(rowsToCsv(rows), 'text/csv');
    var stagingLoadConfig = buildBigQueryLoadConfig(
      { projectId: target.projectId, datasetId: target.dataset, tableId: stagingTable },
      'WRITE_TRUNCATE',
      target
    );
    var stagingJobId = runBigQueryJob({ configuration: { load: stagingLoadConfig } }, target.projectId, blob, 'load');

    var testResults = runSqlTests(target.sqlTests, { projectId: target.projectId, dataset: target.dataset, table: stagingTable }, 'move(): bigquery target.sqlTests');

    if (target.allowSchemaEvolution && writeDisposition === 'WRITE_APPEND') {
      widenDestinationTableForPromotion(target, stagingTable);
    }

    var copyConfig = {
      sourceTable: { projectId: target.projectId, datasetId: target.dataset, tableId: stagingTable },
      destinationTable: { projectId: target.projectId, datasetId: target.dataset, tableId: target.table },
      writeDisposition: writeDisposition
    };
    var promoteJobId = runBigQueryJob({ configuration: { copy: copyConfig } }, target.projectId, null, 'copy');

    return {
      projectId: target.projectId, dataset: target.dataset, table: target.table, jobId: promoteJobId,
      staged: { table: stagingTable, jobId: stagingJobId },
      sqlTestResults: testResults
    };
  } finally {
    BigQuery.Tables.remove(target.projectId, target.dataset, stagingTable);
  }
}

// Loads rows into a BigQuery table via a load job (data uploaded as CSV)
// rather than INSERT statements - the same approach BigQuery's own
// tooling uses for bulk loads. Defaults to "append" (WRITE_APPEND)
// rather than "overwrite" (WRITE_TRUNCATE): unlike loadSheets above,
// truncating a real table is destructive and hard to undo, so that mode
// must be opted into explicitly rather than risked by a missing "mode"
// key.
//
// target.allowSchemaEvolution (optional, default false) is BigQuery's
// own schemaUpdateOptions, opted into explicitly - same posture as
// "overwrite" mode above: destructive-adjacent behavior needs an
// explicit flag, not a default. Without it, a source that has grown a
// column the destination table doesn't have fails the load job outright
// (safe, but a hard stop until a human ALTERs the table by hand). With
// it, in "append" mode only, BigQuery is allowed to ALLOW_FIELD_ADDITION
// (a new column can appear) and ALLOW_FIELD_RELAXATION (an existing
// REQUIRED column can loosen to NULLABLE) as part of the load job -
// additive changes only. A real type change or a renamed/dropped column
// still fails the job either way; BigQuery itself has no
// schemaUpdateOptions for those, and silently coercing or dropping data
// would be worse than today's loud failure. See
// resolveBigQuerySchemaUpdateOptions above for why this is gated to
// "append" specifically, shared with loadBigQueryStaged's promotion
// copy job below.
//
// target.sqlTests (optional array of {name, query}) routes the whole
// load through loadBigQueryStaged above instead of the direct path
// below - stage, test, only then promote. Omit it (or leave it an empty
// array) and this function is byte-for-byte what it always was: a
// pipeline that doesn't ask for staging pays nothing extra for it.
function loadBigQuery(rows, target) {
  if (!target.projectId || !target.dataset || !target.table) {
    throw new Error('move(): bigquery target requires "projectId", "dataset", and "table".');
  }
  var mode = target.mode || 'append';
  var writeDisposition = resolveBigQueryWriteDisposition(mode);
  var result = { projectId: target.projectId, dataset: target.dataset, table: target.table, jobId: null };
  if (rows.length === 0) {
    return result;
  }
  if (target.sqlTests && target.sqlTests.length) {
    return loadBigQueryStaged(rows, target, writeDisposition);
  }
  var blob = Utilities.newBlob(rowsToCsv(rows), 'text/csv');
  var loadConfig = buildBigQueryLoadConfig(
    { projectId: target.projectId, datasetId: target.dataset, tableId: target.table },
    writeDisposition,
    target
  );
  var loadSchemaUpdateOptions = resolveBigQuerySchemaUpdateOptions(target, writeDisposition);
  if (loadSchemaUpdateOptions) {
    loadConfig.schemaUpdateOptions = loadSchemaUpdateOptions;
  }
  var jobId = runBigQueryJob({ configuration: { load: loadConfig } }, target.projectId, blob, 'load');
  result.jobId = jobId;
  return result;
}

// POSTs rows to an API endpoint as a JSON array of objects - the same
// shape extractApi expects to receive, so round-tripping data out to an
// API and back in stays symmetric. target.options can override the
// defaults (e.g. a different method or extra headers) since it's merged
// in after them. Returns the response's status and body so the caller
// can inspect what the endpoint sent back (e.g. a server-assigned id).
function loadApi(rows, target) {
  if (!target.url) {
    throw new Error('move(): api target requires "url".');
  }
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(rowsToObjects(rows))
  };
  if (target.options) {
    Object.keys(target.options).forEach(function (key) {
      options[key] = target.options[key];
    });
  }
  var response = UrlFetchApp.fetch(target.url, options);
  assertHttpOk(response, 'move(): api target request to "' + target.url + '" failed');
  return { statusCode: response.getResponseCode(), body: response.getContentText() };
}

// Runs a user-supplied loader function from the caller's own Apps
// Script project, same trust model as extractCustom: target.fn is a
// direct function reference, called as fn(rows, target) so it gets both
// the extracted data and whatever extra config keys the caller attached
// to the target. Its return value is passed straight through, mirroring
// extractCustom's contract on the extract side.
function loadCustom(rows, target) {
  if (typeof target.fn !== 'function') {
    throw new Error('move(): custom target requires "fn" to be a function - got ' + typeof target.fn + '.');
  }
  return target.fn(rows, target);
}

function load(rows, target) {
  switch (target.type) {
    case 'sheets':
      return loadSheets(rows, target);
    case 'drive':
      return loadDrive(rows, target);
    case 'bigquery':
      return loadBigQuery(rows, target);
    case 'api':
      return loadApi(rows, target);
    case 'custom':
      return loadCustom(rows, target);
    default:
      throw new Error('move(): unsupported target type "' + target.type + '". Expected "sheets", "drive", "bigquery", "api", or "custom".');
  }
}

// True when a cell holds "no value" - blank string, null, or undefined.
// Shared by every check below that needs to tell "no value" apart from a
// real value that happens to be falsy or zero - the same definition
// isBlankGrid above uses for a whole row.
function isBlankCell(value) {
  return value === '' || value === null || value === undefined;
}

// The check names this file understands. "unique" and "regex" aren't in
// CELL_CHECKS below - unique needs cross-row state, regex only needs its
// pattern compiled once, not once per cell - so this list, not CELL_CHECKS
// membership, is what tells validateTest/runOneTest a check name is known
// at all. Checked by array membership rather than object-property
// lookup deliberately: see CELL_CHECKS's own comment for why.
var KNOWN_CHECKS = ['not_null', 'unique', 'accepted_values', 'min', 'max', 'regex'];

function isKnownCheck(check) {
  return KNOWN_CHECKS.indexOf(check) !== -1;
}

// Per-cell checks that need no setup beyond the cell's own value (and the
// test's own extra config, e.g. "values" for accepted_values) - each
// returns pass/fail. Built with Object.create(null), and validateTest
// below checks membership in KNOWN_CHECKS rather than truthiness of
// CELL_CHECKS[test.check]: a plain {} literal indexed by a config-supplied
// string is a real hole, not a theoretical one - CELL_CHECKS['constructor']
// on a plain object resolves to the inherited Object constructor (truthy),
// which would pass validation and then always report every row as
// passing, since calling it just boxes the value instead of checking
// anything. "unique" and "regex" aren't here for a different reason: unique
// needs to see every value in the column before it can say which ones
// repeat, and regex only needs its pattern compiled once, not once per
// cell - runOneTest below handles both separately instead of forcing a
// stateful/one-time-setup check into this one-cell-at-a-time shape.
var CELL_CHECKS = Object.create(null);
CELL_CHECKS.not_null = function (value) {
  return !isBlankCell(value);
};
CELL_CHECKS.accepted_values = function (value, test) {
  return test.values.indexOf(value) !== -1;
};
CELL_CHECKS.min = function (value, test) {
  return !isBlankCell(value) && Number(value) >= test.value;
};
CELL_CHECKS.max = function (value, test) {
  return !isBlankCell(value) && Number(value) <= test.value;
};

// Extra config key each check needs beyond "column"/"check", so a typo'd
// or missing one (e.g. an accepted_values test with no "values") throws a
// clear "move(): ..." message from validateTest below instead of a raw
// TypeError two calls later. Object.create(null) for the same reason as
// CELL_CHECKS above - test.check is config-supplied, not a hardcoded key.
var TEST_CHECK_REQUIRES = Object.create(null);
TEST_CHECK_REQUIRES.accepted_values = 'values';
TEST_CHECK_REQUIRES.min = 'value';
TEST_CHECK_REQUIRES.max = 'value';
TEST_CHECK_REQUIRES.regex = 'pattern';

// Shared by validateTest (a per-test "onFailure") and runTests (the
// node-level "onTestFailure" default) so the two can't drift on what
// counts as a valid severity.
function isSupportedOnFailure(value) {
  return value === 'raise' || value === 'discard_row';
}

// Confirms one entry in config.tests is well-formed before it's run:
// column/check present, check is one this file knows, the check's own
// required extra key is there, a regex check's pattern actually compiles,
// and onFailure (if given) is a mode this file supports. All of this is
// checked up front, for every test, rather than discovered mid-run - a bad
// test should never pass silently just because the rows it would have
// flagged happened not to appear (runTests below calls this even when
// there are zero data rows to check, for exactly that reason).
function validateTest(test) {
  if (!test || typeof test.column !== 'string' || !test.column) {
    throw new Error('move(): every entry in "tests" needs a "column" (a non-empty string).');
  }
  if (typeof test.check !== 'string' || !isKnownCheck(test.check)) {
    throw new Error('move(): test on column "' + test.column + '" has an unsupported "check" ("' + test.check + '"). Expected one of: ' + KNOWN_CHECKS.join(', ') + '.');
  }
  var requiredKey = TEST_CHECK_REQUIRES[test.check];
  if (requiredKey && test[requiredKey] === undefined) {
    throw new Error('move(): test on column "' + test.column + '" (check "' + test.check + '") requires "' + requiredKey + '".');
  }
  if (test.check === 'accepted_values' && !Array.isArray(test.values)) {
    throw new Error('move(): test on column "' + test.column + '" (check "accepted_values") requires "values" to be an array.');
  }
  if (test.check === 'regex') {
    try {
      new RegExp(test.pattern);
    } catch (error) {
      throw new Error('move(): test on column "' + test.column + '" (check "regex") has an invalid "pattern" - ' + error.message + '.');
    }
  }
  if (test.onFailure !== undefined && !isSupportedOnFailure(test.onFailure)) {
    throw new Error('move(): test on column "' + test.column + '" has an unsupported "onFailure" ("' + test.onFailure + '"). Expected "raise" or "discard_row".');
  }
}

// Resolves a test's "column" to its index in the header row. A column
// name that doesn't exist is a config mistake, not a silent no-op - same
// posture as every other misconfiguration in this file.
function resolveTestColumn(headers, test) {
  var index = headers.indexOf(test.column);
  if (index === -1) {
    throw new Error('move(): test on column "' + test.column + '" (check "' + test.check + '") - no such column. Columns: ' + headers.join(', ') + '.');
  }
  return index;
}

// Runs one test against every data row (header already stripped), and
// returns the 0-based indexes into dataRows that failed it. "unique" is
// evaluated here rather than through CELL_CHECKS since it needs state
// across rows: a null-prototype map of values seen so far, so a value
// that happens to be "toString" or "__proto__" can't collide with the
// map's own prototype. Blank/null cells are exempt from "unique" - "no
// value" isn't a duplicate, and not_null already owns that check.
// "regex" is also handled here rather than through CELL_CHECKS, so its
// pattern is compiled once per test instead of once per cell -
// validateTest already confirmed it compiles, so this can't throw.
function runOneTest(dataRows, columnIndex, test) {
  var failing = [];
  if (test.check === 'unique') {
    var seen = Object.create(null);
    dataRows.forEach(function (row, i) {
      var value = row[columnIndex];
      if (isBlankCell(value)) {
        return;
      }
      var key = String(value);
      if (seen[key]) {
        failing.push(i);
      } else {
        seen[key] = true;
      }
    });
    return failing;
  }
  if (test.check === 'regex') {
    var pattern = new RegExp(test.pattern);
    dataRows.forEach(function (row, i) {
      if (!pattern.test(String(row[columnIndex]))) {
        failing.push(i);
      }
    });
    return failing;
  }
  var check = CELL_CHECKS[test.check];
  dataRows.forEach(function (row, i) {
    if (!check(row[columnIndex], test)) {
      failing.push(i);
    }
  });
  return failing;
}

// Validates the rows a node is about to load, with a per-test severity,
// instead of finding out only after bad data has landed. Every declared
// test's own shape is validated up front, unconditionally - even against
// an extract that came back with zero rows - so a bad test (a typo'd
// check name, a missing "values"/"value"/"pattern") never passes silently
// just because this particular run happened not to see any data to check
// it against. Only running the checks against real rows short-circuits on
// empty data, same "empty means nothing to check" convention as the rest
// of move().
//
// Once there is data, every declared test still runs regardless of
// severity - failing that first, rather than stopping at the first
// "raise" - so one call surfaces every violation at once instead of
// finding them one run at a time.
//
// "raise" (the default here, and every test's default unless it or
// config.onTestFailure says otherwise) throws one combined error naming
// every failing test - matching the fail-fast posture everywhere else in
// this file. "discard_row" drops just the rows that failed it and lets
// the rest through unchanged; a row failing more than one discard_row
// test is still only dropped once.
//
// Row numbers in thrown/reported messages are 1-indexed with the header
// counted as row 1 (dataRows[0] is row 2) - the same numbering a human
// would see looking at this data in a spreadsheet.
function runTests(rows, tests, defaultOnFailure) {
  if (!Array.isArray(tests)) {
    throw new Error('move(): "tests" must be an array of test objects.');
  }
  if (defaultOnFailure !== undefined && !isSupportedOnFailure(defaultOnFailure)) {
    throw new Error('move(): "onTestFailure" has an unsupported value ("' + defaultOnFailure + '"). Expected "raise" or "discard_row".');
  }
  tests.forEach(validateTest);
  if (!tests.length || rows.length === 0) {
    return rows;
  }

  var headers = rows[0];
  var dataRows = rows.slice(1);
  var raiseFailures = [];
  var discardedRows = Object.create(null);

  tests.forEach(function (test) {
    var columnIndex = resolveTestColumn(headers, test);
    var failing = runOneTest(dataRows, columnIndex, test);
    if (!failing.length) {
      return;
    }
    var onFailure = test.onFailure || defaultOnFailure || 'raise';
    if (onFailure === 'raise') {
      raiseFailures.push({
        column: test.column,
        check: test.check,
        count: failing.length,
        exampleRows: failing.slice(0, 5).map(function (i) { return i + 2; })
      });
    } else {
      failing.forEach(function (i) {
        discardedRows[i] = true;
      });
    }
  });

  if (raiseFailures.length) {
    var summary = raiseFailures.map(function (f) {
      return '"' + f.column + '" failed "' + f.check + '" on ' + f.count + ' row(s) (e.g. row ' + f.exampleRows.join(', ') + ')';
    }).join('; ');
    throw new Error('move(): data test(s) failed - ' + summary + '.');
  }

  var kept = dataRows.filter(function (row, i) { return !discardedRows[i]; });
  var discardedCount = dataRows.length - kept.length;
  if (discardedCount === 0) {
    rows.testResults = { ran: tests.length, discarded: 0 };
    return rows;
  }

  var result = [headers].concat(kept);
  result.testResults = { ran: tests.length, discarded: discardedCount };
  return result;
}

// Extracts a source into a 2D array, optionally checks it against
// config.tests, and, if a target is given, loads it there too.
// config.target is optional so extract-only calls keep working exactly as
// before - move() always returns the (possibly test-filtered) rows either
// way, so a caller can inspect or reuse them regardless. When a target
// *was* given, whatever that load function returned (a file id, a
// BigQuery job id, ...) is attached as rows.loadResult; when tests ran,
// the pass/discard summary is attached as rows.testResults - both extra
// properties on the array, not new elements, so they never show up in
// rows.length or get serialized by JSON.stringify(rows).
function move(config) {
  if (!config || !config.source) {
    throw new Error('move(): config.source is required.');
  }
  var rows = extract(config.source);
  if (config.tests) {
    rows = runTests(rows, config.tests, config.onTestFailure);
  }
  if (config.target) {
    rows.loadResult = load(rows, config.target);
  }
  return rows;
}
