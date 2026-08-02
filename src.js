var NotSoBigData = (function () {
  function helloWorld() {
    return 'Hello, World! notsobigdata is alive.';
  }

  // Flattens an array of plain objects into a 2D array: a header row made
  // from the union of every element's keys (not just the first element's —
  // JSON/API payloads commonly have optional fields that only show up on
  // some records), followed by one row per element. Keys an element doesn't
  // have become blank cells rather than throwing.
  function objectsToRows(objects) {
    if (!objects || objects.length === 0) {
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

  function extractSheets(source) {
    if (!source.spreadsheetId) {
      throw new Error('move(): sheets source requires "spreadsheetId".');
    }
    var spreadsheet = SpreadsheetApp.openById(source.spreadsheetId);
    var range = source.range
      ? spreadsheet.getRange(source.range)
      : spreadsheet.getActiveSheet().getDataRange();
    return range.getValues();
  }

  // Reads a Drive file's full text content. Shared by the drive csv/json
  // extractors and the bigquery queryFileId mode, so there's one place that
  // knows how to turn a Drive file id into text.
  function readDriveFileText(fileId) {
    return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  }

  function extractDriveCsv(fileId) {
    return Utilities.parseCsv(readDriveFileText(fileId));
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
      return spreadsheet.getActiveSheet().getDataRange().getValues();
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

    return rows;
  }

  // Expects the API to respond with a JSON array of objects, using the
  // same key-union flattening as Drive JSON sources.
  function extractApi(source) {
    if (!source.url) {
      throw new Error('move(): api source requires "url".');
    }
    var response = UrlFetchApp.fetch(source.url, source.options || {});
    var responseCode = response.getResponseCode();
    if (responseCode < 200 || responseCode >= 300) {
      throw new Error('move(): api source request to "' + source.url + '" failed with HTTP ' + responseCode + '.');
    }
    var parsed = JSON.parse(response.getContentText());
    return objectsToRows(parsed);
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

  // Extracts a source into a 2D array. Loading into a target is not
  // implemented yet — that half of "EL" lands in a follow-up change, so
  // move() only accepts a source for now.
  function move(config) {
    if (!config || !config.source) {
      throw new Error('move(): config.source is required.');
    }
    return extract(config.source);
  }

  return {
    helloWorld: helloWorld,
    move: move
  };
})();
