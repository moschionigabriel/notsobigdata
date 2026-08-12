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

  // A URL pasted straight from the GitHub UI points at an HTML page
  // (github.com/.../blob/...), not the file's raw bytes - rewriting it to
  // the equivalent raw.githubusercontent.com URL is the one host-specific
  // convenience the url source makes, so a link copied out of a browser tab
  // works without the pipeline author having to know "raw" links exist.
  // Anything that isn't that exact shape (including an already-raw URL, or
  // any non-GitHub host - Kaggle included, which needs authenticated API
  // access this library deliberately doesn't take on) passes through
  // unchanged.
  //
  // The path capture is split on the first "?"/"#" before being reused, so a
  // trailing query string or line-range fragment from a URL copied straight
  // out of the GitHub UI (e.g. "...blob/main/data.csv?raw=true", or a
  // "#L10-L20" line-range link) doesn't get forwarded verbatim into the
  // rewritten raw.githubusercontent.com URL - that host doesn't understand
  // either one, and a query string in particular could produce a different
  // or unexpected response instead of the plain file body this function
  // exists to fetch.
  function rewriteGithubBlobUrl(url) {
    var match = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/.exec(url);
    if (!match) {
      return url;
    }
    var path = match[3].split(/[?#]/)[0];
    return 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2] + '/' + path;
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
  // fetched blob instead of an existing Drive file id. Getting from "a blob"
  // to "a Drive file id" needs a plain DriveApp upload first (no conversion,
  // just bytes) - Drive.Files.insert would do that upload *and* the GOOGLE_
  // SHEETS conversion in one call, but insert is Drive API v2 only; v3 (what
  // a newly-enabled Advanced Drive Service defaults to today) renamed it to
  // Files.create, and guessing which one a consumer's appsscript.json has
  // enabled is exactly the kind of version split extractDriveXlsx's own
  // name/title comment already works around for metadata fields - but there
  // there's no method-name equivalent to fall back to. So this reuses the
  // same DriveApp.createFile + Drive.Files.copy pair loadDriveXlsx already
  // proves works project-wide (SpreadsheetApp.create there, DriveApp.
  // createFile here - either way, a plain create followed by Drive.Files.copy
  // doing the conversion), rather than adding a second untested code path.
  // Both temp files - the raw upload and the converted sheet - are removed
  // in nested finally blocks, including on error, so a failure at either
  // step never leaves an orphan behind.
  function extractUrlXlsx(url, options) {
    var response = UrlFetchApp.fetch(url, options || {});
    assertHttpOk(response, 'move(): url source request to "' + url + '" failed');
    var tempFileName = 'notsobigdata-xlsx-import-' + Utilities.getUuid();
    var rawFileId = DriveApp.getRootFolder().createFile(response.getBlob().setName(tempFileName)).getId();
    try {
      var tempFileMetadata = Drive.Files.copy(
        { name: tempFileName, title: tempFileName, mimeType: MimeType.GOOGLE_SHEETS },
        rawFileId
      );
      try {
        var spreadsheet = SpreadsheetApp.openById(tempFileMetadata.id);
        var values = spreadsheet.getActiveSheet().getDataRange().getValues();
        return isBlankGrid(values) ? [] : values;
      } finally {
        Drive.Files.remove(tempFileMetadata.id);
      }
    } finally {
      Drive.Files.remove(rawFileId);
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

  // ==================================================================
  //   src/model.js
  // ==================================================================
  // model - the "T" of ELT.
  //
  // A model is SQL, stored in an Apps Script .html file, read back at run
  // time with HtmlService because .html is the only plain-text file Apps
  // Script lets a project hold. Models reference each other dbt-style, with
  // {{ ref('other_model') }} placeholders inside the SQL. Those refs *are*
  // the dependency declaration - a model never hand-writes dependsOn for
  // something its SQL already ref()s, and refs get substituted with the
  // real table identifier just before the SQL runs. ref() resolves against
  // two things: another declared model, or a move node whose target is
  // bigquery (see the moveBigQueryTargets index in expandModelNodes()
  // below) - a move node loading anything else (Sheets, Drive, an API) has
  // no queryable relation for ref() to substitute, so a model that merely
  // needs to wait on one of those still uses a hand-written dependsOn - see
  // MODEL_DEFAULT_KEYS and mergeDependsOn() below, and docs/model.md's
  // "Depending on a move node" for the user-facing version.
  //
  // A model's .html file can hold its SQL three ways, chosen by how many
  // <script type="text/sql"> tags it contains - see extractModelSql() below:
  //
  //   - zero tags: the whole file is the SQL (nothing else in it to be).
  //   - one tag: that tag's content is the SQL. It may carry an "id", but if
  //     it does, the id must match the model name - same rule as the
  //     several-tags case below, so a copy-pasted tag with a stale id fails
  //     loudly instead of silently running under the wrong model.
  //   - more than one tag: every model sharing that file gets its own
  //     tagged block, and each tag needs an "id" matching a model name -
  //     this is what makes "several small models in one .html file" work,
  //     the way a single dbt project holds many .sql files.
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

  // Every {{ ... }} placeholder this library understands is a call - either
  // ref()'s one positional string argument, config()'s kwarg-style
  // key='value' arguments, or var()'s one-or-two positional string arguments
  // (see parseSingleStringArgument, parseKwargsArgument and
  // parseVarArguments below). Written as a generic scan-and-dispatch rather
  // than a ref()-only regex, since more calls beyond the first were always
  // expected: growing the dispatch in compileModelSql() below should stay an
  // added case, not a rewrite of the scanner.
  //
  // {% set key = 'value' %} is deliberately a different bracket shape
  // ({% %}, not {{ }}) - see setStatementPattern()/bareVarPattern() below -
  // because it is a real Jinja *statement* (it defines a name, it doesn't
  // evaluate to a substituted value itself), unlike every call this pattern
  // matches, which stands in for the value it evaluates to.
  //
  // {% for x in [...] %}...{% endfor %} is a different, bigger construct
  // still - a block, not a statement or a call - see
  // forStatementOpenPattern()/expandForLoops() below. Unlike every other
  // macro in this file, it doesn't join compileModelSql()'s dispatch at all:
  // it's a text-expansion pass that runs once, at discovery time, before
  // ref()/config()/set()/var() ever see the SQL, so a call inside a loop
  // body is handled by the existing pipeline for free once the loop itself
  // has been resolved into plain text.
  //
  // {{ name(args) }} calling a user-authored macro (declared with the
  // {% macro %}/{% endmacro %} block construct, in a file notsobigdataModels.macros
  // lists) is, like {% for %}, a text-expansion pass rather than a
  // compileModelSql() dispatch case - see expandMacroCalls() below. It runs
  // after {% for %} and before this scanner or compileModelSql() ever see the
  // SQL, so ref()/config()/set()/var() living inside a macro's own body are
  // handled by the existing pipeline for free, the same way a call inside a
  // loop body already is.
  //
  // Matches the call *shape* only - name plus whatever sits between its
  // parens - deliberately not either call's own stricter argument shape.
  // Matching narrowly here would let a call this library doesn't recognize
  // (a no-arg {{ macro() }}, some other kwarg-style call) fail to match at
  // all and pass through as literal, unsubstituted text instead of being
  // rejected by the "unsupported template call" check in compileModelSql()
  // below - which defeats the point of that check. parseSingleStringArgument(),
  // parseKwargsArgument() and parseVarArguments() below enforce each call's
  // own stricter shape once a call is already known by name.
  function templateExpressionPattern() {
    return /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]*)\)\s*\}\}/g;
  }

  // {% set key = 'value' %} - a real Jinja *statement*, not a {{ }} call:
  // defines a name, scoped to this one model's SQL, read back later as a
  // bare {{ key }} reference (see bareVarPattern() below) rather than
  // through a var() wrapper. Deliberately a single-line, single
  // string-literal assignment - not the general "any Jinja expression on
  // the right-hand side" a real {% set %} allows - matching every other
  // value in this file being string-only text substitution, not a real
  // expression evaluator. A multi-line {% set %} block (the
  // {% set x %}...{% endset %} form) is a different, larger construct and
  // isn't implemented.
  function setStatementPattern() {
    return /\{%\s*set\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(['"])([^'"]*)\2\s*%\}/g;
  }

  // A bare {{ key }} reference - no parens, so it can never collide with
  // templateExpressionPattern()'s call shape above - reading back a value a
  // {% set %} statement defined earlier in the same SQL. Scoped narrowly to
  // what {% set %} needs; this is not a general "evaluate any Jinja
  // expression" mechanism.
  function bareVarPattern() {
    return /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  }

  // {% for x in ['a', 'b'] %}...{% endfor %} - a block construct, like
  // {% set %} above, not a {{ }} call. Deliberately non-global (unlike every
  // other pattern in this file): expandForLoops() below re-slices the
  // remaining SQL after each block it resolves and calls .exec() fresh each
  // time, rather than relying on a global regex's own lastIndex bookkeeping -
  // simpler to reason about once the match is being used to cut the string
  // into pieces, not just collected.
  function forStatementOpenPattern() {
    return /\{%\s*for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+(\[[^\]]*\])\s*%\}/;
  }

  function forEndPattern() {
    return /\{%\s*endfor\s*%\}/;
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

  // var()'s own argument shape: one quoted name, and an optional second
  // quoted default - e.g. var('region') or var('region', 'US'). Separate
  // from parseSingleStringArgument (ref() takes exactly one, always
  // required) and parseKwargsArgument (config()'s key='value' pairs) because
  // var() is positional but optionally two-argument - neither existing
  // parser's shape fits. Deliberately string-only, same posture as every
  // other value in this file.
  function parseVarArguments(call, args) {
    var match = /^\s*(['"])([^'"]*)\1(?:\s*,\s*(['"])([^'"]*)\3)?\s*$/.exec(args);
    if (!match) {
      throw new Error('model(): "' + call + '(' + args + ')" is not a valid call - ' + call + '() takes a quoted name and an optional quoted default, e.g. ' + call + '(\'region\') or ' + call + '(\'region\', \'US\').');
    }
    return { name: match[2], hasDefault: match[3] !== undefined, defaultValue: match[4] };
  }

  // The kwarg-style argument shape config() uses: one or more
  // comma-separated key='value' pairs, each value a quoted string - e.g.
  // config(materialized='table'). Splits on top-level commas first, then
  // matches each segment against a single key='value' pattern, so a bad
  // segment (missing quotes, no "=", an empty key) names exactly which one
  // is wrong rather than failing on the whole argument list at once.
  // Deliberately string-only, same posture parseSingleStringArgument takes
  // for ref() - config()'s only key so far (materialized) is itself a
  // closed enum ('view'/'table'), so it doesn't need numbers/booleans/nested
  // values yet, and adding them later is an easy extension of this same
  // function rather than a redesign.
  //
  // Comma-splitting is naive - a value containing a literal "," would be cut
  // in half - which is fine today (no config() value needs one) but would
  // need a real scanner if a future key's value legitimately contains a
  // comma.
  function parseKwargsArgument(call, args) {
    var trimmed = args.trim();
    if (!trimmed) {
      throw new Error('model(): "' + call + '()" needs at least one key=\'value\' argument.');
    }
    var kwargPattern = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(['"])([^'"]*)\2$/;
    var result = {};
    trimmed.split(',').forEach(function (segment) {
      var match = kwargPattern.exec(segment.trim());
      if (!match) {
        throw new Error('model(): "' + call + '(' + args + ')" is not a valid call - every argument must be key=\'value\', e.g. ' + call + '(materialized=\'table\').');
      }
      var key = match[1];
      if (has(result, key)) {
        throw new Error('model(): "' + call + '(' + args + ')" sets "' + key + '" more than once.');
      }
      result[key] = match[3];
    });
    return result;
  }

  // The keys a model entry or the registry's top level may set as a
  // default. Kept as an explicit list rather than copying every key on
  // notsobigdataModels, so an unrelated key a user attaches to the registry
  // (notes, a comment, anything) never leaks into a model's resolved
  // config. dependsOn joins this list for the same reason a project-wide
  // materialized default is useful - a registry-wide "every model waits on
  // this" is a real shape (e.g. a shared staging load) - and it gets the
  // override behavior below (an entry's own dependsOn replaces the
  // registry's, not merges with it) for free, the same way materialized
  // already does. (Union-with-ref() semantics - dependsOn can never
  // suppress a real ref() - are enforced separately in mergeDependsOn()
  // below, not by this override.)
  var MODEL_DEFAULT_KEYS = ['projectId', 'dataset', 'materialized', 'dependsOn'];

  // The keys a {{ config(...) }} call inside a model's own SQL may set - see
  // extractConfigOverrides below. Kept separate from MODEL_DEFAULT_KEYS (even
  // though "materialized" is the only member of both lists today) since the
  // two lists answer different questions and may diverge: MODEL_DEFAULT_KEYS
  // is "what the registry may set as a default", this is "what the SQL file
  // itself may override inline" - projectId/dataset/dependsOn are registry
  // routing concerns a model's own SQL has no business changing, even once a
  // second config()-settable key beyond materialized eventually shows up.
  var MODEL_CONFIG_KEYS = ['materialized'];

  // The {{ name(...) }} calls compileModelSql() gives a built-in meaning -
  // see readMacroDefinitions() below. A user-authored macro reusing one of
  // these names would silently shadow the built-in project-wide (every
  // {{ ref(...) }} in every model, say, would stop meaning "resolve a
  // dependency"), with no error and no dependency edges - so a macro
  // declaration reusing one of these names is rejected outright, the same
  // "no obvious precedence, reject rather than guess" posture this file
  // already takes for a duplicate {% set %} name or a second config() call.
  var BUILTIN_TEMPLATE_CALLS = ['ref', 'config', 'var'];

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
      return { defaults: {}, models: {}, vars: {}, macroFiles: [] };
    }
    if (!isPlainObject(raw)) {
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
      if (!isPlainObject(raw.models)) {
        throw new Error('model(): notsobigdataModels.models must be an object - got ' + (Array.isArray(raw.models) ? 'an array' : typeof raw.models) + '.');
      }
      models = raw.models;
    }
    var vars = {};
    if (raw.vars !== undefined) {
      if (!isPlainObject(raw.vars)) {
        throw new Error('model(): notsobigdataModels.vars must be an object - got ' + (Array.isArray(raw.vars) ? 'an array' : typeof raw.vars) + '.');
      }
      Object.keys(raw.vars).forEach(function (key) {
        if (typeof raw.vars[key] !== 'string') {
          throw new Error('model(): notsobigdataModels.vars.' + key + ' must be a string - got ' + typeof raw.vars[key] + '.');
        }
      });
      vars = raw.vars;
    }
    var macroFiles = [];
    if (raw.macros !== undefined) {
      if (!Array.isArray(raw.macros)) {
        throw new Error('model(): notsobigdataModels.macros must be an array of file names - got ' + (isPlainObject(raw.macros) ? 'an object' : typeof raw.macros) + '.');
      }
      raw.macros.forEach(function (file, index) {
        if (typeof file !== 'string' || !file) {
          throw new Error('model(): notsobigdataModels.macros[' + index + '] must be a non-empty string - got ' + typeof file + '.');
        }
      });
      macroFiles = raw.macros;
    }
    return { defaults: defaults, models: models, vars: vars, macroFiles: macroFiles };
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
  // registry is optional - a caller that hasn't already read the registry
  // (there is no other one right now, but a future caller might) can omit
  // it and get a fresh read. Both current callers already have one in hand
  // (expandModelNodes() reads it once for every model it expands; model()
  // reads it once for however many ref()s its own SQL contains) and pass it
  // through, so resolving N models' configs never re-reads and re-validates
  // the same global N times over.
  //
  // has() is cli.js's guard against a model named e.g. "toString" or
  // "__proto__" testing as present in a plain {} it was never added to -
  // the same risk cli.js's own node/kind lookups already guard against, so
  // reused rather than re-implemented here.
  function resolveModelConfig(name, registry) {
    registry = registry || readModelsRegistry();
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

  // Reads one .html file's raw content. HtmlService reads a file that
  // lives in the Apps Script project itself, unlike move.js's
  // readDriveFileText (a Drive file, found by id) - models are project
  // source, not a data source. Separate from extractModelSql() below so
  // expandModelNodes() can read a shared file once and reuse it for every
  // model whose sqlFile points at it, rather than re-fetching per model.
  //
  // createHtmlOutputFromFile() takes the file's name as registered in the
  // project, which Google's own examples always give without the ".html"
  // extension (e.g. HtmlService.createHtmlOutputFromFile('Dialog') for a
  // file created as "Dialog.html") - sqlFile keeps its extension as a
  // config value, since "a model's SQL file" reads more naturally that way
  // and matches every fixture/example in this repo, but it's stripped here
  // before the actual API call so this matches the documented contract
  // rather than depending on any leniency the runtime may or may not have.
  function readModelHtml(sqlFile) {
    var scriptFileName = sqlFile.replace(/\.html$/i, '');
    try {
      return HtmlService.createHtmlOutputFromFile(scriptFileName).getContent();
    } catch (error) {
      throw new Error('model(): could not read "' + sqlFile + '" - ' + error.message + '. Every model needs a matching .html file - see README.md\'s "The model kind" section.');
    }
  }

  // Finds every <script type="text/sql"> tag in a file's content, in
  // whatever order its attributes appear (id before or after type). Each
  // tag's "id" is null when the attribute is absent - only extractModelSql()
  // below decides whether that's allowed, since that depends on how many
  // tags the file has.
  function extractSqlTags(html) {
    var tagPattern = /<script([^>]*)type=["']text\/sql["']([^>]*)>([\s\S]*?)<\/script>/gi;
    var idPattern = /\bid=["']([^"']*)["']/i;
    var tags = [];
    var match;
    while ((match = tagPattern.exec(html))) {
      var idMatch = idPattern.exec(match[1] + match[2]);
      tags.push({ id: idMatch ? idMatch[1] : null, sql: match[3] });
    }
    return tags;
  }

  // Picks the right SQL out of an already-read .html file for one named
  // model - see the module comment above for the three tag-count cases.
  // Takes the file's content rather than reading it itself, so a caller
  // (expandModelNodes() below) can read a shared file once and call this
  // once per model that points at it.
  function extractModelSql(html, sqlFile, modelName) {
    var tags = extractSqlTags(html);
    if (tags.length === 0) {
      return html.trim();
    }
    if (tags.length === 1) {
      var tag = tags[0];
      if (tag.id && tag.id !== modelName) {
        throw new Error('model(): "' + sqlFile + '" has one <script type="text/sql"> tag with id "' + tag.id + '", which does not match model "' + modelName + '".');
      }
      return tag.sql.trim();
    }
    var missingId = tags.some(function (candidate) { return !candidate.id; });
    if (missingId) {
      throw new Error('model(): "' + sqlFile + '" has more than one <script type="text/sql"> tag, so each one needs an "id" attribute matching a model name - found one without an id.');
    }
    var matches = tags.filter(function (candidate) { return candidate.id === modelName; });
    if (!matches.length) {
      throw new Error('model(): "' + sqlFile + '" has no <script type="text/sql" id="' + modelName + '"> tag. Ids found: ' + tags.map(function (candidate) { return candidate.id; }).join(', ') + '.');
    }
    if (matches.length > 1) {
      throw new Error('model(): "' + sqlFile + '" has more than one <script type="text/sql" id="' + modelName + '"> tag - ids must be unique within a file.');
    }
    return matches[0].sql.trim();
  }

  // The dependency-derivation hook: a model's ref() calls *are* its edges,
  // so a dependency is read out of the SQL instead of being hand-written -
  // see mergeDependsOn() below for the one other source of edges a model can
  // have (a hand-written dependsOn, naming a node ref() has no way to reach -
  // a move node with a non-bigquery target). Just extracts names here, with
  // no opinion on whether a name is a model or a move node - expandModelNodes()
  // below is what classifies each one and turns an unknown name into a
  // discoveryError. Takes matches already scanned off stripSqlComments()'s
  // output (move.js's own comment-stripping, reused rather than
  // re-implemented) rather than the raw SQL, so a ref() a user has commented
  // out (e.g. "-- from {{ ref('old_model') }}") doesn't become a real
  // dependency edge on a node that may not even exist any more. Shares that
  // one scan with extractConfigOverrides()/validateVarUsage() below - all
  // three read the same model's SQL at the same point in
  // expandModelNodes()'s per-model loop, so scanning once there instead of
  // once per function avoids stripping/tokenizing identical text three
  // times over.
  function extractRefDependencies(matches) {
    return matches
      .filter(function (expression) { return expression.call === 'ref'; })
      .map(function (expression) { return parseSingleStringArgument('ref', expression.args); });
  }

  // The config()-override-derivation hook, mirroring extractRefDependencies
  // above: a model's own {{ config(...) }} call (if any) sets values that win
  // over both the registry's project-wide defaults and the model's own
  // registry entry - the same "closest to the model wins" relationship dbt's
  // own inline config() has with dbt_project.yml. Takes the same
  // stripSqlComments()'d matches extractRefDependencies() does, for the same
  // reason - a commented-out config() call must not take effect, and the
  // scan is shared rather than repeated (see extractRefDependencies()'s
  // comment above).
  //
  // At most one config() call is allowed per model - unlike ref(), which is
  // expected to appear once per dependency, a second config() call setting
  // (or re-setting) the same or different keys has no obvious precedence
  // rule, so it's rejected outright rather than guessed at (last-wins,
  // first-wins, or a per-key merge would each be a silent, surprising choice
  // for whichever one wasn't picked).
  //
  // Every key returned is already validated against MODEL_CONFIG_KEYS here,
  // at discovery time, so expandModelNodes() below can merge the result
  // straight into a model's resolved config without a second whitelist check.
  function extractConfigOverrides(matches) {
    var calls = matches
      .filter(function (expression) { return expression.call === 'config'; });
    if (!calls.length) {
      return {};
    }
    if (calls.length > 1) {
      throw new Error('model(): SQL has ' + calls.length + ' {{ config(...) }} calls - at most one is allowed per model.');
    }
    var overrides = parseKwargsArgument('config', calls[0].args);
    Object.keys(overrides).forEach(function (key) {
      if (MODEL_CONFIG_KEYS.indexOf(key) === -1) {
        throw new Error('model(): config() set "' + key + '", which is not a supported key. Supported: ' + MODEL_CONFIG_KEYS.join(', ') + '.');
      }
    });
    return overrides;
  }

  // {% set %}: a model's own SQL can define one or more named string values
  // with {% set key = 'value' %} and read them back elsewhere in the *same*
  // file as a bare {{ key }} reference - a real Jinja statement, not a
  // {{ }} call standing in for one (see setStatementPattern()/
  // bareVarPattern() above), so it needs its own extraction/validation pair
  // rather than reusing scanTemplateExpressions(). File-local by design -
  // the value only exists to avoid repeating a literal twice in one query
  // (e.g. the same threshold in a WHERE and a HAVING), not to parameterize a
  // model from outside its own SQL. That's a different job from var() below,
  // which is project-level - the two used to be conflated into one
  // set()/var() pair (var() reading back whatever set() had just defined),
  // which was a mistake: real dbt's var() has nothing to do with {% set %}
  // at all, it reads a value from outside the model entirely. See
  // src/model.md's "set()/var() corrected to match real dbt/Jinja" note for
  // the fuller story.
  //
  // extractSetStatements() is the single source of truth both
  // validateSetUsage() (discovery, below) and compileModelSql() (run time)
  // call - scans stripSqlComments()'s output, same reasoning
  // extractRefDependencies() and extractConfigOverrides() already give: a
  // commented-out {% set %} must not define a usable value. Multiple
  // {% set %} statements are allowed (one per name) - only the same name
  // being set twice is rejected, the same "no obvious precedence" reasoning
  // config()'s at-most-one-call rule exists for.
  function extractSetStatements(sql) {
    var pattern = setStatementPattern();
    var stripped = stripSqlComments(sql);
    var values = {};
    var match;
    while ((match = pattern.exec(stripped))) {
      var key = match[1];
      if (has(values, key)) {
        throw new Error('model(): "' + key + '" is set by more than one {% set %} statement in this SQL.');
      }
      values[key] = match[3];
    }
    return values;
  }

  // Splits a comma-joined list into its top-level segments without cutting
  // a comma that sits *inside* a quoted item in half - parseForIterable()
  // below used to just call inner.split(','), which does exactly that:
  // ['open, pending', 'closed'] became "'open" and " pending'", neither a
  // valid quoted string, so the whole list threw even though it looks
  // well-formed to whoever wrote it. A plain char-by-char scan, tracking
  // whether the current position sits inside a quote, is enough here - no
  // escape-sequence support, same "simple string literal, no backslash
  // escaping" posture every other quoted value in this file already has
  // (parseSingleStringArgument, parseKwargsArgument, ...), so a quote
  // character can only ever open or close an item, never appear inside one
  // escaped.
  function splitTopLevelListItems(inner) {
    var items = [];
    var current = '';
    var quoteChar = null;
    for (var i = 0; i < inner.length; i++) {
      var ch = inner.charAt(i);
      if (quoteChar) {
        current += ch;
        if (ch === quoteChar) {
          quoteChar = null;
        }
        continue;
      }
      if (ch === '\'' || ch === '"') {
        quoteChar = ch;
        current += ch;
        continue;
      }
      if (ch === ',') {
        items.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    items.push(current);
    return items;
  }

  // The one argument shape {% for %} accepts: a literal, comma-separated
  // list of quoted strings - e.g. ['open', 'closed', 'cancelled']. Same
  // string-literal-only posture parseKwargsArgument/parseVarArguments
  // already take for config()/var() - no var()/ref() as the iterable, no
  // numbers/booleans, nothing beyond what a model author would otherwise
  // have hand-written as separate SQL fragments. raw still has its
  // surrounding "[" "]" from forStatementOpenPattern()'s own capture group,
  // stripped here rather than in the pattern itself so the pattern's capture
  // group can stay a simple "whatever's bracketed" instead of duplicating
  // this function's own item grammar.
  function parseForIterable(raw) {
    var inner = raw.slice(1, -1).trim();
    if (!inner) {
      throw new Error('model(): "{% for %}" list "' + raw + '" is empty - needs at least one quoted item, e.g. [\'a\', \'b\'].');
    }
    var itemPattern = /^\s*(['"])([^'"]*)\1\s*$/;
    return splitTopLevelListItems(inner).map(function (segment) {
      var match = itemPattern.exec(segment);
      if (!match) {
        throw new Error('model(): "{% for %}" list "' + raw + '" is not valid - every item must be a quoted string, e.g. [\'a\', \'b\'].');
      }
      return match[2];
    });
  }

  // {% for %}: repeats a block of SQL once per item in a literal list,
  // substituting a bare {{ x }} reference to the loop variable within that
  // block only (bareVarPattern()'s own shape, reused here as a fresh regex
  // per loop variable name rather than the shared function, since the name
  // to match isn't fixed the way {% set %}'s bareVarPattern scan is).
  //
  // This is a text-expansion PREPROCESSING pass, run once in
  // expandModelNodes() right after a model's SQL is read - before
  // extractConfigOverrides, validateSetUsage, validateVarUsage,
  // extractRefDependencies, or compileModelSql ever see it. By the time any
  // of those run, every {% for %} has already been resolved into plain SQL
  // text, so a ref()/config()/{% set %}/var() call *inside* a loop body is
  // handled by the existing pipeline for free, with zero changes needed to
  // compileModelSql()'s own dispatch - the same "an added case, not a
  // rewrite" reasoning the module comment above gives for config()/var(),
  // just one level earlier in the pipeline since {% for %} is a block, not
  // a single-token call.
  //
  // Deliberately non-nesting - same "single construct, not a general
  // evaluator" posture {% set %} already takes for its own right-hand side.
  // A {% for %} found inside another {% for %}'s own body is a clear error,
  // not a best-effort attempt at handling it (nesting would need the
  // non-greedy endfor search below to track depth, which is exactly the kind
  // of general-purpose parser this file has deliberately avoided since
  // templateExpressionPattern()'s own module comment). Processed
  // left-to-right, one block at a time, so several separate (non-nested)
  // {% for %} blocks in one model's SQL all expand correctly - each fully
  // resolved block is spliced back into the result and scanning resumes in
  // whatever text followed it.
  //
  // Using the loop variable as an argument to another call (e.g.
  // {{ ref(x) }}, {{ var(x) }}) is not supported - only the bare {{ x }}
  // shape is substituted, the same limit {% set %}'s own bareVarPattern
  // substitution already has. A model that needs that would be reaching for
  // a real expression evaluator, which is out of scope for the same reason
  // it always has been in this file.
  function expandForLoops(sql) {
    var openPattern = forStatementOpenPattern();
    var endPattern = forEndPattern();
    var result = '';
    var remaining = sql;
    var openMatch;
    while ((openMatch = openPattern.exec(remaining))) {
      var before = remaining.slice(0, openMatch.index);
      var afterOpen = remaining.slice(openMatch.index + openMatch[0].length);
      var varName = openMatch[1];
      var items = parseForIterable(openMatch[2]);
      var endMatch = endPattern.exec(afterOpen);
      if (!endMatch) {
        throw new Error('model(): "{% for ' + varName + ' in ... %}" has no matching "{% endfor %}".');
      }
      var body = afterOpen.slice(0, endMatch.index);
      if (openPattern.test(body)) {
        throw new Error('model(): "{% for ' + varName + ' in ... %}" contains a nested "{% for %}" - nesting is not supported.');
      }
      var bodyVarPattern = new RegExp('\\{\\{\\s*' + varName + '\\s*\\}\\}', 'g');
      var expanded = items.map(function (item) {
        return body.replace(bodyVarPattern, item);
      }).join('');
      result += before + expanded;
      remaining = afterOpen.slice(endMatch.index + endMatch[0].length);
    }
    result += remaining;
    if (endPattern.test(result)) {
      throw new Error('model(): SQL has a "{% endfor %}" with no matching "{% for %}".');
    }
    return result;
  }

  // {% macro name(a, b) %}...{% endmacro %}: a block construct declaring a
  // reusable, named span of SQL text with positional parameters - the same
  // "{% %}, not {{ }}" bracket shape {% set %}/{% for %} already use for a
  // real Jinja statement/block, rather than a {{ }} call standing in for a
  // value. Unlike a model's raw SQL, which has no way to self-identify (hence
  // extractSqlTags()/extractModelSql()'s <script id="..."> matching), a macro
  // block already names itself in its own opening statement - so several
  // macros can share one file with no wrapping tag or id attribute at all;
  // macroOpenPattern()'s own capture group is where the name comes from.
  function macroOpenPattern() {
    return /\{%\s*macro\s+([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]*)\)\s*%\}/;
  }

  function macroEndPattern() {
    return /\{%\s*endmacro\s*%\}/;
  }

  // A {% macro name(...) %} opening statement's own parameter list: zero or
  // more comma-separated bare identifiers, no defaults, no types - e.g.
  // macro(column) or macro(column, rate). Bare, not quoted: a parameter is a
  // *name* the macro's own body refers to via {{ column }}, not a value the
  // way {% for %}'s iterable items or config()'s kwarg values are (both of
  // which parseForIterable/parseKwargsArgument parse as quoted strings) - so
  // this parses identifiers instead, the same shape
  // templateExpressionPattern()'s own call-name capture already uses. An
  // empty list is valid (a zero-parameter macro).
  function parseMacroParams(name, raw) {
    var trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    var itemPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    var seen = emptyMap();
    return trimmed.split(',').map(function (segment) {
      var param = segment.trim();
      if (!itemPattern.test(param)) {
        throw new Error('model(): "{% macro ' + name + '(' + raw + ') %}" is not a valid parameter list - every parameter must be a bare name, e.g. macro(column, rate).');
      }
      if (has(seen, param)) {
        throw new Error('model(): "{% macro ' + name + '(' + raw + ') %}" declares parameter "' + param + '" more than once.');
      }
      seen[param] = true;
      return param;
    });
  }

  // Finds every {% macro name(params) %}...{% endmacro %} block in one
  // file's content, keyed by its own declared name - reusing
  // expandForLoops()'s left-to-right splice-and-resume scanning (re-slice the
  // remaining text after each block found, call .exec() fresh each time)
  // rather than a global regex's own lastIndex bookkeeping, for the same
  // "simpler to reason about once a match is used to cut the string, not
  // just collected" reason. A macro name declared twice *within this one
  // file* is rejected here; readMacroDefinitions() below rejects the same
  // name declared across *different* files, a distinct check since this
  // function only ever sees one file at a time. (A {% macro %} block nested
  // inside another isn't specifically detected - the inner block's own
  // {% endmacro %} would close the outer block early, leaving the outer's
  // real {% endmacro %} unmatched, which the stray-{% endmacro %} check below
  // still catches as a clear error rather than silently producing a
  // truncated macro body.)
  function extractMacroBlocks(html) {
    var openPattern = macroOpenPattern();
    var endPattern = macroEndPattern();
    var blocks = {};
    var remaining = html;
    var openMatch;
    while ((openMatch = openPattern.exec(remaining))) {
      var name = openMatch[1];
      var afterOpen = remaining.slice(openMatch.index + openMatch[0].length);
      var endMatch = endPattern.exec(afterOpen);
      if (!endMatch) {
        throw new Error('model(): "{% macro ' + name + '(...) %}" has no matching "{% endmacro %}".');
      }
      if (has(blocks, name)) {
        throw new Error('model(): macro "' + name + '" is declared more than once in the same file.');
      }
      blocks[name] = { params: parseMacroParams(name, openMatch[2]), body: afterOpen.slice(0, endMatch.index) };
      remaining = afterOpen.slice(endMatch.index + endMatch[0].length);
    }
    if (endPattern.test(remaining)) {
      throw new Error('model(): file has a "{% endmacro %}" with no matching "{% macro %}".');
    }
    return blocks;
  }

  // Reads every file notsobigdataModels.macros lists (reusing readModelHtml()
  // as-is - it doesn't care whether a file holds SQL or macro blocks) and
  // merges their extractMacroBlocks() results into one name -> {params, body}
  // map. A macro name declared in more than one *listed file* is a collision,
  // not a last-wins merge - same "no obvious precedence, reject rather than
  // guess" posture config()'s at-most-one-call-per-model and
  // extractSetStatements()'s duplicate-{% set %}-name checks already take
  // elsewhere in this file. Each macro's own source file is stashed on its
  // entry so the collision error can name both files.
  //
  // Also validates, once, that no macro's own body calls another declared
  // macro - not just direct self-calls, any call to any other name in the
  // merged map - which is what makes real cycle detection (a macro calling a
  // macro calling itself) unnecessary: if no macro may call any macro at all,
  // a cycle can't exist. Same "no general-purpose evaluator" scope discipline
  // {% for %}'s own deliberate no-nesting restriction already takes. Checked
  // here, once per registry build, rather than inside expandMacroCalls() on
  // every call site - cheaper (a project's macro files are typically small
  // and this only has to run once per cli() discovery pass, not once per
  // model that happens to call a macro), and checking the macro's own
  // undecorated body (before any call site's arguments are substituted into
  // it) avoids a call-site argument value that happens to *look like* a
  // macro call being mistaken for one.
  //
  // Called once per expandModelNodes() run, not once per model - macro files
  // are project-wide state, the same status registry itself already has, not
  // per-model state the way a model's own sqlFile is.
  function readMacroDefinitions(macroFiles) {
    var macros = emptyMap();
    macroFiles.forEach(function (file) {
      var blocks = extractMacroBlocks(readModelHtml(file));
      Object.keys(blocks).forEach(function (name) {
        if (BUILTIN_TEMPLATE_CALLS.indexOf(name) !== -1) {
          throw new Error('model(): macro "' + name + '" in "' + file + '" reuses a built-in name (' + BUILTIN_TEMPLATE_CALLS.join(', ') + ') - every {{ ' + name + '(...) }} call in the project would silently stop meaning the built-in. Rename the macro.');
        }
        if (has(macros, name)) {
          throw new Error('model(): macro "' + name + '" is declared in more than one file listed in notsobigdataModels.macros ("' + macros[name].file + '" and "' + file + '").');
        }
        blocks[name].file = file;
        macros[name] = blocks[name];
      });
    });
    Object.keys(macros).forEach(function (name) {
      scanTemplateExpressions(macros[name].body).forEach(function (expression) {
        if (has(macros, expression.call)) {
          throw new Error('model(): macro "' + name + '" calls another macro ("' + expression.call + '") - macro-to-macro calls are not supported.');
        }
      });
    });
    return macros;
  }

  // The argument shape a macro *call* site uses - positional, quoted strings
  // only, comma-separated - e.g. {{ cents_to_dollars('amount') }} or
  // {{ to_eur('amount', '0.92') }}. Same string-literal-only posture every
  // other call in this file takes (parseSingleStringArgument/
  // parseKwargsArgument/parseVarArguments/parseForIterable) - no numbers, no
  // nested calls, no expressions. An empty argument list is valid (a call to
  // a zero-parameter macro), unlike parseForIterable's list, which must have
  // at least one item.
  function parseMacroCallArguments(call, args) {
    var trimmed = args.trim();
    if (!trimmed) {
      return [];
    }
    var itemPattern = /^(['"])([^'"]*)\1$/;
    return trimmed.split(',').map(function (segment) {
      var match = itemPattern.exec(segment.trim());
      if (!match) {
        throw new Error('model(): "' + call + '(' + args + ')" is not a valid macro call - every argument must be a quoted string, e.g. ' + call + '(\'value\').');
      }
      return match[2];
    });
  }

  // {{ name(args) }}: a call to a user-authored macro, declared in one of the
  // files notsobigdataModels.macros lists - the dbt-style equivalent of
  // calling a macro out of a project's own macros/ directory. Like {% for %}'s
  // expandForLoops() above, this is a text-expansion PRE-PASS, run once per
  // model in expandModelNodes() right after expandForLoops() and before
  // extractConfigOverrides()/validateSetUsage()/validateVarUsage()/
  // extractRefDependencies() or compileModelSql() ever see the SQL - a
  // {{ ref(...) }} or {{ var(...) }} living inside a macro's own body is
  // picked up "for free" by those existing scans once expansion has already
  // replaced the call with the macro's literal text, the same reasoning
  // expandForLoops()'s own module comment gives for a loop body.
  //
  // A call name that ISN'T a known macro is left untouched (the raw match is
  // returned as-is) rather than treated as an error here - it might be
  // ref()/config()/var(), which this function has no business validating;
  // compileModelSql()'s own dispatch (or its "unsupported template call"
  // throw) is still the single place that decides a name is invalid.
  // expandMacroCalls() only ever answers "is this a macro", never "is this a
  // legal call".
  function expandMacroCalls(sql, macros) {
    return sql.replace(templateExpressionPattern(), function (raw, call, args) {
      if (!has(macros, call)) {
        return raw;
      }
      var macro = macros[call];
      var callArgs = parseMacroCallArguments(call, args);
      if (callArgs.length !== macro.params.length) {
        throw new Error('model(): {{ ' + call + '(...) }} takes ' + macro.params.length
          + ' argument(s) (' + macro.params.join(', ') + ') - got ' + callArgs.length + '.');
      }
      var body = macro.body;
      macro.params.forEach(function (param, i) {
        var paramPattern = new RegExp('\\{\\{\\s*' + param + '\\s*\\}\\}', 'g');
        body = body.replace(paramPattern, callArgs[i]);
      });
      return body;
    });
  }

  // The discovery-time check for bare {{ key }} references: every one in the
  // file must resolve against extractSetStatements()'s map, or it's a
  // reference to a name that was never {% set %}. Same "fail loud at
  // validation time, not two calls later" posture as validateModelTests()
  // and extractConfigOverrides()'s key whitelist. Called from
  // expandModelNodes()'s existing per-model try/catch, so a bad reference
  // becomes that model's own discoveryError, caught by cli('list') before
  // any real run.
  function validateSetUsage(sql, messagePrefix) {
    var values = extractSetStatements(sql);
    var pattern = bareVarPattern();
    var stripped = stripSqlComments(sql);
    var match;
    while ((match = pattern.exec(stripped))) {
      var name = match[1];
      if (!has(values, name)) {
        throw new Error(messagePrefix + ' {{ ' + name + ' }} references "' + name + '", which is never set via {% set ' + name + ' = ... %} in this SQL.');
      }
    }
  }

  // var(): real dbt semantics, not this library's own invention - reads a
  // project-level value from notsobigdataModels.vars (the model-SQL
  // equivalent of dbt_project.yml's vars: section), with an optional second
  // argument as a default when the key isn't set there. Deliberately has no
  // relationship to {% set %} above (a real dbt model's {% set %} value is
  // never read back through var() either - it's referenced by bare name).
  //
  // Both validateVarUsage() (discovery, below) and resolveVar() (run time,
  // called from compileModelSql()) share this one resolution rule, so a
  // var() that will fail at run time is already caught at discovery instead.
  function resolveVar(registry, name, hasDefault, defaultValue) {
    if (has(registry.vars, name)) {
      return registry.vars[name];
    }
    if (hasDefault) {
      return defaultValue;
    }
    throw new Error('model(): {{ var(\'' + name + '\') }} references "' + name + '", which is not set in notsobigdataModels.vars and has no default.');
  }

  // The var()-side of discovery-time validation: every {{ var(...) }} call
  // must resolve - either notsobigdataModels.vars has the key, or the call
  // supplies its own default - same "fail loud at validation time, not two
  // calls later" posture validateSetUsage() takes for bare {{ key }}
  // references. Same resolution rule as resolveVar() above, duplicated
  // rather than shared so this can embed messagePrefix the same way every
  // other discovery-time validate* function in this file does - resolveVar()
  // itself is also called at run time (from compileModelSql()), where no
  // per-model prefix is available. Called from expandModelNodes()'s existing
  // per-model try/catch, so a bad var() becomes that model's own
  // discoveryError, caught by cli('list') before any real run. Takes the
  // same stripSqlComments()'d matches extractRefDependencies()/
  // extractConfigOverrides() do, for the same shared-scan reason.
  function validateVarUsage(matches, registry, messagePrefix) {
    matches
      .filter(function (expression) { return expression.call === 'var'; })
      .forEach(function (expression) {
        var parsed = parseVarArguments('var', expression.args);
        if (!parsed.hasDefault && !has(registry.vars, parsed.name)) {
          throw new Error(messagePrefix + ' {{ var(\'' + parsed.name + '\') }} references "' + parsed.name + '", which is not set in notsobigdataModels.vars and has no default.');
        }
      });
  }

  // Unions a model's {{ ref() }}-derived edges with its hand-written
  // dependsOn (see MODEL_DEFAULT_KEYS above for where that value comes
  // from - a model entry's own dependsOn, or the registry's project-wide
  // default), preserving first-seen order and dropping duplicates. The
  // union is deliberate, not a merge choice made lightly: dependsOn is for
  // naming a node ref() cannot reach (a move node, by convention - see
  // docs/model.md), and must never be able to suppress an edge the SQL
  // itself already declares via a real ref(). Reuses cli.js's
  // emptyMap()/has() rather than Array#indexOf, same prototype-pollution
  // reasoning as every other name-keyed lookup in this library.
  function mergeDependsOn(refDeps, handWrittenDeps) {
    var seen = emptyMap();
    var merged = [];
    refDeps.concat(handWrittenDeps).forEach(function (name) {
      if (has(seen, name)) {
        return;
      }
      seen[name] = true;
      merged.push(name);
    });
    return merged;
  }

  // Substitutes every {{ ref('x') }} with x's resolved, backtick-quoted
  // relation - same quoting convention move.js's resolveBigQuerySql already
  // uses for an interpolated table identifier. resolveRef is expected to
  // throw on an unknown name (resolveModelConfig does), which this function
  // deliberately does not catch: ref substitution is string interpolation
  // into SQL that runs with the script owner's live BigQuery credentials,
  // so an unresolved name must stop the run, never fall through as literal
  // text.
  //
  // {{ config(...) }} is stripped to '' - its values were already folded into
  // node.config back in expandModelNodes(), so by the time this runs the call
  // has nothing left to do except disappear from the compiled statement.
  // parseKwargsArgument is still called here (its result discarded) rather
  // than just matching the call name, so a config() call this SQL string
  // carries that somehow differs from the one discovery already validated
  // (there is no legitimate way for that to happen today, since config.sql is
  // set once and never mutated - but ref() gets this same redundant
  // re-validation on every compile, and diverging from that precedent for
  // config() only would be its own small surprise) still throws instead of
  // silently vanishing.
  //
  // {{ var(...) }} resolves via resolveVar() above - notsobigdataModels.vars
  // (registry is the caller's, same one it already read for ref()
  // resolution) or the call's own default.
  //
  // {% set key = 'value' %} strips to '' after this first pass, in its own
  // second replace() below - it's a different bracket shape ({% %}, not
  // {{ }}), so templateExpressionPattern()'s call-shaped regex never matches
  // it in the first place. A bare {{ key }} reference is resolved in a third
  // pass, against setValues (computed once up front, before either replace()
  // pass, the same "once per compile, not once per match" reasoning ref()'s
  // own resolution already has) - validateSetUsage() already ran this same
  // scan at discovery time, so a {{ key }} reaching this function with no
  // matching {% set %} is not expected, but the lookup still throws instead
  // of substituting undefined, for the same defense-in-depth reason ref()
  // and config() both re-validate here rather than trusting discovery alone.
  //
  // Any *other* {{ name(...) }} call is rejected the same way ref()'s
  // unknown name is, for the same reason - see the module comment above
  // about growing this dispatch.
  //
  // A commented-out call (e.g. "-- {{ var('region') }}") must be inert here
  // the same way it already is at discovery: extractRefDependencies()/
  // extractConfigOverrides()/validateVarUsage()/validateSetUsage() all scan
  // stripSqlComments()'d SQL, so a commented-out call never becomes a
  // dependency edge or gets its var() validated against notsobigdataModels.vars.
  // Before this function guarded against it too, that asymmetry meant a
  // commented-out call passed cli('list') clean but could still throw at
  // cli('run')/cli('compile') - this function scanned the raw, un-stripped
  // sql. commentSpans()/isCommentedOut() below let each pass skip a match
  // that falls inside a comment (returning it unchanged) without stripping
  // the comment text out of the compiled SQL - unlike discovery, which only
  // needs to *ignore* comments, this function has to *emit* them unchanged,
  // since a real, non-macro SQL comment is legitimate output.
  function commentSpans(text) {
    var spans = [];
    [/--[^\n]*/g, /\/\*[\s\S]*?\*\//g].forEach(function (pattern) {
      var match;
      while ((match = pattern.exec(text))) {
        spans.push([match.index, match.index + match[0].length]);
      }
    });
    return spans;
  }

  function isCommentedOut(spans, offset) {
    return spans.some(function (span) { return offset >= span[0] && offset < span[1]; });
  }

  function compileModelSql(sql, resolveRef, registry) {
    var setValues = extractSetStatements(sql);
    var refConfigVarSpans = commentSpans(sql);
    var compiled = sql.replace(templateExpressionPattern(), function (raw, call, args, offset) {
      if (isCommentedOut(refConfigVarSpans, offset)) {
        return raw;
      }
      if (call === 'config') {
        parseKwargsArgument('config', args);
        return '';
      }
      if (call === 'var') {
        var parsed = parseVarArguments('var', args);
        return resolveVar(registry, parsed.name, parsed.hasDefault, parsed.defaultValue);
      }
      if (call !== 'ref') {
        throw new Error('model(): unsupported template call "' + call + '(...)" in SQL - only ref(), config() and var() are implemented so far, '
          + 'and this name did not match any macro declared in notsobigdataModels.macros either.');
      }
      return resolveRef(parseSingleStringArgument('ref', args));
    });
    // Spans recomputed against `compiled`, not reused from refConfigVarSpans
    // above - the first pass above never touches a comment's own text (a
    // commented-out match returns unchanged), so comment syntax still exists
    // to find, just possibly at different offsets since substitutions
    // outside comments changed the string's length.
    var setSpans = commentSpans(compiled);
    compiled = compiled.replace(setStatementPattern(), function (raw, key, quote, value, offset) {
      return isCommentedOut(setSpans, offset) ? raw : '';
    });
    var bareVarSpans = commentSpans(compiled);
    compiled = compiled.replace(bareVarPattern(), function (raw, name, offset) {
      if (isCommentedOut(bareVarSpans, offset)) {
        return raw;
      }
      if (!has(setValues, name)) {
        throw new Error('model(): {{ ' + name + ' }} references "' + name + '", which is never set via {% set ' + name + ' = ... %} in this SQL.');
      }
      return setValues[name];
    });
    // templateExpressionPattern()'s args group is [^)]* - it can't match a
    // call containing its own ")" (e.g. a ref() argument with a stray
    // paren, or a macro call nesting another call), so that span is skipped
    // over entirely rather than reaching the "unsupported call" check above.
    // Left alone, that malformed placeholder would ship to BigQuery as
    // literal, unsubstituted "{{ ... }}"/"{% ... %}" text instead of being
    // rejected - exactly the failure mode the module comment above says the
    // generic scanner exists to avoid. Checking for both "{{" and "{%"
    // catches a malformed {% set %} (or an unimplemented {% if %}) the same
    // way it already catches a malformed {{ ref(...) }}.
    //
    // A leftover "{{"/"{%" inside a comment is not this failure mode - it's
    // the commented-out, deliberately-untouched syntax the three passes
    // above just left alone - so this scan skips any occurrence inside a
    // comment span the same way those passes did, rather than flagging
    // every commented-out macro call as a malformed one.
    var strayPattern = /\{\{|\{%/g;
    var straySpans = commentSpans(compiled);
    var strayMatch;
    while ((strayMatch = strayPattern.exec(compiled))) {
      if (!isCommentedOut(straySpans, strayMatch.index)) {
        throw new Error('model(): SQL still contains "{{" or "{%" after substitution - check for a malformed template call or {% set %} statement.');
      }
    }
    return compiled;
  }

  // Builds config.name's fully-qualified relation, reusing move.js's own
  // qualifiedTableRef() for the actual backtick-quoting so a model's
  // relation and a bigquery source/test's table reference are spelled the
  // same way by construction. ['projectId', 'dataset'] loops rather than two
  // near-identical if/throw blocks, since both checks are the same shape
  // and only differ in which key and word they name.
  function qualifiedRelation(config) {
    ['projectId', 'dataset'].forEach(function (key) {
      if (!config[key]) {
        throw new Error('model(): "' + config.name + '" is missing "' + key + '" - set it on notsobigdataModels or on this model entry.');
      }
    });
    return qualifiedTableRef(config.projectId, config.dataset, config.name);
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

  // The check names a model's own tests[] entries may use for a "generic"
  // (dbt-style) test - not_null, unique, accepted_values, relationships:
  // dbt's own four built-in generic tests. Deliberately not move.js's
  // extra tests[] vocabulary (min/max/regex) - those are row-level checks
  // over an in-memory 2D array (see move.js's KNOWN_CHECKS) and don't apply
  // to a materialized relation; a custom query test below already covers
  // that same ground trivially (e.g. "WHERE amount < 0"). Checked by array
  // membership rather than object-property lookup, same prototype-pollution
  // reasoning as move.js's own KNOWN_CHECKS/isKnownCheck - check is a
  // config-supplied string, and a plain {} object already "has" toString,
  // constructor and friends.
  var MODEL_TEST_KNOWN_CHECKS = ['not_null', 'unique', 'accepted_values', 'relationships'];

  function isKnownModelTestCheck(check) {
    return MODEL_TEST_KNOWN_CHECKS.indexOf(check) !== -1;
  }

  // Extra config key each generic check needs beyond "column" - same "fail
  // loud at validation time, not two calls later" reasoning as move.js's
  // TEST_CHECK_REQUIRES. Object.create(null) for the same reason: test.check
  // is config-supplied, not a hardcoded key.
  var MODEL_TEST_REQUIRES = Object.create(null);
  MODEL_TEST_REQUIRES.accepted_values = 'values';
  MODEL_TEST_REQUIRES.relationships = 'to';

  // Backtick-quotes a column/field name for interpolation into generated
  // test SQL - MODEL_TEST_COMPILERS below builds SQL text out of
  // config-supplied identifiers (test.column, test.field), and an unquoted
  // identifier that happens to be a reserved word (order, group, ...) would
  // otherwise break. Throws rather than stripping a stray backtick or
  // backslash, since a name that already contains either can't be safely
  // quoted at all - a backtick-quoted identifier uses the same backslash
  // escape sequences a string literal does (see quoteSqlLiteral below), so
  // a trailing backslash could otherwise escape the closing backtick the
  // same way it can escape a string literal's closing quote. Same "reject,
  // don't guess" posture as every other config-shape check in this file -
  // a real BigQuery column name has no legitimate use for either character.
  function quoteIdentifier(name) {
    if (name.indexOf('`') !== -1 || name.indexOf('\\') !== -1) {
      throw new Error('model(): "' + name + '" is not a valid column/field name - it contains a backtick or backslash.');
    }
    return '`' + name + '`';
  }

  // Renders one accepted_values entry as a SQL literal - numbers/booleans
  // unquoted, strings single-quoted with a backslash escaped first, then an
  // embedded "'" (valid GoogleSQL string-literal escaping, matching the
  // useLegacySql: false this whole file already runs under). Escaping "\"
  // before "'" matters, not just for style: a value ending in an odd number
  // of backslashes would otherwise turn the escaped-quote sequence this
  // function emits for the *next* value into an escaped quote inside the
  // *current* one, closing the literal in the wrong place and letting
  // whatever text follows (the rest of a comma-joined values list) be
  // parsed as SQL instead of string content. Scoped narrowly to what
  // accepted_values needs (test.values is config-supplied text landing in
  // generated SQL, same trust model as everything else in this file), not a
  // general-purpose SQL serializer - nothing else needs one yet.
  function quoteSqlLiteral(value) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (typeof value === 'string') {
      return '\'' + value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') + '\'';
    }
    throw new Error('model(): accepted_values "values" entries must be a string, number, or boolean - got ' + typeof value + '.');
  }

  // Confirms one tests[] entry is well-formed before it's ever compiled to
  // SQL or resolved against the registry - exactly one of check/query set,
  // a known check, its required extra key, an accepted_values "values" that
  // is a non-empty array of safely quotable literals, no backtick smuggled
  // into an identifier. All of this is checked up front, inside
  // expandModelNodes()'s own try/catch, so a bad test becomes that model's
  // own discoveryError - caught by cli('list'), not just a real run - same
  // "validated even before there's data to check" posture move.js's own
  // validateTest takes for config.tests.
  //
  // registry is needed for exactly one check: a "relationships" test's "to"
  // must name a declared model, not just any node. Before this check
  // existed, "to" naming a real node of any kind (e.g. a move node, which
  // extractTestRefDependencies() below is happy to turn into a dependsOn
  // edge the same way it would a model) passed discovery clean, only for
  // MODEL_TEST_COMPILERS.relationships's own resolveModelConfig() call to
  // throw "is not declared in notsobigdataModels.models" once the model had
  // already materialized (CREATE OR REPLACE already ran, and for a "table"
  // materialization, modelTableStaged() had already created its staging
  // table) - a discovery-time check should have caught this before any
  // BigQuery work started, the same way every other "to"/"ref()" mismatch
  // in this file already does.
  function validateModelTest(test, messagePrefix, registry) {
    if (!test || typeof test !== 'object') {
      throw new Error(messagePrefix + ' every "tests" entry must be an object.');
    }
    var hasCheck = test.check !== undefined;
    var hasQuery = test.query !== undefined;
    if (hasCheck === hasQuery) {
      throw new Error(messagePrefix + ' every "tests" entry needs exactly one of "check" (a generic test) or "query" (a custom test).');
    }
    if (hasQuery) {
      if (typeof test.query !== 'string' || !test.query) {
        throw new Error(messagePrefix + ' a custom test\'s "query" must be a non-empty string.');
      }
      return;
    }
    if (typeof test.check !== 'string' || !isKnownModelTestCheck(test.check)) {
      throw new Error(messagePrefix + ' test has an unsupported "check" ("' + test.check + '"). Expected one of: ' + MODEL_TEST_KNOWN_CHECKS.join(', ') + '.');
    }
    if (typeof test.column !== 'string' || !test.column) {
      throw new Error(messagePrefix + ' test (check "' + test.check + '") needs a "column" (a non-empty string).');
    }
    quoteIdentifier(test.column);
    var requiredKey = MODEL_TEST_REQUIRES[test.check];
    if (requiredKey && test[requiredKey] === undefined) {
      throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "' + test.check + '") requires "' + requiredKey + '".');
    }
    if (test.check === 'accepted_values') {
      if (!Array.isArray(test.values) || !test.values.length) {
        throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "accepted_values") requires "values" to be a non-empty array.');
      }
      test.values.forEach(quoteSqlLiteral);
    }
    if (test.check === 'relationships') {
      if (typeof test.to !== 'string' || !test.to) {
        throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "relationships") requires "to" (another model\'s name).');
      }
      if (!has(registry.models, test.to)) {
        throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "relationships") has "to": "' + test.to
          + '", which is not a declared model. Known models: ' + Object.keys(registry.models).join(', ') + '.');
      }
      if (test.field !== undefined) {
        if (typeof test.field !== 'string' || !test.field) {
          throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "relationships") has an invalid "field" - must be a non-empty string.');
        }
        quoteIdentifier(test.field);
      }
    }
  }

  function validateModelTests(tests, messagePrefix, registry) {
    if (tests === undefined) {
      return;
    }
    if (!Array.isArray(tests)) {
      throw new Error(messagePrefix + ' "tests" must be an array of test objects.');
    }
    tests.forEach(function (test) { validateModelTest(test, messagePrefix, registry); });
  }

  // The name a compiled test reports itself as in a failure message, when
  // the model author didn't set test.name - e.g. not_null_customer_id,
  // relationships_customer_id_to_stg_customers - mirroring dbt's own
  // generated test names closely enough to be recognizable.
  function defaultModelTestName(test) {
    if (test.check === 'relationships') {
      return 'relationships_' + test.column + '_to_' + test.to;
    }
    return test.check + '_' + test.column;
  }

  // One query-builder per generic check, each producing a query string that
  // still contains the literal "{{ this }}" placeholder - substitution
  // happens once, inside move.js's runSqlTests, not duplicated here. Every
  // query follows the same dbt generic-test contract runSqlTests already
  // expects: return the offending rows, zero rows back means the check
  // passed. Object.create(null) and MODEL_TEST_KNOWN_CHECKS-based dispatch
  // (never CELL_CHECKS-style truthiness) for the same prototype-pollution
  // reason move.js's own CELL_CHECKS/TEST_CHECK_REQUIRES already are -
  // test.check is a config-supplied string.
  var MODEL_TEST_COMPILERS = Object.create(null);
  MODEL_TEST_COMPILERS.not_null = function (test) {
    var column = quoteIdentifier(test.column);
    return 'SELECT * FROM {{ this }} WHERE ' + column + ' IS NULL';
  };
  MODEL_TEST_COMPILERS.unique = function (test) {
    var column = quoteIdentifier(test.column);
    return 'SELECT ' + column + ' FROM {{ this }} GROUP BY ' + column + ' HAVING COUNT(*) > 1';
  };
  MODEL_TEST_COMPILERS.accepted_values = function (test) {
    var column = quoteIdentifier(test.column);
    var values = test.values.map(quoteSqlLiteral).join(', ');
    return 'SELECT * FROM {{ this }} WHERE ' + column + ' NOT IN (' + values + ')';
  };
  // relationships needs the registry to resolve "to" into a real relation -
  // the same resolveModelConfig()+qualifiedRelation() pair compileModelSql's
  // own ref() substitution already uses above, reused here rather than a
  // second way to look up a model's relation. The child column's own
  // "IS NOT NULL" guard is deliberate: a NULL foreign key isn't a
  // referential-integrity violation (pair with a not_null test if that
  // matters), matching dbt's own relationships test.
  MODEL_TEST_COMPILERS.relationships = function (test, registry) {
    var column = quoteIdentifier(test.column);
    var field = quoteIdentifier(test.field || test.column);
    var toRelation = qualifiedRelation(resolveModelConfig(test.to, registry));
    return 'SELECT ' + column + ' FROM {{ this }} WHERE ' + column + ' IS NOT NULL AND '
      + column + ' NOT IN (SELECT ' + field + ' FROM ' + toRelation + ')';
  };

  // Turns every tests[] entry into the {name, query} shape move.js's
  // runSqlTests expects - a custom entry (test.query) passes through as-is;
  // a generic entry (test.check) compiles via MODEL_TEST_COMPILERS. registry
  // is only actually used by "relationships"' to-resolution, but passed to
  // every compiler uniformly rather than special-casing one check's own
  // signature.
  function compileModelTests(tests, registry) {
    return tests.map(function (test) {
      if (test.query) {
        return { name: test.name, query: test.query };
      }
      return { name: test.name || defaultModelTestName(test), query: MODEL_TEST_COMPILERS[test.check](test, registry) };
    });
  }

  // The dependency-derivation hook for "relationships" tests, mirroring
  // extractRefDependencies above for {{ ref() }}: a relationships test's
  // "to" is a real edge to another model - this model can't meaningfully be
  // tested against a model that hasn't run yet - so it has to be
  // discoverable the same cheap, SQL-free way {{ ref() }}'s names are,
  // without resolving anything against the registry yet (that happens once,
  // at compile time, in MODEL_TEST_COMPILERS.relationships above).
  function extractTestRefDependencies(tests) {
    return (tests || [])
      .filter(function (test) { return test && test.check === 'relationships'; })
      .map(function (test) { return test.to; });
  }

  // The other half of what {{ ref() }} can resolve, alongside a model name:
  // a move node whose target is bigquery. Built once per expandModelNodes()
  // call (not once per model - move nodes are project-wide state, the same
  // reasoning readMacroDefinitions() is hoisted above the per-model loop
  // below), from the node list cli.js's discoverNodes() already scanned
  // before calling here. Keyed by node name -> its qualifiedTableRef(), the
  // exact string a ref() substitutes in, computed once here rather than at
  // every model's compile time (compileModelSql() in model() below just
  // looks this up).
  //
  // Missing projectId/dataset/table on a bigquery target is deliberately not
  // an error here - that is move()'s own config to validate (loadBigQuery
  // already throws for it), not something this index has any business
  // re-checking; such a node simply doesn't make it into the index, so a
  // ref() naming it fails the same "does not match a declared model or a
  // bigquery-target move node" way a typo would.
  function indexMoveBigQueryTargets(otherNodes) {
    var index = emptyMap();
    (otherNodes || []).forEach(function (node) {
      var target = node.kind === 'move' && node.config ? node.config.target : null;
      if (!target || target.type !== 'bigquery' || !target.projectId || !target.dataset || !target.table) {
        return;
      }
      index[node.name] = qualifiedTableRef(target.projectId, target.dataset, target.table);
    });
    return index;
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
  //
  // htmlCache is scoped to this one call, keyed by sqlFile: several models
  // can now share one file (see the module comment above), so without this
  // a shared file would be re-read from HtmlService once per model instead
  // of once total. Caches a read failure too (as { error }), not just a
  // success - several models can share one broken file just as easily as a
  // working one, and without this every one of them would retry the same
  // doomed HtmlService call. Reuses cli.js's has()/emptyMap()
  // prototype-pollution guards for the same reason readModelsRegistry()
  // does - sqlFile is a caller-chosen string, same risk class as a node or
  // model name.
  //
  // One model's own config/file/tag problem must not take down discovery
  // for every other node in the project - move nodes included, since this
  // is folded into the same discoverNodes() scan they come from. Each
  // model's own try/catch below is what makes that true: a bad sqlFile,
  // mismatched tag id, or duplicate id becomes that one node's own
  // discoveryError (a plain node-level field, not nested in config - cli.js's
  // runNodes() checks it kind-agnostically, the same way it already checks
  // dependsOn) instead of an exception that unwinds discoverNodes() itself
  // and hides every node, of any kind, from cli("hello")/cli("list")/
  // cli("run --select ...") alike. A malformed notsobigdataModels/
  // registry.models shape is deliberately not covered here -
  // readModelsRegistry() above still throws for that, since it's a mistake
  // in the one shared config every model reads, not one model's own problem.
  //
  // discoveryError is deliberately still reported by a dry "list" run, not
  // only a real "run" - cli("list")'s whole point is surfacing a config
  // mistake before anything executes for real, and this kind of error is
  // already fully known at discovery time (no BigQuery call needed to see
  // it), so deferring it to a real run would make "list" strictly less
  // useful for exactly the errors that are cheapest to catch early.
  function expandModelNodes(otherNodes) {
    var registry = readModelsRegistry();
    var moveBigQueryTargets = indexMoveBigQueryTargets(otherNodes);
    // Read once, hoisted above the per-model loop below - macro files are
    // project-wide state, the same status registry itself already has, not
    // per-model state the way a model's own sqlFile is. Deliberately NOT
    // wrapped in a per-model try/catch (unlike everything inside the loop
    // below): a malformed macros.html, a cross-file name collision, or a
    // macro-to-macro call is a mistake in shared config every model might
    // read, not any one model's own problem - same reasoning
    // readModelsRegistry() above is already allowed to throw here for the
    // same class of shared-config mistake.
    var macros = readMacroDefinitions(registry.macroFiles);
    var htmlCache = emptyMap();
    function readCached(sqlFile) {
      if (!has(htmlCache, sqlFile)) {
        try {
          htmlCache[sqlFile] = { content: readModelHtml(sqlFile) };
        } catch (error) {
          htmlCache[sqlFile] = { error: error.message };
        }
      }
      return htmlCache[sqlFile];
    }
    return Object.keys(registry.models).map(function (name) {
      var node = {
        name: name,
        kind: 'model',
        variable: 'notsobigdataModels.models.' + name,
        config: { name: name },
        dependsOn: []
      };
      try {
        var config = resolveModelConfig(name, registry);
        var cached = readCached(config.sqlFile);
        if (cached.error) {
          throw new Error(cached.error);
        }
        config.sql = extractModelSql(cached.content, config.sqlFile, name);
        // {% for %} expands before anything else scans this SQL - see
        // expandForLoops()'s own comment for why this has to run first, not
        // as another case in compileModelSql()'s dispatch.
        config.sql = expandForLoops(config.sql);
        // {{ macro(...) }} calls expand next, after {% for %} (so a macro
        // call written inside a loop body is expanded once per iteration for
        // free) and before everything below - see expandMacroCalls()'s own
        // comment for why a ref()/var() living inside a macro body is picked
        // up "for free" by the scans that follow.
        config.sql = expandMacroCalls(config.sql, macros);
        // One scan of this model's stripSqlComments()'d SQL, shared by the
        // three extractors/validators below - see extractRefDependencies()'s
        // own comment for why scanning once here beats each of them
        // stripping and re-tokenizing the same text independently.
        var templateMatches = scanTemplateExpressions(stripSqlComments(config.sql));
        // {{ config(...) }} overrides applied after resolveModelConfig()'s own
        // defaults+entry merge, so a model's own SQL wins over both the
        // registry's project-wide default and its own registry entry - see
        // extractConfigOverrides above.
        var configOverrides = extractConfigOverrides(templateMatches);
        Object.keys(configOverrides).forEach(function (key) { config[key] = configOverrides[key]; });
        validateModelTests(config.tests, 'model(): "' + name + '"', registry);
        validateSetUsage(config.sql, 'model(): "' + name + '"');
        validateVarUsage(templateMatches, registry, 'model(): "' + name + '"');
        // Every {{ ref(...) }} name must resolve to something - a declared
        // model (unchanged, handled by model()'s own resolveRef at compile
        // time) or a bigquery-target move node (resolved right here, once,
        // rather than re-scanning the global for it on every compile - see
        // moveBigQueryTargets above). Anything else is a discoveryError, same
        // "fail loud at validation time, not two calls later" posture as
        // every other check in this loop - without this, a typo'd or
        // non-bigquery move node name would only surface once model() itself
        // ran and its resolveRef fallback found nothing.
        var refNames = extractRefDependencies(templateMatches);
        // emptyMap(), not {} - same reason every other name-keyed map in
        // this library uses it (see cli.js's own emptyMap() comment): a move
        // node literally named "__proto__" is a real, if wacky, possible key
        // here, and a plain {} would silently swallow that assignment (sets
        // the prototype, not an own property) instead of storing it.
        var moveRefTargets = emptyMap();
        refNames.forEach(function (refName) {
          if (has(registry.models, refName)) {
            return;
          }
          if (has(moveBigQueryTargets, refName)) {
            moveRefTargets[refName] = moveBigQueryTargets[refName];
            return;
          }
          throw new Error('model(): "' + name + '" has {{ ref(\'' + refName + '\') }}, which does not match a declared model or a move node with a bigquery target. Known models: '
            + Object.keys(registry.models).join(', ') + '. Known bigquery-target move nodes: ' + Object.keys(moveBigQueryTargets).join(', ') + '.');
        });
        config.moveRefTargets = moveRefTargets;
        // Computed from config.dependsOn (whichever hand-written value won
        // MODEL_DEFAULT_KEYS's override), then deleted off config - node.config
        // must not keep its own, pre-merge "dependsOn" once node.dependsOn
        // holds the real, merged edges below; two dependsOn-shaped values on
        // one node, disagreeing with each other, is exactly the kind of stale
        // state that confuses whoever inspects a node's config next.
        var handWritten = parseDependsOnList('model(): "' + name + '"', config.dependsOn);
        delete config.dependsOn;
        node.config = config;
        // A relationships test's "to" is unioned in alongside {{ ref() }}'s
        // own edges - see extractTestRefDependencies above - so a model
        // never runs (or is tested) against a relation that hasn't been
        // built yet, the same guarantee {{ ref() }} already gives.
        node.dependsOn = mergeDependsOn(
          refNames.concat(extractTestRefDependencies(config.tests)),
          handWritten
        );
      } catch (error) {
        node.discoveryError = error.message;
      }
      return node;
    });
  }

  // The EXECUTORS.model entry: compiles the model's SQL (substituting every
  // ref()), materializes it as a view or table, then - if the model
  // declares tests - runs them. Deliberately does not call move.js's
  // assertReadOnlySelect on the model's own SQL - that guard exists to keep
  // move() read-only, and a model's whole job is writing. It does reuse
  // assertSingleStatement, move.js's other SQL-shape guard: a model can
  // write, but a stray ";" splitting its SQL into more than one statement
  // is a mistake either way, not a second statement this library intends
  // to run.
  //
  // A view with tests still tests the relation it just materialized, same
  // as ever: a view is just stored SQL text, not landed data, so there is
  // nothing to stage - CREATE OR REPLACE VIEW already only ever changes
  // what a *future* query sees, never something already sitting in a
  // table. A table with no tests also just materializes directly - nothing
  // to check, nothing to gain from staging.
  //
  // A table *with* tests goes through modelTableStaged() below instead:
  // build into a scratch table, test the scratch table, and only promote
  // into the real relation - via a copy job, not a second SELECT - once
  // every test has passed. That's the guarantee CREATE OR REPLACE alone
  // can't give a table model: without staging, a failing test is
  // discovered only after the bad rows are already sitting in the real
  // relation (this was itself the shape of the bug an external review
  // caught - see modelTableStaged()'s own comment for the fix and why the
  // previous "would double BigQuery compute" reasoning here didn't hold).
  //
  // The ref()-resolution closure both model() and compileModel() need:
  // a name resolves against either a declared model (via
  // resolveModelConfig()+qualifiedRelation()) or a bigquery-target move node
  // (config.moveRefTargets, already resolved and validated once by
  // expandModelNodes() at discovery time - see its own comment). Extracted
  // out of model() rather than duplicated into compileModel() below, since
  // the two functions differ only in what they do with the compiled SQL
  // (run it vs. return it), not in how a ref() gets substituted.
  //
  // Not a model - must be a bigquery-target move node lookup, which is a
  // cheap lookup, not a fresh resolution - same "redundant re-validation,
  // cheap defense in depth" posture the model branch already has via
  // resolveModelConfig's own throw. Unreachable in practice (discovery
  // already rejects anything that wouldn't resolve here), but a node's own
  // config could in principle be mutated between discovery and run, so this
  // still throws rather than substituting undefined into a live BigQuery
  // statement.
  function buildRefResolver(config, registry) {
    return function (refName) {
      if (has(registry.models, refName)) {
        return qualifiedRelation(resolveModelConfig(refName, registry));
      }
      if (has(config.moveRefTargets, refName)) {
        return config.moveRefTargets[refName];
      }
      throw new Error('model(): "' + config.name + '" has {{ ref(\'' + refName + '\') }}, which does not match a declared model or a move node with a bigquery target.');
    };
  }

  // The EXECUTORS.compile entry (see cli.js's COMPILERS map): resolves a
  // model's SQL exactly the way model() itself is about to, right down to
  // reusing the same buildRefResolver()/compileModelSql() calls, but stops
  // there and returns the compiled text instead of ever calling BigQuery -
  // this is cli('compile')'s whole point, the same "resolve Jinja, touch
  // nothing" job dbt's own `dbt compile` does. Kept as a second function
  // rather than a flag on model() itself, since the two have different
  // return shapes (a compiled string vs. a materialization result) and
  // model() already has enough branches (staged vs. direct, tested vs. not).
  function compileModel(config) {
    var sql = config.sql;
    assertSingleStatement(sql, 'model(): "' + config.name + '"');
    var registry = readModelsRegistry();
    return compileModelSql(sql, buildRefResolver(config, registry), registry);
  }

  // config.sql is always already set by expandModelNodes() above by the
  // time this runs. A node whose own discovery failed instead carries a
  // node-level discoveryError, which cli.js's runNodes() checks and reports
  // as "failed" before ever calling an EXECUTORS entry - so there is no path
  // into this function for a node that didn't get a real config.sql, and
  // config.tests (if present) has already passed validateModelTests above.
  function model(config) {
    var sql = config.sql;
    assertSingleStatement(sql, 'model(): "' + config.name + '"');
    var registry = readModelsRegistry();
    var compiled = compileModelSql(sql, buildRefResolver(config, registry), registry);
    var relation = qualifiedRelation(config);
    var materialized = resolveMaterialized(config);
    var hasTests = !!(config.tests && config.tests.length);

    if (materialized === 'table' && hasTests) {
      return modelTableStaged(config, compiled, relation, registry);
    }

    var statement = 'CREATE OR REPLACE ' + materialized.toUpperCase() + ' ' + relation + ' AS\n' + compiled;
    runBigQueryQueryJob({ query: statement, useLegacySql: false }, config.projectId);
    var result = { relation: relation, materialized: materialized };
    if (hasTests) {
      var compiledTests = compileModelTests(config.tests, registry);
      result.testResults = runSqlTests(
        compiledTests,
        { projectId: config.projectId, dataset: config.dataset, table: config.name },
        'model(): "' + config.name + '" tests'
      );
    }
    return result;
  }

  // Stages a table-materialized model's compiled SELECT into a scratch
  // table, tests the scratch table, and only promotes into the real
  // relation once every test passes - mirroring move.js's own
  // loadBigQueryStaged (see its comment for the general shape and the
  // GAS-execution-timeout reasoning behind the staging table's
  // belt-and-suspenders expiration_timestamp). Reuses move.js's
  // resolveStagingTableId rather than growing a second staging-id helper -
  // it was already generic, just previously only called from move.js.
  //
  // Promotion is a BigQuery *copy* job (configuration.copy,
  // WRITE_TRUNCATE - a full replace, matching what CREATE OR REPLACE TABLE
  // already does every run since incremental materialization isn't
  // implemented yet), not a second "CREATE OR REPLACE TABLE ... AS
  // SELECT". That distinction is the whole point: an earlier version of
  // this function's comment argued staging would double BigQuery compute,
  // reasoning that promotion would mean re-running the model's own SELECT
  // a second time. A copy job doesn't do that - it's a metadata-level
  // operation, not a re-executed query - so the SELECT still runs exactly
  // once per run, staging buys the "never test data that's already sitting
  // in the real relation" guarantee for free, and the real relation is
  // simply never touched by a run whose tests failed.
  //
  // The staging table's OPTIONS(expiration_timestamp=...) is set directly
  // in the CREATE OR REPLACE TABLE DDL rather than via a separate
  // BigQuery.Tables.insert call the way loadBigQueryStaged does - model()
  // only ever talks to BigQuery through query jobs already (no CSV blob to
  // load), so setting the expiration inline keeps this a single query job
  // instead of adding a second API shape just for this one path.
  function modelTableStaged(config, compiled, relation, registry) {
    var stagingTable = resolveStagingTableId(config.name);
    var stagingRelation = qualifiedTableRef(config.projectId, config.dataset, stagingTable);
    var expirationMillis = Date.now() + 60 * 60 * 1000;
    var stagingStatement = 'CREATE OR REPLACE TABLE ' + stagingRelation +
      ' OPTIONS(expiration_timestamp = TIMESTAMP_MILLIS(' + expirationMillis + ')) AS\n' + compiled;
    // Tracks whether the staging query itself succeeded, so the finally
    // block below only tries to remove a table that actually exists - if
    // the staging query throws, there is nothing to clean up yet, and
    // calling BigQuery.Tables.remove anyway would mask the real error with
    // a spurious "not found" from cleanup.
    var stagingCreated = false;
    try {
      runBigQueryQueryJob({ query: stagingStatement, useLegacySql: false }, config.projectId);
      stagingCreated = true;

      var compiledTests = compileModelTests(config.tests, registry);
      var testResults = runSqlTests(
        compiledTests,
        { projectId: config.projectId, dataset: config.dataset, table: stagingTable },
        'model(): "' + config.name + '" tests'
      );

      var copyConfig = {
        sourceTable: { projectId: config.projectId, datasetId: config.dataset, tableId: stagingTable },
        destinationTable: { projectId: config.projectId, datasetId: config.dataset, tableId: config.name },
        writeDisposition: 'WRITE_TRUNCATE'
      };
      runBigQueryJob({ configuration: { copy: copyConfig } }, config.projectId, null, 'copy');

      return { relation: relation, materialized: 'table', staged: { table: stagingTable }, testResults: testResults };
    } finally {
      if (stagingCreated) {
        BigQuery.Tables.remove(config.projectId, config.dataset, stagingTable);
      }
    }
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

  // The compile-time counterpart to EXECUTORS, consulted only by
  // cli('compile') (see runNodes()'s 'compile' branch below). Not every kind
  // has something to compile - move has no {{ }}-style templating, so a move
  // node under cli('compile') just reports 'planned' with no compiledSql,
  // the same as it already does under cli('list'). Deliberately its own
  // small map rather than folded into EXECUTORS: EXECUTORS answers "how do I
  // run this kind for real", COMPILERS answers a different, narrower
  // question ("can this kind's SQL be resolved without running it") that
  // only 'model' can answer yes to today.
  var COMPILERS = {
    model: compileModel
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

  // True for a plain, non-array object - the shape check every "is this
  // really a config object" guard in this library repeats: discoverNodes()'s
  // var-scan below, and model.js's readModelsRegistry (twice, once for the
  // registry itself and once for its .models field). One predicate means
  // whether "typeof x === 'object'" needs the Array.isArray() exclusion too
  // never has to be decided more than once.
  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

  var COMMANDS = ['run', 'list', 'compile', 'debug', 'hello', 'help'];

  function usage() {
    return [
      'notsobigdata commands:',
      '',
      '  cli("run")                     run every declared node, in dependency order',
      '  cli("run --select move")       run only nodes of a given kind',
      '  cli("run --select a,b")        run only the named nodes',
      '  cli("run --exclude a")         run everything except the named nodes',
      '  cli("list")                    show what would run, in order, without running it',
      '  cli("compile")                 resolve model SQL ({{ ref() }}/var()/config()) without running anything',
      '  cli("debug")                   check OAuth scopes/services for each node\'s connector, without writing anything',
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
        if (!isPlainObject(value)) {
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
      var edges = parseDependsOnList('cli(): node "' + name + '"', dependsOn);
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
    //
    // nodes (everything the scan above already found - today, only move) is
    // passed in so a model's {{ ref() }} can also resolve a move node with a
    // bigquery target, not just another model - see expandModelNodes()'s own
    // comment for how it uses this list.
    expandModelNodes(nodes).forEach(function (node) {
      claimName(claimedNames, node.name, node.variable);
      nodes.push(node);
    });
    return { nodes: nodes, ignored: ignored };
  }

  // Validates an optional dependsOn value and normalizes it to an edge list
  // (no dependsOn means no edges). Shared by discoverNodes() below (a move
  // node's own dependsOn) and model.js's expandModelNodes() (a model's
  // hand-written dependsOn, unioned with its {{ ref() }}-derived edges) -
  // same shape, same failure mode, validated once instead of twice. context
  // is the caller's own error-message prefix (e.g. 'cli(): node "orders"' or
  // 'model(): "orders_summary"'), so the thrown message still reads right
  // for whichever caller hit it. The copy on the valid path matters: the
  // node's edges must not alias the caller's array, which they could mutate
  // later.
  function parseDependsOnList(context, raw) {
    if (raw !== undefined && !Array.isArray(raw)) {
      throw new Error(context + ' has a "dependsOn" that is not an array - got ' + typeof raw + '.');
    }
    var edges = raw ? raw.slice() : [];
    edges.forEach(function (dependency) {
      if (typeof dependency !== 'string' || !dependency) {
        throw new Error(context + ' has a "dependsOn" entry that is not a node name string.');
      }
    });
    return edges;
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
  // or the dry-run/compile checks above it, since none of those waits on
  // anything: a skipped, planned or compiled node is decided instantly, so a
  // START line there would never carry the "is this still working" signal it
  // exists for. That signal matters for real execution (a BigQuery job can
  // poll for tens of seconds) - without it, a human watching the Apps Script
  // log during a long run can only see which nodes have already finished,
  // never which one is currently in flight.
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
  //
  // command is one of 'run', 'list' or 'compile' - not a bare dryRun boolean,
  // since 'list' and 'compile' are both "don't touch BigQuery/Sheets/Drive"
  // modes but differ in what they report: 'list' always reports 'planned'
  // with nothing else attached, kind-agnostically; 'compile' additionally
  // resolves a model's SQL via COMPILERS (see its own comment above
  // EXECUTORS) for any kind that has something to compile, attaching the
  // result as compiledSql on the same 'planned' status, and treating a
  // compile failure the same way a real run failure is treated - it blocks
  // dependents transitively via the same `blocked` map, rather than needing
  // a parallel skip mechanism just for this mode.
  function runNodes(nodes, command, verbose) {
    var results = [];
    var blocked = emptyMap();
    nodes.forEach(function (node) {
      // A node can arrive already known to be broken - model.js's
      // expandModelNodes() sets this when a model's own sqlFile/tag
      // configuration is bad, discovered while building the graph, well
      // before any node's turn to actually run. Checked here, kind-
      // agnostically (a plain node-level field, not something only model
      // nodes could have), and ahead of the dry-run/compile branches below:
      // the whole point of a "list"/"compile" dry run is surfacing a config
      // mistake before anything executes for real, and this error is already
      // fully known with nothing to execute to see it - reporting it only on
      // a real "run" would make "list"/"compile" strictly less useful for
      // exactly the errors that are cheapest to catch early.
      if (node.discoveryError) {
        blocked[node.name] = true;
        results.push({ name: node.name, kind: node.kind, status: 'failed', error: node.discoveryError });
        Logger.log('FAIL  ' + nodeLabel(node) + ' - ' + node.discoveryError);
        return;
      }
      var blockers = node.dependsOn.filter(function (dependency) { return has(blocked, dependency); });
      if (blockers.length) {
        blocked[node.name] = true;
        results.push({ name: node.name, kind: node.kind, status: 'skipped', blockedBy: blockers });
        Logger.log('SKIP  ' + nodeLabel(node) + ' - waiting on ' + blockers.join(', '));
        return;
      }
      if (command === 'compile') {
        if (!has(COMPILERS, node.kind)) {
          results.push({ name: node.name, kind: node.kind, status: 'planned' });
          Logger.log('PLAN  ' + nodeLabel(node));
          return;
        }
        try {
          var compiledSql = COMPILERS[node.kind](node.config);
          results.push({ name: node.name, kind: node.kind, status: 'planned', compiledSql: compiledSql });
          Logger.log('PLAN  ' + nodeLabel(node) + ' - compiled');
        } catch (error) {
          blocked[node.name] = true;
          results.push({ name: node.name, kind: node.kind, status: 'failed', error: error.message });
          Logger.log('FAIL  ' + nodeLabel(node) + ' - ' + error.message);
        }
        return;
      }
      if (command === 'list') {
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
  // the result (an array of rows, an object carrying loadResult/testResults,
  // or model()'s relation/materialized) - the same shapes every EXECUTORS
  // entry already produces. The raw rows are never included, only their
  // size - a manifest is an observability artifact, not a second copy of
  // the data that already landed at its real destination.
  function summarizeNodeResult(result) {
    var summary = { name: result.name, kind: result.kind, status: result.status };
    if (result.status === 'skipped') {
      summary.blockedBy = result.blockedBy;
    } else if (result.status === 'failed') {
      summary.ms = result.ms;
      summary.error = result.error;
    } else if (result.status === 'planned') {
      // Only cli('compile') ever sets this - cli('list')'s own 'planned'
      // results never carry a compiledSql, and 'list' never calls
      // buildManifest() at all (see cli()'s dispatch below), so this branch
      // is a no-op for every manifest except the compile one.
      if (result.compiledSql !== undefined) {
        summary.compiledSql = result.compiledSql;
      }
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
      if (result.result && result.result.relation !== undefined) {
        summary.relation = result.result.relation;
        summary.materialized = result.result.materialized;
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

  // Shared by writeManifest()/writeCompileManifest() below - both do the
  // exact same "resolve folder, upsert by name via Drive, log every outcome,
  // never throw" work, differing only in which global they read config from
  // and what prefix they log under (logPrefix), so this is the one place
  // that actually writes, called with each caller's own already-resolved
  // config plus the *other* one's config for the collision guard right
  // below. Best-effort: a Drive failure here must never throw or affect the
  // node results actually being reported, so every path is caught and
  // turned into one of four report.manifest shapes instead.
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
  //
  // otherConfig is only consulted (and only ever costs a Drive lookup, via
  // resolveManifestFolderId(), when its own folderId is unset) if it's
  // enabled - a disabled manifest can never actually be overwritten, so
  // there is nothing to guard against. When both configs resolve to the
  // same folderId + fileName, refusing to write (rather than writing
  // anyway) is the only choice that can't silently destroy whichever
  // manifest was written most recently - a run's manifest overwritten by a
  // later compile, or vice versa, with no error either time it happened
  // before this guard existed.
  function writeManifestFile(logPrefix, config, otherConfig, commandText, ok, results, ignored) {
    if (!config.enabled) {
      Logger.log(logPrefix + ' skipped - enabled is false');
      return { written: false, reason: 'disabled' };
    }
    try {
      var folderId = resolveManifestFolderId(config.folderId);
      if (otherConfig.enabled) {
        var otherFolderId = resolveManifestFolderId(otherConfig.folderId);
        if (folderId === otherFolderId && config.fileName === otherConfig.fileName) {
          var message = 'notsobigdataManifest and notsobigdataCompileManifest resolve to the same Drive file (folderId "'
            + folderId + '", fileName "' + config.fileName + '") - refusing to write, since cli(\'run\') and cli(\'compile\') '
            + 'would otherwise silently overwrite each other\'s manifest. Give one of them its own folderId or fileName.';
          Logger.log(logPrefix + ' failed - ' + message);
          return { written: false, reason: 'collision', error: message };
        }
      }
      var manifest = buildManifest(commandText, ok, results, ignored);
      var target = { folderId: folderId, fileName: config.fileName, upsertByName: true };
      var fileId = resolveDriveWriteTarget(target);
      fileId = writeDriveText(fileId, target, JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT);
      Logger.log(logPrefix + ' written to ' + fileId);
      return { written: true, fileId: fileId };
    } catch (error) {
      Logger.log(logPrefix + ' failed - ' + error.message);
      return { written: false, reason: 'error', error: error.message };
    }
  }

  function writeManifest(commandText, ok, results, ignored) {
    return writeManifestFile('MANIFEST', resolveManifestConfig(), resolveCompileManifestConfig(), commandText, ok, results, ignored);
  }

  // Reads the optional notsobigdataCompileManifest global, same guarded
  // pattern and shape as resolveManifestConfig() above - a deliberately
  // separate global, not a second field on notsobigdataManifest, so
  // configuring (or disabling) the compile manifest can never accidentally
  // touch the run manifest's own settings. Different default fileName for
  // the same reason: the two are meant to coexist as two files, not fight
  // over one.
  function resolveCompileManifestConfig() {
    var raw = readOptionalGlobal('notsobigdataCompileManifest');
    var config = (raw && typeof raw === 'object') ? raw : {};
    return {
      enabled: config.enabled !== false,
      folderId: typeof config.folderId === 'string' && config.folderId ? config.folderId : null,
      fileName: typeof config.fileName === 'string' && config.fileName ? config.fileName : 'notsobigdata-compile-manifest.json'
    };
  }

  // cli('compile')'s counterpart to writeManifest() above - same
  // writeManifestFile() call, to its own file via resolveCompileManifestConfig()
  // rather than resolveManifestConfig(). A compile pass never touches
  // BigQuery/Sheets/Drive, so it must never overwrite the run manifest's own
  // record of what the last real run actually did - see docs/cli.md's "The
  // compile manifest" for the user-facing version of this reasoning, and
  // writeManifestFile()'s own comment above for how the same-target case is
  // now caught rather than silently allowed.
  function writeCompileManifest(commandText, ok, results, ignored) {
    return writeManifestFile('COMPILE MANIFEST', resolveCompileManifestConfig(), resolveManifestConfig(), commandText, ok, results, ignored);
  }

  // cli('debug') - a diagnostic, non-mutating check of whether the current
  // Apps Script project's OAuth scopes / Advanced Services actually cover
  // what each declared node's connector needs.
  //
  // This exists because of the eval() scoping gotcha documented in
  // CLAUDE.md: Apps Script auto-detects required OAuth scopes and Advanced
  // Services by statically scanning a project's own .gs files. Code that
  // arrives via eval(UrlFetchApp.fetch(...).getContentText()) was never in
  // those files, so a call this library makes from inside that eval'd text -
  // to DriveApp, SpreadsheetApp, BigQuery, UrlFetchApp - can be invisible to
  // that scan. The consuming project's appsscript.json can end up missing a
  // scope nobody was ever shown a prompt to grant. cli('debug') probes each
  // connector for real (safely - see below) so that gap turns into a clear
  // message here instead of a bare permission error surfacing deep inside a
  // real move()/model() run.
  //
  // Safety rule, load-bearing: a debug check must never trigger a write.
  // A source connector's probe is (as close as possible to) the real read
  // call, since a source is already read-only by contract. A target
  // connector's probe is a read-only stand-in for the same resource instead
  // - open it, don't write to it. probeApi's target case is the one
  // deliberate compromise: loadApi (move.js) always POSTs a JSON body, so
  // probing a target sends a GET instead. That means a POST-only endpoint
  // reads back as reachable-but-non-2xx rather than as an auth failure -
  // fetchProbe() below treats any HTTP response at all, regardless of
  // status code, as proof UrlFetchApp itself is authorized, and leaves the
  // status code out of the ok/not-ok decision entirely.
  var SCOPE_ERROR_PATTERN = /permission|scope|not authorized|unauthorized|PERMISSION_DENIED|insufficient/i;

  // The message every 'missing_scope'/'service_not_enabled' check ends with.
  // kind is a short phrase naming what to add ("an oauthScopes entry",
  // "the BigQuery Advanced Service") so the same explanation reads right
  // in both callers below.
  function evalScopingHint(kind) {
    return 'Apps Script only auto-adds OAuth scopes/Advanced Services by scanning a project\'s own .gs files for the calls that need them - it can\'t see calls made from code installed via eval(), which is how notsobigdata loads. Add ' + kind + ' by hand in the Apps Script editor (Project Settings > "Show appsscript.json") rather than expecting an authorization prompt to add it for you.';
  }

  function classifyProbeError(error, type, role) {
    var message = error && error.message ? error.message : String(error);
    if (SCOPE_ERROR_PATTERN.test(message)) {
      return { status: 'missing_scope', message: type + ' ' + role + ': ' + message + ' - ' + evalScopingHint('the missing oauthScopes entry') };
    }
    return { status: 'error', message: type + ' ' + role + ': ' + message };
  }

  function bigQueryServiceNotEnabledMessage() {
    return 'BigQuery is not available as a "BigQuery" service in this project, so the Advanced BigQuery Service isn\'t enabled - a separate switch from OAuth scopes (Apps Script editor > Services > add "BigQuery API", and confirm the BigQuery API is enabled on the linked GCP project). ' + evalScopingHint('the BigQuery Advanced Service');
  }

  // Shared by probeUrl and probeApi. Always forces a GET and always mutes
  // HTTP exceptions: the status code is deliberately irrelevant to whether
  // this counts as 'ok' (see the module comment above) - only a thrown
  // error means UrlFetchApp itself couldn't make the call. method/payload/
  // muteHttpExceptions are all stripped out of options rather than merged
  // in - method/payload so a target's own POST configuration can never leak
  // through and turn a probe into a second real write, muteHttpExceptions
  // so a node's own options (e.g. one that sets muteHttpExceptions: false
  // to let its real call inspect a non-2xx response body) can never
  // override the forced true here and turn a perfectly reachable, non-2xx
  // endpoint into a thrown error this function misreports as 'missing_scope'
  // or 'error' instead of 'ok'.
  function fetchProbe(url, options, type, role) {
    var fetchOptions = { method: 'get', muteHttpExceptions: true };
    if (options) {
      Object.keys(options).forEach(function (key) {
        if (key !== 'method' && key !== 'payload' && key !== 'muteHttpExceptions') {
          fetchOptions[key] = options[key];
        }
      });
    }
    try {
      var response = UrlFetchApp.fetch(url, fetchOptions);
      return { status: 'ok', message: 'UrlFetchApp reached ' + url + ' (HTTP ' + response.getResponseCode() + ').' };
    } catch (error) {
      return classifyProbeError(error, type, role);
    }
  }

  function probeSheets(role, config) {
    if (!config.spreadsheetId) {
      return { status: 'error', message: 'sheets ' + role + ' has no "spreadsheetId" to check.' };
    }
    try {
      SpreadsheetApp.openById(config.spreadsheetId);
      return { status: 'ok', message: 'opened spreadsheet ' + config.spreadsheetId + '.' };
    } catch (error) {
      return classifyProbeError(error, 'sheets', role);
    }
  }

  function probeDrive(role, config) {
    if (config.fileId) {
      try {
        DriveApp.getFileById(config.fileId);
        return { status: 'ok', message: 'opened Drive file ' + config.fileId + '.' };
      } catch (error) {
        return classifyProbeError(error, 'drive', role);
      }
    }
    if (config.folderId) {
      try {
        DriveApp.getFolderById(config.folderId);
        return { status: 'ok', message: 'opened Drive folder ' + config.folderId + '.' };
      } catch (error) {
        return classifyProbeError(error, 'drive', role);
      }
    }
    return { status: 'error', message: 'drive ' + role + ' has neither "fileId" nor "folderId" to check.' };
  }

  // dataset is optional on a bigquery *source* (a "query"/"queryFileId" mode
  // source has a projectId but no particular dataset to name - see
  // resolveBigQuerySql in move.js) but always present on a target and on a
  // resolved model config. When there's no dataset to check, this falls back
  // to listing one page of datasets in the project - still a real,
  // scope-sensitive call, just not scoped to one dataset.
  function probeBigQuery(role, config) {
    if (typeof BigQuery === 'undefined') {
      return { status: 'service_not_enabled', message: bigQueryServiceNotEnabledMessage() };
    }
    if (!config.projectId) {
      return { status: 'error', message: 'bigquery ' + role + ' has no "projectId" to check.' };
    }
    try {
      if (config.dataset) {
        BigQuery.Datasets.get(config.projectId, config.dataset);
        return { status: 'ok', message: 'read dataset metadata for ' + config.projectId + '.' + config.dataset + '.' };
      }
      BigQuery.Datasets.list(config.projectId, { maxResults: 1 });
      return { status: 'ok', message: 'listed datasets in project ' + config.projectId + '.' };
    } catch (error) {
      return classifyProbeError(error, 'bigquery', role);
    }
  }

  // A url source is always a GET (extractUrl in move.js never writes), so
  // this probe is the real call, github-blob rewrite included - the same
  // request a real run would make.
  function probeUrl(role, config) {
    if (!config.url) {
      return { status: 'error', message: 'url ' + role + ' has no "url" to check.' };
    }
    return fetchProbe(rewriteGithubBlobUrl(config.url), config.options, 'url', role);
  }

  // An api source is a real GET too (extractApi), so this probe is exactly
  // that call. An api target's real call (loadApi) is always a POST with a
  // JSON body - fetchProbe forces a GET instead, the one deliberate
  // compromise described in this section's module comment above.
  function probeApi(role, config) {
    if (!config.url) {
      return { status: 'error', message: 'api ' + role + ' has no "url" to check.' };
    }
    return fetchProbe(config.url, config.options, 'api', role);
  }

  function probeCustom(role) {
    return { status: 'unverifiable', message: 'custom ' + role + ' calls your own "fn" - cli(\'debug\') has no way to know what services it uses.' };
  }

  // Keyed by connector type (source.type/target.type - the same six strings
  // extract()/load() in move.js switch on), parallel to EXECUTORS/COMPILERS
  // above: one small map per question this module can answer about a kind
  // or a connector, rather than one map trying to answer all of them.
  var DEBUG_PROBES = {
    sheets: probeSheets,
    drive: probeDrive,
    bigquery: probeBigQuery,
    api: probeApi,
    url: probeUrl,
    custom: probeCustom
  };

  // Pulls (role, type, config) probe tuples out of one discovered node. A
  // model node never carries a source/target shape at all - its single
  // implicit tuple is built from the projectId/dataset resolveModelConfig()
  // (model.js) already resolved onto every model node's config, the same
  // two fields a real bigquery target requires and probeBigQuery already
  // expects. One nuance: expandModelNodes() only attaches that resolved
  // config to the node once every discovery-time check (SQL file read,
  // {{ }} validation, ref() resolution) has already passed - a model with a
  // discoveryError keeps the placeholder { name: name } config it started
  // with, so this reports 'error' (no projectId to check) for a broken
  // model rather than silently skipping it or crashing.
  function connectorTuplesForNode(node) {
    if (node.kind === 'model') {
      return [{ role: 'target', type: 'bigquery', config: { projectId: node.config.projectId, dataset: node.config.dataset } }];
    }
    var tuples = [];
    if (isPlainObject(node.config.source) && typeof node.config.source.type === 'string') {
      tuples.push({ role: 'source', type: node.config.source.type, config: node.config.source });
    }
    if (isPlainObject(node.config.target) && typeof node.config.target.type === 'string') {
      tuples.push({ role: 'target', type: node.config.target.type, config: node.config.target });
    }
    return tuples;
  }

  // Runs every connector check for one selected node. Deliberately
  // independent of every other node's status - unlike runNodes()'s
  // run/list/compile branches, this never consults a `blocked` map: the
  // whole point of cli('debug') is surfacing every connector problem in one
  // pass, not respecting dependency order, which a diagnostic dry run has
  // no use for in the first place.
  function debugNode(node) {
    return connectorTuplesForNode(node).map(function (tuple) {
      var probe = DEBUG_PROBES[tuple.type];
      var outcome = probe
        ? probe(tuple.role, tuple.config)
        : { status: 'error', message: 'unknown connector type "' + tuple.type + '".' };
      return { node: node.name, kind: node.kind, role: tuple.role, type: tuple.type, status: outcome.status, message: outcome.message };
    });
  }

  function runDebugChecks(nodes) {
    var checks = [];
    nodes.forEach(function (node) {
      debugNode(node).forEach(function (check) {
        checks.push(check);
        var label = nodeLabel(node) + ' ' + check.role + ' (' + check.type + ')';
        if (check.status === 'ok') {
          Logger.log('OK    ' + label + ' - ' + check.message);
        } else if (check.status === 'unverifiable') {
          Logger.log('SKIP  ' + label + ' - ' + check.message);
        } else {
          Logger.log('FAIL  ' + label + ' - ' + check.message);
        }
      });
    });
    return checks;
  }

  // formatStatusCounts()'s counterpart for a debug report's check statuses
  // rather than a run report's node statuses - same "only render non-zero
  // counts" reasoning, kept separate since the two status vocabularies
  // don't overlap (a check is never 'success'/'skipped'/'planned').
  function formatDebugStatusCounts(checks) {
    var counts = { ok: 0, missing_scope: 0, service_not_enabled: 0, error: 0, unverifiable: 0 };
    checks.forEach(function (check) { counts[check.status] += 1; });
    var labels = { ok: 'ok', missing_scope: 'missing scope', service_not_enabled: 'service not enabled', error: 'error', unverifiable: 'unverifiable' };
    var parts = Object.keys(labels)
      .filter(function (status) { return counts[status] > 0; })
      .map(function (status) { return counts[status] + ' ' + labels[status]; });
    return parts.length ? parts.join(', ') : 'nothing to check';
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
  // either a run report (for "run"/"list"/"compile") or a message string
  // (for "hello"/"help").
  //
  // Logs "START"/"DONE" bookends around every call, padded to the same
  // six characters as runNodes()'s own "OK"/"FAIL"/"SKIP"/"PLAN" labels so
  // every line in the execution log lines up. "START" is the very first
  // thing this function does, before parseCommand() - so a call that
  // throws immediately (an unknown command, zero discovered nodes) still
  // leaves a marker that cli() actually ran, not silence up to the error.
  // "DONE" only fires for "run"/"list"/"compile": hello()/help() already log
  // their own single result line and have no per-node pass/fail/skip status
  // to roll up. Both are pure Logger.log side effects - report is unchanged.
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
    // debug diverges from run/list/compile right here, before orderNodes():
    // it checks every selected node's connector independently of every
    // other node's status, so it has no use for dependency order or the
    // blocked-node skip logic runNodes() applies to the other three
    // commands - see runDebugChecks()'s own comment above.
    if (parsed.command === 'debug') {
      var checks = runDebugChecks(selected);
      var debugOk = checks.every(function (check) { return check.status === 'ok' || check.status === 'unverifiable'; });
      Logger.log('DONE  cli("' + input + '") - ' + formatDebugStatusCounts(checks) + ' (' + checks.length + ' total).');
      return { ok: debugOk, command: 'debug', checks: checks, ignored: discovered.ignored };
    }
    var ordered = orderNodes(selected);
    var results = runNodes(ordered, parsed.command, resolveLoggingConfig().verbose);
    var ok = results.every(function (result) { return result.status !== 'failed' && result.status !== 'skipped'; });
    Logger.log('DONE  cli("' + input + '") - ' + formatStatusCounts(results) + ' (' + results.length + ' total).');
    var report = {
      ok: ok,
      command: parsed.command,
      nodes: results,
      ignored: discovered.ignored
    };
    // "run" and "compile" each write their own manifest; "list" writes
    // neither - it's a pure dry run with nothing, not even compiled SQL, to
    // record. "compile" gets a *separate* file from "run" (writeCompileManifest,
    // not writeManifest) rather than sharing one: a compile pass never
    // touches BigQuery/Sheets/Drive, so it must never overwrite the run
    // manifest's own record of what the last real run actually did.
    if (parsed.command === 'run') {
      report.manifest = writeManifest(input, ok, results, discovered.ignored);
    } else if (parsed.command === 'compile') {
      report.manifest = writeCompileManifest(input, ok, results, discovered.ignored);
    }
    return report;
  }

  return {
    cli: cli
  };
})();
