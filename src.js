// GENERATED FILE - do not edit.
//
// Built from src/ by ./build.sh. Edit the modules there and rebuild;
// any change made here directly is lost on the next build.
//
// Modules, in order: move.js model.js cli.js
var NotSoBigData = (function () {
  // ==================================================================
  //   src/move.js
  // ==================================================================
  // Flattens an array of plain objects into a 2D array: a header row made
  // from the union of every element's keys (not just the first element's —
  // JSON/API payloads commonly have optional fields that only show up on
  // some records), followed by one row per element. Keys an element doesn't
  // have become blank cells rather than throwing.
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
        return value === undefined ? '' : value;
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
  function resolvePath(obj, path) {
    return path.split('.').reduce(function (value, key) {
      return (value === null || value === undefined) ? undefined : value[key];
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
      return 'SELECT * FROM `' + source.projectId + '.' + source.dataset + '.' + source.table + '`';
    }
    if (source.query) {
      return source.query;
    }
    return readDriveFileText(source.queryFileId);
  }

  // Guards against a bigquery source running anything other than a single
  // read statement. This is a footgun-preventing keyword/shape check, not a
  // security boundary: it only strips comments, looks at the leading
  // keyword, and rejects multiple ";"-separated statements, so it won't
  // catch e.g. a SELECT that calls a mutating stored routine. move()'s job
  // is extracting data - transforming/writing it belongs in model().
  function assertReadOnlySelect(sql) {
    var stripped = sql
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/;\s*$/, '');
    if (!/^(select|with)\b/i.test(stripped)) {
      throw new Error('move(): bigquery source.query/queryFileId must be a read-only SELECT (optionally starting with WITH). move() only extracts data - transform or write logic belongs in model().');
    }
    if (stripped.indexOf(';') !== -1) {
      throw new Error('move(): bigquery source.query/queryFileId must be a single statement - multi-statement scripts (separated by ";") are not allowed.');
    }
  }

  // Reads from BigQuery via the Advanced BigQuery Service - either a whole
  // table or the result of a read-only query. The table identifier is
  // backtick-quoted since it's interpolated into SQL text, even though
  // it's the pipeline author's own declared config, not runtime user
  // input. getQueryResults itself long-polls (waits) for job completion up
  // to its own timeout, so there's no need to sleep client-side between
  // polls. Once the job is done, results are read page by page via
  // pageToken so a result set bigger than a single response page isn't
  // silently truncated.
  function extractBigQuery(source) {
    var sql = resolveBigQuerySql(source);
    assertReadOnlySelect(sql);
    var queryRequest = {
      query: sql,
      useLegacySql: false
    };
    var queryResults = BigQuery.Jobs.query(queryRequest, source.projectId);

    var jobId = queryResults.jobReference.jobId;
    while (!queryResults.jobComplete) {
      queryResults = BigQuery.Jobs.getQueryResults(source.projectId, jobId);
    }

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
  // the page before it - until that token comes back falsy (the normal
  // end-of-results signal) or options.maxPages pages have been fetched,
  // whichever comes first. Deliberately knows nothing about HTTP: fetchPage
  // just has to hand back one page's parsed body, so this same loop works
  // for extractApi's UrlFetchApp calls below and equally for a "custom"
  // source wrapping a native Advanced Service call (e.g. YouTube.Search.list,
  // which returns the same enveloped/paginated shape but isn't a URL fetch
  // at all) - see README.md's api source section for that pattern. Every
  // page's rows are accumulated as plain objects and only turned into a 2D
  // array once, at the end, via one objectsToRows() call - so the header
  // row is the union of every page's keys, the same "optional fields don't
  // throw" behavior objectsToRows already gives a single page.
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
    } while (token && pageCount < options.maxPages);
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
      case 'custom':
        return assertRows(extractCustom(source), 'custom');
      default:
        throw new Error('move(): unsupported source type "' + source.type + '". Expected "sheets", "drive", "bigquery", "api", or "custom".');
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

  // Loads rows into a BigQuery table via a load job (data uploaded as CSV)
  // rather than INSERT statements - the same approach BigQuery's own
  // tooling uses for bulk loads. Defaults to "append" (WRITE_APPEND)
  // rather than "overwrite" (WRITE_TRUNCATE): unlike loadSheets above,
  // truncating a real table is destructive and hard to undo, so that mode
  // must be opted into explicitly rather than risked by a missing "mode"
  // key. Jobs.insert here doesn't long-poll the way getQueryResults does
  // in extractBigQuery, so this polls job status itself, backing off the
  // sleep between checks (500ms up to a 5s cap) so a longer-running load
  // job doesn't cost dozens of Jobs.get round trips at a fixed interval.
  //
  // target.schema is an optional array of BigQuery field defs (e.g.
  // [{name: 'order_id', type: 'STRING'}]) to use instead of
  // autodetect: true. Autodetect infers types from the CSV header/values,
  // which can guess wrong for things like a zero-padded id column
  // ("007") silently becoming an INTEGER - pass target.schema when that
  // matters; omit it and behavior is unchanged.
  function loadBigQuery(rows, target) {
    if (!target.projectId || !target.dataset || !target.table) {
      throw new Error('move(): bigquery target requires "projectId", "dataset", and "table".');
    }
    var mode = target.mode || 'append';
    var writeDisposition = mode === 'overwrite' ? 'WRITE_TRUNCATE' : mode === 'append' ? 'WRITE_APPEND' : null;
    if (!writeDisposition) {
      throw new Error('move(): unsupported bigquery target mode "' + mode + '". Expected "overwrite" or "append".');
    }
    var result = { projectId: target.projectId, dataset: target.dataset, table: target.table, jobId: null };
    if (rows.length === 0) {
      return result;
    }
    var blob = Utilities.newBlob(rowsToCsv(rows), 'text/csv');
    var loadConfig = {
      destinationTable: {
        projectId: target.projectId,
        datasetId: target.dataset,
        tableId: target.table
      },
      sourceFormat: 'CSV',
      skipLeadingRows: 1,
      writeDisposition: writeDisposition
    };
    if (target.schema) {
      loadConfig.schema = { fields: target.schema };
    } else {
      loadConfig.autodetect = true;
    }
    var insertedJob = BigQuery.Jobs.insert({ configuration: { load: loadConfig } }, target.projectId, blob);
    var jobId = insertedJob.jobReference.jobId;
    result.jobId = jobId;
    var status = insertedJob.status;
    var pollIntervalMs = 500;
    while (status.state !== 'DONE') {
      Utilities.sleep(pollIntervalMs);
      pollIntervalMs = Math.min(pollIntervalMs * 2, 5000);
      status = BigQuery.Jobs.get(target.projectId, jobId).status;
    }
    if (status.errorResult) {
      throw new Error('move(): bigquery load job failed - ' + status.errorResult.message);
    }
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

  // ==================================================================
  //   src/model.js
  // ==================================================================
  // model - the "T" of ELT. NOT IMPLEMENTED YET.
  //
  // This module is deliberately empty of code: it is the slot the model kind
  // will fill, so adding it later is filling a file rather than rearranging
  // the library. Because there is nothing executable here, the built src.js
  // behaves exactly as if this file did not exist.
  //
  // The intended shape, for whoever writes it (see README.md's "The model
  // kind" section for the user-facing version):
  //
  //   - A model is SQL, stored in an Apps Script .html file - one <script
  //     type="text/sql"> tag per model - because .html is the only way to
  //     keep a plain-text blob inside a GAS project, and HtmlService can
  //     read it back at run time.
  //
  //   - Models reference each other dbt-style, with {{ ref('other_model') }}
  //     placeholders inside the SQL. Those refs *are* the dependency
  //     declaration: a model node derives its edges by parsing its own SQL
  //     rather than repeating them in a hand-written dependsOn, and they get
  //     substituted from the resolved graph just before the SQL runs.
  //
  //   - A declared node therefore looks like:
  //       var ordersSummary = { kind: 'model', sqlFile: 'models/orders_summary.sql.html' };
  //
  // Wiring it up takes two changes in cli.js, not one:
  //
  //   1. Add `model: model` to EXECUTORS. That covers execution, and it also
  //      gets the kind into the help text, the selector errors and hello(),
  //      which all read knownKinds() off that map.
  //
  //   2. Add a per-kind hook for deriving dependencies. discoverNodes() reads
  //      dependsOn straight off the config today, which is right for move but
  //      wrong for model - a model's edges come from parsing {{ ref() }} out
  //      of its SQL. Selection, ordering and the run loop stay untouched:
  //      they only need the derived edges, not knowledge of where they came
  //      from. Keep it that way; the hook is the whole kind-specific surface.
  //
  // Security note for whoever implements this: {{ ref() }} substitution is
  // string interpolation into SQL. Only ever substitute a name that resolved
  // to a known node in the graph - never interpolate arbitrary user text -
  // or this becomes a SQL injection surface running under the script
  // owner's live BigQuery credentials.

  // ==================================================================
  //   src/cli.js
  // ==================================================================
  // cli() - the library's single public entrypoint.
  //
  // The kind modules (move.js, model.js) are machinery for doing one step's
  // work. This module is the declarative layer on top of them: instead of
  // calling move() yourself, once per step, in the right order, you
  // *declare* plain objects at the top level of your script and let cli()
  // find them, order them by their dependencies, and run them. Same idea as
  // dbt, where you don't call each model - you write models and run
  // "dbt run --select ...".

  // Maps a node's "kind" to the function that executes one node's config.
  // This is the only place a kind is registered for *execution*: selection,
  // ordering and the run loop below are all kind-agnostic, and knownKinds()
  // feeds the help text, the selector errors and hello(), so all of those
  // pick up a new kind from this map alone.
  //
  // One honest caveat, so nobody discovers it mid-change: discovery is
  // kind-agnostic only for kinds whose edges are hand-written. discoverNodes()
  // below reads dependencies straight off config.dependsOn, and the planned
  // model kind derives its edges by parsing {{ ref() }} out of its SQL
  // instead. So adding model() means an entry here *plus* a per-kind hook for
  // deriving dependsOn. That hook doesn't exist yet - it isn't written
  // speculatively, because the kind that needs it isn't written either, and
  // guessing its shape now is how you get the wrong abstraction.
  var EXECUTORS = {
    move: move
  };

  function knownKinds() {
    return Object.keys(EXECUTORS);
  }

  // Membership test that ignores the prototype chain. Every lookup map
  // below is keyed by node names and kinds that come from the caller's own
  // config, and a plain {} already "has" toString, constructor, valueOf and
  // friends. Without this, a node named "toString" would test as present in
  // maps it was never added to - passing dependency validation and then
  // failing inside the sort with a TypeError instead of a clear message.
  function has(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  // Every lookup map below is built with this rather than {}, because has()
  // only fixes half the problem. It guards the *read* side; this guards the
  // *write* side, and the write side has a worse failure. Assigning
  // obj['__proto__'] = value on a plain object doesn't create an own property
  // at all - it sets the prototype - so a node named "__proto__" silently
  // vanishes from every map it was added to. The symptoms are absurd: a node
  // with no dependencies at all gets reported as a cycle, and a dependency on
  // it is reported as "not a declared node" while it sits right there in the
  // graph. A null prototype has no __proto__ setter to hijack, so the key
  // stores like any other.
  function emptyMap() {
    return Object.create(null);
  }

  // Node lists appear in three different error messages and in hello()'s
  // output. Going through one helper keeps them rendering identically by
  // construction rather than by coincidence.
  function nodeNames(nodes) {
    return nodes.map(function (node) { return node.name; });
  }

  var COMMANDS = ['run', 'list', 'hello', 'help'];

  function usage() {
    return [
      'notsobigdata commands:',
      '',
      '  cli("run")                     run every declared node, in dependency order',
      '  cli("run --select move")       run only nodes of a given kind',
      '  cli("run --select a,b")        run only the named nodes',
      '  cli("run --exclude a")         run everything except the named nodes',
      '  cli("list")                    show what would run, in order, without running it',
      '  cli("hello")                   check the library loaded and see which nodes it can find',
      '  cli("help")                    this message',
      '',
      'Nodes are plain objects declared as top-level "var"s, marked with a',
      '"kind" (one of: ' + knownKinds().join(', ') + '). Their name defaults to',
      'the variable name, and "dependsOn" lists the names they must run after.'
    ].join('\n');
  }

  // Turns a command string into { command, select, exclude }. Deliberately
  // a tiny hand-rolled parser rather than anything clever: the whole
  // grammar is one verb plus two optional list flags, and both
  // "--select a,b" and "--select=a,b" are accepted because both spellings
  // are muscle memory for anyone who has used a real CLI.
  function parseCommand(input) {
    var text = typeof input === 'string' ? input.trim() : '';
    if (!text) {
      throw new Error('cli(): a command is required, e.g. cli("run").\n\n' + usage());
    }
    // Collapse whitespace around commas before splitting on whitespace.
    // Without this, "--select a, b" tokenizes as "--select", "a," and "b",
    // and the parser rejects "b" as an unknown option - a confusing message
    // for an input people write by reflex. A comma is the list separator, so
    // it can never be part of a node name; closing the gap costs nothing.
    var tokens = text.replace(/\s*,\s*/g, ',').split(/\s+/);
    var command = tokens.shift();
    if (COMMANDS.indexOf(command) === -1) {
      throw new Error('cli(): unknown command "' + command + '".\n\n' + usage());
    }
    var parsed = { command: command, select: [], exclude: [] };
    while (tokens.length) {
      var token = tokens.shift();
      var flag = token;
      var value = null;
      var equalsAt = token.indexOf('=');
      if (equalsAt !== -1) {
        flag = token.slice(0, equalsAt);
        value = token.slice(equalsAt + 1);
      }
      if (flag !== '--select' && flag !== '--exclude') {
        throw new Error('cli(): unknown option "' + flag + '". Expected "--select" or "--exclude".\n\n' + usage());
      }
      if (value === null) {
        value = tokens.length && tokens[0].indexOf('--') !== 0 ? tokens.shift() : '';
      }
      var list = value.split(',')
        .map(function (item) { return item.trim(); })
        .filter(function (item) { return !!item; });
      if (!list.length) {
        throw new Error('cli(): "' + flag + '" needs a comma-separated value, e.g. ' + flag + ' orders,customers.');
      }
      // Both flags are "--" plus the key they fill, and flag was validated
      // above, so this is the key rather than a lookup that could miss.
      var key = flag.slice(2);
      parsed[key] = parsed[key].concat(list);
    }
    return parsed;
  }

  // Finds every declared node by scanning the global scope.
  //
  // This is the one place the library reaches outside its own closure, and
  // it needs care. In Apps Script the global scope also holds every
  // built-in service (SpreadsheetApp, DriveApp, ...) and every function
  // the user wrote, and some of those are lazily initialized behind
  // property getters that can be slow or throw on access. So the scan
  // only ever *reads* properties - it never calls anything it finds - and
  // every read is guarded, because a scan must never fail because of a
  // global it wasn't interested in.
  //
  // Note this only sees top-level "var" declarations. A config object
  // declared inside a function is invisible here - the caller's local
  // scope isn't reachable from in here, only the other way around. That's
  // the same scoping rule the eval() install line is subject to, which is
  // why cli("hello") exists and why zero discovered nodes is reported
  // loudly rather than treated as "nothing to do".
  function discoverNodes() {
    var scope;
    var keys;
    try {
      scope = globalThis;
      keys = Object.keys(scope);
    } catch (error) {
      throw new Error('cli(): could not read the global scope to find declared nodes - ' + error.message);
    }
    var nodes = [];
    var ignored = [];
    var claimedNames = emptyMap();
    keys.forEach(function (key) {
      var value;
      var kind;
      var declaredName;
      var dependsOn;
      // One guard covering every read of a global this library didn't
      // declare: the property itself may throw on access, and so may any of
      // its keys. Either way the answer is the same - it isn't one of ours,
      // move on - so there's no reason to distinguish the two cases.
      try {
        value = scope[key];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return;
        }
        kind = value.kind;
        declaredName = value.name;
        dependsOn = value.dependsOn;
      } catch (error) {
        return;
      }
      if (typeof kind !== 'string') {
        return;
      }
      var name = typeof declaredName === 'string' && declaredName ? declaredName : key;
      // An unrecognized kind is reported, not thrown: an unrelated global
      // could legitimately carry a "kind" key and it isn't this library's
      // business. But surfacing it in hello/list output means a typo like
      // kind: "mvoe" is visible instead of silently doing nothing.
      if (!has(EXECUTORS, kind)) {
        ignored.push({ name: name, kind: kind, variable: key });
        return;
      }
      if (has(claimedNames, name)) {
        throw new Error('cli(): two nodes are both named "' + name + '" (declared as "' + claimedNames[name] + '" and "' + key + '"). Node names must be unique - set an explicit "name" on one of them.');
      }
      claimedNames[name] = key;
      if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
        throw new Error('cli(): node "' + name + '" has a "dependsOn" that is not an array - got ' + typeof dependsOn + '.');
      }
      // Normalized once, here, so "no dependsOn means no edges" is stated in
      // one place instead of at each use. The copy matters: the node's edges
      // must not alias the caller's array, which they could mutate later.
      var edges = dependsOn ? dependsOn.slice() : [];
      edges.forEach(function (dependency) {
        if (typeof dependency !== 'string' || !dependency) {
          throw new Error('cli(): node "' + name + '" has a "dependsOn" entry that is not a node name string.');
        }
      });
      nodes.push({
        name: name,
        kind: kind,
        variable: key,
        config: value,
        dependsOn: edges
      });
    });
    return { nodes: nodes, ignored: ignored };
  }

  // Every dependsOn entry must name a node that actually exists. Checked
  // against everything discovered, not just the current selection, so
  // "--select" narrowing what runs never turns a real typo into a
  // silently-ignored dependency.
  function assertDependenciesExist(nodes) {
    var byName = emptyMap();
    nodes.forEach(function (node) { byName[node.name] = true; });
    nodes.forEach(function (node) {
      node.dependsOn.forEach(function (dependency) {
        if (!has(byName, dependency)) {
          throw new Error('cli(): node "' + node.name + '" dependsOn "' + dependency + '", which is not a declared node. Known nodes: ' + nodeNames(nodes).join(', ') + '.');
        }
      });
    });
  }

  // Resolves one --select/--exclude token to node names, matching kinds
  // before names: "--select move" means every move node, "--select orders"
  // means the node called orders. A token matching neither is an error
  // rather than an empty selection, since silently running nothing is the
  // failure mode this whole design has to guard against hardest.
  function resolveSelector(nodes, token) {
    var byKind = nodes.filter(function (node) { return node.kind === token; });
    var byName = nodes.filter(function (node) { return node.name === token; });
    // Matching both is ambiguous, and quietly preferring the kind is the one
    // selector mistake in this design that wouldn't announce itself. A node's
    // name defaults to its variable name, so "var move = { kind: 'move' }" is
    // an easy thing to write - and then "--exclude move" drops every move
    // node in the project instead of that one. Everything else here fails
    // loudly; so does this.
    if (byKind.length && byName.length) {
      throw new Error('cli(): "' + token + '" is ambiguous - it is both a kind and the name of a declared node. Rename the node, or name the ones you mean explicitly: ' + nodeNames(byKind).join(', ') + '.');
    }
    var matches = byKind.length ? byKind : byName;
    if (!matches.length) {
      throw new Error('cli(): "' + token + '" matched no kind and no node name. Kinds: ' + knownKinds().join(', ') + '. Nodes: ' + nodeNames(nodes).join(', ') + '.');
    }
    return nodeNames(matches);
  }

  // Turns a list of selector tokens into a name lookup map. Shared by both
  // --select and --exclude so the two can't drift in how they resolve a
  // token - which is exactly what would happen the day dbt's "+" operators
  // get added to one branch and not the other.
  function namesMatching(nodes, tokens) {
    var names = emptyMap();
    tokens.forEach(function (token) {
      resolveSelector(nodes, token).forEach(function (name) { names[name] = true; });
    });
    return names;
  }

  // Applies --select then --exclude. Note --select selects exactly what it
  // names: it does not pull in upstream dependencies, which are assumed to
  // have run already. (dbt spells that distinction "orders" vs "+orders";
  // the "+" operators are deliberately left out of this first version.)
  function applySelection(nodes, select, exclude) {
    var selected = nodes;
    if (select.length) {
      var wanted = namesMatching(nodes, select);
      selected = selected.filter(function (node) { return has(wanted, node.name); });
    }
    if (exclude.length) {
      var unwanted = namesMatching(nodes, exclude);
      selected = selected.filter(function (node) { return !has(unwanted, node.name); });
    }
    return selected;
  }

  // Sorts nodes so every node comes after the ones it dependsOn, using
  // Kahn's algorithm: repeatedly take nodes with nothing left to wait for.
  // Picked over the recursive alternative because of how it fails - when
  // it stalls, the nodes it could not place *are* the cycle, so the error
  // can name them instead of just saying a cycle exists.
  //
  // Dependencies on nodes outside the given set (because --select narrowed
  // things down) are skipped rather than treated as unsatisfiable: they
  // were validated to exist by assertDependenciesExist, and running a
  // subset means deliberately assuming its upstreams already ran.
  function orderNodes(nodes) {
    var byName = emptyMap();
    var waitingOn = emptyMap();
    var dependents = emptyMap();
    nodes.forEach(function (node) {
      byName[node.name] = node;
      waitingOn[node.name] = 0;
      dependents[node.name] = [];
    });
    nodes.forEach(function (node) {
      node.dependsOn.forEach(function (dependency) {
        if (!has(byName, dependency)) {
          return;
        }
        waitingOn[node.name] += 1;
        dependents[dependency].push(node.name);
      });
    });
    var ready = nodes
      .filter(function (node) { return waitingOn[node.name] === 0; })
      .map(function (node) { return node.name; });
    var ordered = [];
    while (ready.length) {
      var name = ready.shift();
      ordered.push(byName[name]);
      dependents[name].forEach(function (dependent) {
        waitingOn[dependent] -= 1;
        if (waitingOn[dependent] === 0) {
          ready.push(dependent);
        }
      });
    }
    if (ordered.length !== nodes.length) {
      // A node is unplaced exactly when its counter never reached zero, which
      // waitingOn already knows - no need to re-derive it by searching the
      // ordered list for what's missing.
      var stuck = nodeNames(nodes.filter(function (node) {
        return waitingOn[node.name] > 0;
      }));
      throw new Error('cli(): dependsOn forms a cycle - these nodes each wait on another one in the group: ' + stuck.join(', ') + '.');
    }
    return ordered;
  }

  // Runs the ordered nodes, one at a time.
  //
  // A failure does not abort the run. The failed node is recorded, every
  // node downstream of it is marked "skipped" (transitively - a node
  // skipped for a missing upstream also blocks its own dependents), and
  // unrelated branches still run. That matters more here than in a normal
  // scheduler: each run is a human clicking Run in the Apps Script editor
  // and waiting, so surfacing every independent failure in one pass beats
  // fixing them one run at a time.
  //
  // Logged output stays deliberately small - names, statuses, row counts -
  // never the extracted rows themselves, which can be huge and may hold
  // data the user would rather not have sitting in an execution log.
  function runNodes(nodes, dryRun) {
    var results = [];
    var blocked = emptyMap();
    nodes.forEach(function (node) {
      var blockers = node.dependsOn.filter(function (dependency) { return has(blocked, dependency); });
      if (blockers.length) {
        blocked[node.name] = true;
        results.push({ name: node.name, kind: node.kind, status: 'skipped', blockedBy: blockers });
        Logger.log('SKIP  ' + node.name + ' (' + node.kind + ') - waiting on ' + blockers.join(', '));
        return;
      }
      if (dryRun) {
        results.push({ name: node.name, kind: node.kind, status: 'planned' });
        Logger.log('PLAN  ' + node.name + ' (' + node.kind + ')');
        return;
      }
      var startedAt = new Date().getTime();
      try {
        var result = EXECUTORS[node.kind](node.config);
        var elapsed = new Date().getTime() - startedAt;
        results.push({ name: node.name, kind: node.kind, status: 'success', ms: elapsed, result: result });
        Logger.log('OK    ' + node.name + ' (' + node.kind + ') - ' + (Array.isArray(result) ? result.length + ' rows, ' : '') + elapsed + 'ms');
      } catch (error) {
        blocked[node.name] = true;
        results.push({ name: node.name, kind: node.kind, status: 'failed', ms: new Date().getTime() - startedAt, error: error.message });
        Logger.log('FAIL  ' + node.name + ' (' + node.kind + ') - ' + error.message);
      }
    });
    return results;
  }

  // The smoke test. This is the first thing to run when anything looks
  // wrong, so it is the one command that never throws: it has to be able
  // to report "I found nothing" as a finding rather than as a failure,
  // and it deliberately checks both fragile things at once - that the
  // eval() install put the library in scope at all, and that the global
  // scan can see the caller's declared nodes.
  function hello() {
    var lines = ['notsobigdata loaded OK. Kinds available: ' + knownKinds().join(', ') + '.'];
    var discovered = null;
    try {
      discovered = discoverNodes();
    } catch (error) {
      lines.push('But discovering nodes failed: ' + error.message);
    }
    // Single exit below rather than an early return on the failure path, so
    // there is only one place that decides how this message is logged and
    // returned - two copies of that tail would drift the first time the
    // format changes.
    if (discovered && discovered.nodes.length) {
      lines.push('Discovered ' + discovered.nodes.length + ' node(s): ' + discovered.nodes.map(function (node) {
        return node.name + ' (' + node.kind + ')';
      }).join(', ') + '.');
    } else if (discovered) {
      lines.push('Discovered 0 nodes. If you expected some, check they are declared as top-level "var"s - a config object declared inside a function is invisible to cli().');
    }
    if (discovered && discovered.ignored.length) {
      lines.push('Ignored ' + discovered.ignored.length + ' object(s) with an unknown kind: ' + discovered.ignored.map(function (node) {
        return node.variable + ' (kind: "' + node.kind + '")';
      }).join(', ') + '.');
    }
    var message = lines.join('\n');
    Logger.log(message);
    return message;
  }

  // The single public entrypoint. Takes one command string and returns
  // either a run report (for "run"/"list") or a message string (for
  // "hello"/"help").
  function cli(input) {
    var parsed = parseCommand(input);
    if (parsed.command === 'help') {
      var helpText = usage();
      Logger.log(helpText);
      return helpText;
    }
    if (parsed.command === 'hello') {
      return hello();
    }
    var discovered = discoverNodes();
    if (!discovered.nodes.length) {
      throw new Error('cli(): found no declared nodes. Config objects must be declared as top-level "var"s marked with a "kind" - one declared inside a function is invisible to cli(). Run cli("hello") to see what the library can find.');
    }
    assertDependenciesExist(discovered.nodes);
    var selected = applySelection(discovered.nodes, parsed.select, parsed.exclude);
    if (!selected.length) {
      throw new Error('cli(): the selection matched no nodes. Run cli("list") to see everything available.');
    }
    var ordered = orderNodes(selected);
    var results = runNodes(ordered, parsed.command === 'list');
    return {
      ok: results.every(function (result) { return result.status !== 'failed' && result.status !== 'skipped'; }),
      command: parsed.command,
      nodes: results,
      ignored: discovered.ignored
    };
  }

  return {
    cli: cli
  };
})();
