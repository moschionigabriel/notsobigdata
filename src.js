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

  // Rejects multiple ";"-separated statements. Split out of
  // assertReadOnlySelect below so model() can reuse just this half - a
  // model is meant to write, so it has no read-only requirement to check,
  // but it should still reject a multi-statement script the same way move()
  // does. messagePrefix is the caller's own full "move(): ..."/"model(): ..."
  // lead-in, so the thrown message reads the same regardless of which
  // module raised it.
  function assertSingleStatement(sql, messagePrefix) {
    if (stripSqlComments(sql).indexOf(';') !== -1) {
      throw new Error(messagePrefix + ' must be a single statement - multi-statement scripts (separated by ";") are not allowed.');
    }
  }

  // Guards against a piece of pipeline-author-supplied SQL doing anything
  // other than a single read statement. This is a footgun-preventing
  // keyword/shape check, not a security boundary: it only strips comments,
  // looks at the leading keyword, and rejects multiple ";"-separated
  // statements, so it won't catch e.g. a SELECT that calls a mutating
  // stored routine. move()'s job is extracting/asserting on data -
  // transforming/writing it belongs in model().
  //
  // "context" is only used to phrase the thrown message - shared by every
  // call site that hands move() raw SQL to run under the script's live
  // OAuth (a bigquery source's query/queryFileId, and a bigquery target's
  // sqlTests[].query) rather than each one repeating this same check with
  // its own wording.
  function assertReadOnlySelect(sql, context) {
    var stripped = stripSqlComments(sql);
    if (!/^(select|with)\b/i.test(stripped)) {
      throw new Error('move(): ' + context + ' must be a read-only SELECT (optionally starting with WITH). move() only extracts/asserts on data - transform or write logic belongs in model().');
    }
    assertSingleStatement(sql, 'move(): ' + context);
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
    assertReadOnlySelect(sql, 'bigquery source.query/queryFileId');
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

  // Runs every target.sqlTests entry against the table loadBigQueryStaged
  // just staged, substituting "{{ this }}" - deliberately reusing dbt's own
  // name for "the table this test is about" - with the staged table's
  // fully-qualified, backtick-quoted name. Each query is expected to
  // return the rows that violate whatever it's checking (referential
  // integrity, an aggregate/volume check, ...); zero rows back means the
  // test passed, mirroring dbt's own generic-test contract. Gated through
  // assertReadOnlySelect for the same reason a bigquery source's query is:
  // this SQL runs under the script's live OAuth, and a sql test is
  // pipeline-author-supplied text, not move()'s own.
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
  // bad rows can't cheaply un-stage just those rows the way runTests()
  // filters an in-memory array, and no real user has needed it yet - the
  // same "not built speculatively" call move.md already makes for
  // referential checks in general.
  function runSqlTests(sqlTests, stagedRef) {
    var thisRef = '`' + stagedRef.projectId + '.' + stagedRef.dataset + '.' + stagedRef.table + '`';
    var failures = [];
    sqlTests.forEach(function (test) {
      if (!test || typeof test.query !== 'string' || !test.query) {
        throw new Error('move(): every entry in bigquery target.sqlTests needs a "query" (a non-empty string).');
      }
      var query = test.query.replace(/\{\{\s*this\s*\}\}/g, thisRef);
      assertReadOnlySelect(query, 'bigquery target.sqlTests[].query');
      var queryResults = runBigQueryQueryJob({ query: query, useLegacySql: false, maxResults: 5 }, stagedRef.projectId);
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
      throw new Error('move(): bigquery sql test(s) failed against the staged table - ' + summary + '.');
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

      var testResults = runSqlTests(target.sqlTests, { projectId: target.projectId, dataset: target.dataset, table: stagingTable });

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

  // ==================================================================
  //   src/model.js
  // ==================================================================
  // model - the "T" of ELT.
  //
  // A model is SQL, stored in an Apps Script .html file - one <script
  // type="text/sql"> tag, read back at run time with HtmlService, because
  // .html is the only plain-text file Apps Script lets a project hold.
  // Models reference each other dbt-style, with {{ ref('other_model') }}
  // placeholders inside the SQL. Those refs *are* the dependency
  // declaration: a model never writes its own dependsOn, and they get
  // substituted with the real table identifier just before the SQL runs.
  //
  // Every model is declared once, as an entry in a single shared registry -
  // not as its own top-level "var" the way a move node is:
  //
  //   var notsobigdataModels = {
  //     projectId: 'my-project', dataset: 'analytics', materialized: 'view',
  //     models: {
  //       stg_orders: { sqlFile: 'stg_orders.html' },
  //       orders_summary: { sqlFile: 'orders_summary.html', materialized: 'table' }
  //     }
  //   };
  //
  // projectId/dataset/materialized at the top level are project-wide
  // defaults; anything a model entry sets itself overrides them. sqlFile
  // defaults to "<model name>.html" when omitted, same spirit as a node's
  // own name defaulting from its variable elsewhere in this library.
  //
  // This is a deliberately different discovery shape than move's "every
  // node is its own var": with dozens of models, N boilerplate top-level
  // vars just to register them is worse than one object naming them all.
  // The cost is that cli.js's discoverNodes() - which normally finds nodes
  // by scanning the global scope for a "kind" key - cannot find these at
  // all, since notsobigdataModels itself carries no "kind". expandModelNodes()
  // below is the hook that makes up the difference: it turns the one
  // registry into N fully-formed nodes, and discoverNodes() folds its
  // output straight into the same list the var-scan produces. Selection,
  // ordering and the run loop never learn the difference.

  // Every {{ ... }} placeholder this library understands is a call with one
  // string argument - {{ ref('other_model') }} today. Written as a generic
  // scan-and-dispatch rather than a ref()-only regex, because more
  // Jinja-like calls (starting with config(), most likely) are expected
  // later: growing the dispatch in compileModelSql() below should be an
  // added case, not a rewrite of the scanner.
  //
  // Matches the call *shape* only - name plus whatever sits between its
  // parens - deliberately not the "exactly one quoted string" shape ref()
  // itself requires. Matching that narrowly here would let a call this
  // library doesn't recognize (a no-arg {{ macro() }}, a kwarg-style
  // {{ config(materialized='table') }}) fail to match at all and pass
  // through as literal, unsubstituted text instead of being rejected by the
  // "unsupported template call" check in compileModelSql() below - which
  // defeats the point of that check. parseSingleStringArgument() below
  // enforces ref()'s own stricter shape once a call is known to be ref().
  function templateExpressionPattern() {
    return /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]*)\)\s*\}\}/g;
  }

  function scanTemplateExpressions(sql) {
    var pattern = templateExpressionPattern();
    var matches = [];
    var match;
    while ((match = pattern.exec(sql))) {
      matches.push({ raw: match[0], call: match[1], args: match[2] });
    }
    return matches;
  }

  // The only argument shape ref() accepts: exactly one quoted string, no
  // more. Called after a call is already known to be "ref" (extractRefDependencies,
  // compileModelSql), so a ref() with no argument, two arguments, or an
  // unquoted name is a clear error rather than silently matching nothing.
  function parseSingleStringArgument(call, args) {
    var match = /^\s*(['"])([^'"]*)\1\s*$/.exec(args);
    if (!match) {
      throw new Error('model(): "' + call + '(' + args + ')" is not a valid call - ' + call + '() takes exactly one quoted name, e.g. ' + call + '(\'model_name\').');
    }
    return match[2];
  }

  // The keys a model entry or the registry's top level may set as a
  // materialization default. Kept as an explicit list rather than copying
  // every key on notsobigdataModels, so an unrelated key a user attaches to
  // the registry (notes, a comment, anything) never leaks into a model's
  // resolved config.
  var MODEL_DEFAULT_KEYS = ['projectId', 'dataset', 'materialized'];

  // Guarded read of the single notsobigdataModels global, reusing cli.js's
  // readOptionalGlobal() - same "never throw because of a global this
  // library doesn't own" reasoning discoverNodes() applies to every other
  // global. Absent entirely means "no models declared" and returns quietly,
  // so a move-only project never notices this global exists. But once it
  // *is* declared, its shape is this library's business - unlike an
  // unrelated global that happens to exist, nobody else would coincidentally
  // declare something named notsobigdataModels, so a malformed one (an
  // array, a string, a models field that isn't itself a plain object) is a
  // clear mistake worth failing loudly on rather than silently treating the
  // same as "not declared at all". Only a specific model *entry* being
  // malformed is deferred to resolveModelConfig below, once we know a
  // caller actually wants that entry.
  function readModelsRegistry() {
    var raw = readOptionalGlobal('notsobigdataModels');
    if (raw === undefined) {
      return { defaults: {}, models: {} };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('model(): notsobigdataModels must be an object - got ' + (Array.isArray(raw) ? 'an array' : typeof raw) + '.');
    }
    var defaults = {};
    MODEL_DEFAULT_KEYS.forEach(function (key) {
      if (raw[key] !== undefined) {
        defaults[key] = raw[key];
      }
    });
    var models = {};
    if (raw.models !== undefined) {
      if (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
        throw new Error('model(): notsobigdataModels.models must be an object - got ' + (Array.isArray(raw.models) ? 'an array' : typeof raw.models) + '.');
      }
      models = raw.models;
    }
    return { defaults: defaults, models: models };
  }

  // Merges the registry's defaults with one model's own entry (the entry
  // wins on any key both set) and resolves sqlFile's naming-convention
  // default. Reused for two different callers: expandModelNodes() below
  // resolves a model's *own* config, and compileModelSql()'s ref() handler
  // resolves what a ref() *points at* - both need "here is everything known
  // about model X", and an unknown model name has to be an error either way
  // (never substitute a name that didn't resolve to a real entry - see the
  // model() executor below).
  //
  // has() is cli.js's guard against a model named e.g. "toString" or
  // "__proto__" testing as present in a plain {} it was never added to -
  // the same risk cli.js's own node/kind lookups already guard against, so
  // reused rather than re-implemented here.
  function resolveModelConfig(name) {
    var registry = readModelsRegistry();
    if (!has(registry.models, name)) {
      throw new Error('model(): "' + name + '" is not declared in notsobigdataModels.models. Known models: ' + Object.keys(registry.models).join(', ') + '.');
    }
    var entry = registry.models[name];
    if (!entry || typeof entry !== 'object') {
      throw new Error('model(): notsobigdataModels.models["' + name + '"] must be an object - got ' + typeof entry + '.');
    }
    var config = {};
    Object.keys(registry.defaults).forEach(function (key) { config[key] = registry.defaults[key]; });
    Object.keys(entry).forEach(function (key) { config[key] = entry[key]; });
    config.name = name;
    if (!config.sqlFile) {
      config.sqlFile = name + '.html';
    }
    return config;
  }

  // Reads one model's SQL out of its .html file. HtmlService reads a file
  // that lives in the Apps Script project itself, unlike move.js's
  // readDriveFileText (a Drive file, found by id) - models are project
  // source, not a data source.
  //
  // createHtmlOutputFromFile() takes the file's name as registered in the
  // project, which Google's own examples always give without the ".html"
  // extension (e.g. HtmlService.createHtmlOutputFromFile('Dialog') for a
  // file created as "Dialog.html") - sqlFile keeps its extension as a
  // config value, since "a model's SQL file" reads more naturally that way
  // and matches every fixture/example in this repo, but it's stripped here
  // before the actual API call so this matches the documented contract
  // rather than depending on any leniency the runtime may or may not have.
  function readModelSql(sqlFile) {
    var scriptFileName = sqlFile.replace(/\.html$/i, '');
    var html;
    try {
      html = HtmlService.createHtmlOutputFromFile(scriptFileName).getContent();
    } catch (error) {
      throw new Error('model(): could not read "' + sqlFile + '" - ' + error.message + '. Every model needs a matching .html file with a <script type="text/sql"> tag - see README.md\'s "The model kind" section.');
    }
    var pattern = /<script[^>]*type=["']text\/sql["'][^>]*>([\s\S]*?)<\/script>/gi;
    var matches = [];
    var match;
    while ((match = pattern.exec(html))) {
      matches.push(match[1]);
    }
    if (matches.length !== 1) {
      throw new Error('model(): "' + sqlFile + '" must have exactly one <script type="text/sql"> tag - found ' + matches.length + '.');
    }
    return matches[0].trim();
  }

  // The dependency-derivation hook: a model's ref() calls *are* its edges,
  // so dependsOn is read out of the SQL instead of being hand-written.
  function extractRefDependencies(sql) {
    return scanTemplateExpressions(sql)
      .filter(function (expression) { return expression.call === 'ref'; })
      .map(function (expression) { return parseSingleStringArgument('ref', expression.args); });
  }

  // Substitutes every {{ ref('x') }} with x's resolved, backtick-quoted
  // relation - same quoting convention move.js's resolveBigQuerySql already
  // uses for an interpolated table identifier. resolveRef is expected to
  // throw on an unknown name (resolveModelConfig does), which this function
  // deliberately does not catch: ref substitution is string interpolation
  // into SQL that runs with the script owner's live BigQuery credentials,
  // so an unresolved name must stop the run, never fall through as literal
  // text. Any *other* template call is rejected the same way, for the same
  // reason - see the module comment above about growing this later.
  function compileModelSql(sql, resolveRef) {
    return sql.replace(templateExpressionPattern(), function (raw, call, args) {
      if (call !== 'ref') {
        throw new Error('model(): unsupported template call "' + call + '(...)" in SQL - only ref() is implemented so far.');
      }
      return resolveRef(parseSingleStringArgument('ref', args));
    });
  }

  function qualifiedRelation(config) {
    if (!config.projectId) {
      throw new Error('model(): "' + config.name + '" is missing "projectId" - set it on notsobigdataModels or on this model entry.');
    }
    if (!config.dataset) {
      throw new Error('model(): "' + config.name + '" is missing "dataset" - set it on notsobigdataModels or on this model entry.');
    }
    return '`' + config.projectId + '.' + config.dataset + '.' + config.name + '`';
  }

  // view/table only - incremental (dbt's third materialization) is v2, same
  // deferral as column-level tests.
  function resolveMaterialized(config) {
    var materialized = config.materialized || 'view';
    if (materialized !== 'view' && materialized !== 'table') {
      throw new Error('model(): "' + config.name + '" has materialized "' + materialized + '" - expected "view" or "table" (incremental is not implemented yet).');
    }
    return materialized;
  }

  // cli.js's discoverNodes() calls this once, after its own var-scan, and
  // folds the result into the same node list - see the module comment above
  // for why models need this instead of being found by that scan directly.
  // Absent notsobigdataModels means "no models declared", not an error:
  // this returns [] and a move-only project never notices model.js exists.
  //
  // Stashes the SQL it had to read anyway (to derive dependsOn) onto the
  // node's config, so model() below - which runs later, once this node's
  // turn comes up in cli()'s run loop - reuses it instead of asking
  // HtmlService for the same file a second time.
  function expandModelNodes() {
    var registry = readModelsRegistry();
    return Object.keys(registry.models).map(function (name) {
      var config = resolveModelConfig(name);
      config.sql = readModelSql(config.sqlFile);
      return {
        name: name,
        kind: 'model',
        variable: 'notsobigdataModels.models.' + name,
        config: config,
        dependsOn: extractRefDependencies(config.sql)
      };
    });
  }

  // The EXECUTORS.model entry: compiles the model's SQL (substituting every
  // ref()) and materializes it as a view or table. Deliberately does not
  // call move.js's assertReadOnlySelect - that guard exists to keep move()
  // read-only, and a model's whole job is writing. It does reuse
  // assertSingleStatement, move.js's other SQL-shape guard: a model can
  // write, but a stray ";" splitting its SQL into more than one statement
  // is a mistake either way, not a second statement this library intends
  // to run.
  //
  // config.sql is always already set by expandModelNodes() above by the
  // time this runs - every model node comes from there (discoverNodes()
  // rejects a hand-declared kind: 'model' var, see cli.js), so there's no
  // path into this function without it.
  function model(config) {
    var sql = config.sql;
    assertSingleStatement(sql, 'model(): "' + config.name + '"');
    var compiled = compileModelSql(sql, function (refName) {
      return qualifiedRelation(resolveModelConfig(refName));
    });
    var relation = qualifiedRelation(config);
    var materialized = resolveMaterialized(config);
    var statement = 'CREATE OR REPLACE ' + materialized.toUpperCase() + ' ' + relation + ' AS\n' + compiled;
    runBigQueryQueryJob({ query: statement, useLegacySql: false }, config.projectId);
    return { relation: relation, materialized: materialized };
  }

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
  // kind-agnostic only for kinds whose *edges* are hand-written. move's
  // dependsOn is read straight off its config below; model's isn't - a
  // model derives its edges by parsing {{ ref() }} out of its own SQL, and
  // its nodes don't even come from a top-level var each (see
  // discoverNodes() below) - they're expanded from the single
  // notsobigdataModels registry by model.js's expandModelNodes(). Both of
  // those are model-specific hooks, kept as narrow as the kind that needed
  // them; a third kind needing something similar gets its own hook, not a
  // generalized version of this one.
  var EXECUTORS = {
    move: move,
    model: model
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

  // Claims a node name against the shared map every discovery path
  // populates - the plain var-scan below and model.js's expandModelNodes()
  // fold-in both need "is this name already taken, and by what" to agree,
  // so the check and its error message live in one place instead of being
  // copy-pasted per discovery path.
  function claimName(claimedNames, name, variable) {
    if (has(claimedNames, name)) {
      throw new Error('cli(): two nodes are both named "' + name + '" (declared as "' + claimedNames[name] + '" and "' + variable + '"). Node names must be unique - set an explicit "name" on one of them.');
    }
    claimedNames[name] = variable;
  }

  // Guarded read of a single optional global - shared by every "config
  // object declared as a top-level var, or omitted entirely" reader in this
  // library (resolveManifestConfig/resolveLoggingConfig below, and
  // model.js's readModelsRegistry). Never throws because of a global this
  // library doesn't own, same reasoning discoverNodes()'s own scan already
  // applies to every global it walks past.
  function readOptionalGlobal(name) {
    try {
      return globalThis[name];
    } catch (error) {
      return undefined;
    }
  }

  // Node lists appear in three different error messages and in hello()'s
  // output. Going through one helper keeps them rendering identically by
  // construction rather than by coincidence.
  function nodeNames(nodes) {
    return nodes.map(function (node) { return node.name; });
  }

  // Same reasoning as nodeNames() above, for the single-node case: the
  // "<name> (<kind>)" label appears at every log line runNodes() writes
  // (START/SKIP/PLAN/OK/FAIL) plus hello()'s node listing - one helper keeps
  // all six rendering identically by construction.
  function nodeLabel(node) {
    return node.name + ' (' + node.kind + ')';
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
      // model is a known kind but not one this scan can ever build a
      // correct node for: its dependsOn comes from parsing {{ ref() }} out
      // of its SQL (see expandModelNodes() below), which this loop has no
      // way to do for a bare top-level var. Without this check, a var
      // written this way - the shape an earlier version of this README
      // documented - wouldn't be ignored (model is a real EXECUTORS entry
      // now) and wouldn't fail loudly either: it would silently become a
      // node with no derived edges at all, ordering wrong relative to
      // whatever it actually ref()s.
      if (kind === 'model') {
        throw new Error('cli(): "' + key + '" is declared as a top-level var with kind "model" - models are declared as entries in notsobigdataModels.models instead, not their own var. See README.md\'s "The model kind" section.');
      }
      claimName(claimedNames, name, key);
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
    // model nodes don't come from the scan above at all - see the EXECUTORS
    // comment. expandModelNodes() (model.js) turns the single
    // notsobigdataModels registry into one fully-formed node per entry,
    // already carrying config and dependsOn; folding them in here, right
    // where the var-scan finishes, means every downstream step
    // (assertDependenciesExist, selection, ordering, running) sees one flat
    // node list and never has to know two different discovery mechanisms
    // produced it.
    expandModelNodes().forEach(function (node) {
      claimName(claimedNames, node.name, node.variable);
      nodes.push(node);
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
  //
  // START logs immediately before the one branch that can actually take
  // real time - the EXECUTORS[node.kind] call - not before the blocked-check
  // or the dry-run check above it, since neither of those waits on anything:
  // a skipped or planned node is decided instantly, so a START line there
  // would never carry the "is this still working" signal it exists for. That
  // signal matters for real execution (a BigQuery job can poll for tens of
  // seconds) - without it, a human watching the Apps Script log during a
  // long run can only see which nodes have already finished, never which one
  // is currently in flight.
  //
  // SKIP and FAIL always log - they're exactly what needs a human's
  // attention. OK only logs when verbose is true: nothing failed is already
  // implied by START's presence plus the absence of a FAIL/SKIP line, and
  // the row-count/timing detail OK would add is never lost from the
  // permanent record either way - it's always in the returned result and
  // (for "run") the Drive manifest, regardless of what hits the console.
  // verbose defaults false (see resolveLoggingConfig()) precisely so a
  // normal run's console output stays proportional to what needs attention,
  // not to how many nodes happened to succeed.
  function runNodes(nodes, dryRun, verbose) {
    var results = [];
    var blocked = emptyMap();
    nodes.forEach(function (node) {
      var blockers = node.dependsOn.filter(function (dependency) { return has(blocked, dependency); });
      if (blockers.length) {
        blocked[node.name] = true;
        results.push({ name: node.name, kind: node.kind, status: 'skipped', blockedBy: blockers });
        Logger.log('SKIP  ' + nodeLabel(node) + ' - waiting on ' + blockers.join(', '));
        return;
      }
      if (dryRun) {
        results.push({ name: node.name, kind: node.kind, status: 'planned' });
        Logger.log('PLAN  ' + nodeLabel(node));
        return;
      }
      Logger.log('START ' + nodeLabel(node));
      var startedAt = new Date().getTime();
      try {
        var result = EXECUTORS[node.kind](node.config);
        var elapsed = new Date().getTime() - startedAt;
        results.push({ name: node.name, kind: node.kind, status: 'success', ms: elapsed, result: result });
        if (verbose) {
          Logger.log('OK    ' + nodeLabel(node) + ' - ' + (Array.isArray(result) ? result.length + ' rows, ' : '') + elapsed + 'ms');
        }
      } catch (error) {
        blocked[node.name] = true;
        results.push({ name: node.name, kind: node.kind, status: 'failed', ms: new Date().getTime() - startedAt, error: error.message });
        Logger.log('FAIL  ' + nodeLabel(node) + ' - ' + error.message);
      }
    });
    return results;
  }

  // Counts each status in a runNodes() result set and renders it as the
  // "DONE" summary line cli() logs at the end of a run/list - see there.
  // Only non-zero counts are rendered - a "list" run (every node
  // "planned") would otherwise print "0 passed, 0 failed, 0 skipped, 5
  // planned", which buries the one number that matters in noise nobody
  // asked about. One function rather than a count/format split: this
  // project's tests are black-box (a human runs cli() from the Apps
  // Script editor - see CLAUDE.md's "About testing"), so there is no
  // caller that would ever want the raw counts independent of this one
  // string.
  function formatStatusCounts(results) {
    var counts = { success: 0, failed: 0, skipped: 0, planned: 0 };
    results.forEach(function (result) { counts[result.status] += 1; });
    var labels = { success: 'passed', failed: 'failed', skipped: 'skipped', planned: 'planned' };
    var parts = ['success', 'failed', 'skipped', 'planned']
      .filter(function (status) { return counts[status] > 0; })
      .map(function (status) { return counts[status] + ' ' + labels[status]; });
    return parts.length ? parts.join(', ') : 'nothing to do';
  }

  // Reads the optional notsobigdataManifest global the same guarded way
  // discoverNodes() reads every other global - the read must never throw
  // because of something this library doesn't own. Every field is
  // optional; omitting the global entirely gives all three defaults.
  function resolveManifestConfig() {
    var raw = readOptionalGlobal('notsobigdataManifest');
    var config = (raw && typeof raw === 'object') ? raw : {};
    return {
      enabled: config.enabled !== false,
      folderId: typeof config.folderId === 'string' && config.folderId ? config.folderId : null,
      fileName: typeof config.fileName === 'string' && config.fileName ? config.fileName : 'notsobigdata-manifest.json'
    };
  }

  // Reads the optional notsobigdataLogging global, same guarded pattern as
  // resolveManifestConfig() above. verbose is the only field: false by
  // default, so a normal run's console output stays proportional to what
  // needs attention (see runNodes()'s own comment) rather than to how many
  // nodes happened to succeed. Set true to restore an OK line for every
  // successful node too.
  function resolveLoggingConfig() {
    var raw = readOptionalGlobal('notsobigdataLogging');
    var config = (raw && typeof raw === 'object') ? raw : {};
    return { verbose: config.verbose === true };
  }

  // Auto-detects "the folder the Apps Script project lives in" when no
  // explicit folderId is configured - every Apps Script project has its own
  // Drive file entry, even standalone ones, so its parent folder is the
  // project's folder. Falls back to Drive's root when that file has no
  // parent (e.g. it sits directly in "My Drive").
  function resolveManifestFolderId(folderId) {
    if (folderId) {
      return folderId;
    }
    var scriptFile = DriveApp.getFileById(ScriptApp.getScriptId());
    var parents = scriptFile.getParents();
    return parents.hasNext() ? parents.next().getId() : DriveApp.getRootFolder().getId();
  }

  // Turns one runNodes() result into a manifest-safe summary. Kind-agnostic
  // by construction: it never branches on node.kind, only on the *shape* of
  // the result (an array of rows, or an object carrying loadResult/
  // testResults) - the same shape every EXECUTORS entry already produces.
  // The raw rows are never included, only their size - a manifest is an
  // observability artifact, not a second copy of the data that already
  // landed at its real destination.
  function summarizeNodeResult(result) {
    var summary = { name: result.name, kind: result.kind, status: result.status };
    if (result.status === 'skipped') {
      summary.blockedBy = result.blockedBy;
    } else if (result.status === 'failed') {
      summary.ms = result.ms;
      summary.error = result.error;
    } else if (result.status === 'success') {
      summary.ms = result.ms;
      if (Array.isArray(result.result)) {
        summary.rowCount = result.result.length;
        summary.columnCount = Array.isArray(result.result[0]) ? result.result[0].length : 0;
      }
      if (result.result && result.result.loadResult !== undefined) {
        summary.loadResult = result.result.loadResult;
      }
      if (result.result && result.result.testResults !== undefined) {
        summary.testResults = result.result.testResults;
      }
    }
    return summary;
  }

  function buildManifest(commandText, ok, results, ignored) {
    return {
      notsobigdata: 'manifest',
      version: 1,
      generatedAt: new Date().toISOString(),
      command: String(commandText).trim(),
      ok: ok,
      nodes: results.map(summarizeNodeResult),
      ignored: ignored
    };
  }

  // Writes the run manifest to Drive, overwriting the same file every time
  // (found by name via upsertByName, never a fresh file per run - creating
  // one per run is exactly the pattern that piled up duplicate fixture
  // files in the test project before, see CLAUDE.md's "About testing").
  // Best-effort: a Drive failure here must never throw or affect the
  // node results actually being reported, so every path is caught and
  // turned into one of three report.manifest shapes instead.
  //
  // Every outcome also gets a Logger.log line, same as every other outcome
  // in a run (the call-level START/DONE, each node's START/OK/FAIL/SKIP/PLAN).
  // Without it, a failed write was only visible in the returned
  // report.manifest - which the documented usage pattern (Logger.log(report.ok))
  // never inspects - so a human watching the Apps Script execution log, the
  // one place CLAUDE.md's testing section says they actually look, had no way
  // to tell a manifest failed to write from one that succeeded silently.
  //
  // Reuses resolveDriveWriteTarget/writeDriveText from move.js rather than
  // re-implementing "resolve an existing file or create one" a second
  // time - the first helper call to cross the move.js/cli.js boundary, and
  // deliberately so: this is genuinely the same primitive loadDriveJson
  // already uses, not new drive-writing logic.
  function writeManifest(commandText, ok, results, ignored) {
    var config = resolveManifestConfig();
    if (!config.enabled) {
      Logger.log('MANIFEST skipped - notsobigdataManifest.enabled is false');
      return { written: false, reason: 'disabled' };
    }
    try {
      var folderId = resolveManifestFolderId(config.folderId);
      var manifest = buildManifest(commandText, ok, results, ignored);
      var target = { folderId: folderId, fileName: config.fileName, upsertByName: true };
      var fileId = resolveDriveWriteTarget(target);
      fileId = writeDriveText(fileId, target, JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT);
      Logger.log('MANIFEST written to ' + fileId);
      return { written: true, fileId: fileId };
    } catch (error) {
      Logger.log('MANIFEST failed - ' + error.message);
      return { written: false, reason: 'error', error: error.message };
    }
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
      lines.push('Discovered ' + discovered.nodes.length + ' node(s): ' + discovered.nodes.map(nodeLabel).join(', ') + '.');
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
  //
  // Logs "START"/"DONE" bookends around every call, padded to the same
  // six characters as runNodes()'s own "OK"/"FAIL"/"SKIP"/"PLAN" labels so
  // every line in the execution log lines up. "START" is the very first
  // thing this function does, before parseCommand() - so a call that
  // throws immediately (an unknown command, zero discovered nodes) still
  // leaves a marker that cli() actually ran, not silence up to the error.
  // "DONE" only fires for "run"/"list": hello()/help() already log their
  // own single result line and have no per-node pass/fail/skip status to
  // roll up. Both are pure Logger.log side effects - report is unchanged.
  function cli(input) {
    Logger.log('START cli("' + input + '")');
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
    var results = runNodes(ordered, parsed.command === 'list', resolveLoggingConfig().verbose);
    var ok = results.every(function (result) { return result.status !== 'failed' && result.status !== 'skipped'; });
    Logger.log('DONE  cli("' + input + '") - ' + formatStatusCounts(results) + ' (' + results.length + ' total).');
    var report = {
      ok: ok,
      command: parsed.command,
      nodes: results,
      ignored: discovered.ignored
    };
    // Only "run" writes a manifest - "list" is a dry run where nothing
    // executed, and overwriting the last real run's record with a no-op
    // would defeat the "reflects what actually happened" point of it.
    if (parsed.command === 'run') {
      report.manifest = writeManifest(input, ok, results, discovered.ignored);
    }
    return report;
  }

  return {
    cli: cli
  };
})();
