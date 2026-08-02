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

  // Writes a 2D array into a sheet - either "overwrite" (default: clear
  // the whole sheet, then write rows starting at A1) or "append" (write
  // rows after the current last row, leaving existing content alone).
  // Overwrite is the default here because the common case is refreshing a
  // sheet to reflect the latest extract, and undoing an accidental
  // overwrite in a spreadsheet is cheap - unlike loadBigQuery below, whose
  // default leans the other way for exactly the opposite reason.
  function loadSheets(rows, target) {
    if (!target.spreadsheetId) {
      throw new Error('move(): sheets target requires "spreadsheetId".');
    }
    var spreadsheet = SpreadsheetApp.openById(target.spreadsheetId);
    var sheet = target.sheetName
      ? (spreadsheet.getSheetByName(target.sheetName) || spreadsheet.insertSheet(target.sheetName))
      : spreadsheet.getActiveSheet();
    var mode = target.mode || 'overwrite';
    if (mode !== 'overwrite' && mode !== 'append') {
      throw new Error('move(): unsupported sheets target mode "' + mode + '". Expected "overwrite" or "append".');
    }
    if (mode === 'overwrite') {
      sheet.clearContents();
    }
    if (rows.length === 0) {
      return;
    }
    var startRow = mode === 'append' ? sheet.getLastRow() + 1 : 1;
    sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
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

  // Writes text content to a drive target: overwrite an existing file by
  // "fileId", or create a new one from "folderId" + "fileName". Shared by
  // the drive csv and json targets, which only differ in how they
  // serialize rows and which mimeType they create a new file with.
  function writeDriveText(target, content, mimeType) {
    if (target.fileId) {
      DriveApp.getFileById(target.fileId).setContent(content);
      return target.fileId;
    }
    if (!target.folderId || !target.fileName) {
      throw new Error('move(): drive target requires either "fileId" (to overwrite an existing file) or both "folderId" and "fileName" (to create a new one).');
    }
    return DriveApp.getFolderById(target.folderId).createFile(target.fileName, content, mimeType).getId();
  }

  function loadDriveCsv(rows, target) {
    return writeDriveText(target, rowsToCsv(rows), MimeType.CSV);
  }

  function loadDriveJson(rows, target) {
    return writeDriveText(target, JSON.stringify(rowsToObjects(rows)), MimeType.PLAIN_TEXT);
  }

  // Builds the xlsx file via a temporary Google Sheet (Apps Script has no
  // native XLSX writer, mirroring extractDriveXlsx's use of a temp copy in
  // the opposite direction) and DriveApp's built-in getAs() converter, no
  // Advanced Drive Service needed for that part. Overwriting an existing
  // file by "fileId" does need the Advanced Drive Service, though - unlike
  // csv/json, DriveApp has no way to replace a file's binary content in
  // place, only Drive.Files.update() does. The temp sheet is always
  // deleted afterward, including on error.
  function loadDriveXlsx(rows, target) {
    var tempSpreadsheet = SpreadsheetApp.create('notsobigdata-xlsx-export-' + Utilities.getUuid());
    try {
      if (rows.length > 0) {
        tempSpreadsheet.getActiveSheet().getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      }
      var blob = DriveApp.getFileById(tempSpreadsheet.getId()).getAs(MimeType.MICROSOFT_EXCEL);
      if (target.fileId) {
        Drive.Files.update({}, target.fileId, blob);
        return target.fileId;
      }
      if (!target.folderId || !target.fileName) {
        throw new Error('move(): drive target requires either "fileId" (to overwrite an existing file) or both "folderId" and "fileName" (to create a new one).');
      }
      return DriveApp.getFolderById(target.folderId).createFile(blob.setName(target.fileName)).getId();
    } finally {
      DriveApp.getFileById(tempSpreadsheet.getId()).setTrashed(true);
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

  // Loads rows into a BigQuery table via a load job (data uploaded as CSV,
  // schema autodetected from the header row) rather than INSERT statements
  // - the same approach BigQuery's own tooling uses for bulk loads, and it
  // avoids building a manual schema. Defaults to "append" (WRITE_APPEND)
  // rather than "overwrite" (WRITE_TRUNCATE): unlike loadSheets above,
  // truncating a real table is destructive and hard to undo, so that mode
  // must be opted into explicitly rather than risked by a missing
  // "mode" key. Jobs.insert here doesn't long-poll the way
  // getQueryResults does in extractBigQuery, so this polls job status
  // itself with a short sleep between checks.
  function loadBigQuery(rows, target) {
    if (!target.projectId || !target.dataset || !target.table) {
      throw new Error('move(): bigquery target requires "projectId", "dataset", and "table".');
    }
    var mode = target.mode || 'append';
    var writeDisposition = mode === 'overwrite' ? 'WRITE_TRUNCATE' : mode === 'append' ? 'WRITE_APPEND' : null;
    if (!writeDisposition) {
      throw new Error('move(): unsupported bigquery target mode "' + mode + '". Expected "overwrite" or "append".');
    }
    if (rows.length === 0) {
      return;
    }
    var blob = Utilities.newBlob(rowsToCsv(rows), 'text/csv');
    var job = {
      configuration: {
        load: {
          destinationTable: {
            projectId: target.projectId,
            datasetId: target.dataset,
            tableId: target.table
          },
          sourceFormat: 'CSV',
          skipLeadingRows: 1,
          autodetect: true,
          writeDisposition: writeDisposition
        }
      }
    };
    var insertedJob = BigQuery.Jobs.insert(job, target.projectId, blob);
    var jobId = insertedJob.jobReference.jobId;
    var status = insertedJob.status;
    while (status.state !== 'DONE') {
      Utilities.sleep(500);
      status = BigQuery.Jobs.get(target.projectId, jobId).status;
    }
    if (status.errorResult) {
      throw new Error('move(): bigquery load job failed - ' + status.errorResult.message);
    }
  }

  // POSTs rows to an API endpoint as a JSON array of objects - the same
  // shape extractApi expects to receive, so round-tripping data out to an
  // API and back in stays symmetric. target.options can override the
  // defaults (e.g. a different method or extra headers) since it's merged
  // in after them.
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
    var responseCode = response.getResponseCode();
    if (responseCode < 200 || responseCode >= 300) {
      throw new Error('move(): api target request to "' + target.url + '" failed with HTTP ' + responseCode + '.');
    }
  }

  // Runs a user-supplied loader function from the caller's own Apps
  // Script project, same trust model as extractCustom: target.fn is a
  // direct function reference, called as fn(rows, target) so it gets both
  // the extracted data and whatever extra config keys the caller attached
  // to the target.
  function loadCustom(rows, target) {
    if (typeof target.fn !== 'function') {
      throw new Error('move(): custom target requires "fn" to be a function - got ' + typeof target.fn + '.');
    }
    target.fn(rows, target);
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

  // Extracts a source into a 2D array and, if a target is given, loads it
  // there too. config.target is optional so extract-only calls keep
  // working exactly as before - move() always returns the extracted rows
  // either way, so a caller can inspect what was loaded or use it purely
  // for extraction.
  function move(config) {
    if (!config || !config.source) {
      throw new Error('move(): config.source is required.');
    }
    var rows = extract(config.source);
    if (config.target) {
      load(rows, config.target);
    }
    return rows;
  }

  return {
    helloWorld: helloWorld,
    move: move
  };
})();
