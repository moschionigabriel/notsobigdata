var NotSoBigData = (function () {
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

  // Extracts a source into a 2D array and, if a target is given, loads it
  // there too. config.target is optional so extract-only calls keep
  // working exactly as before - move() always returns the extracted rows
  // either way (a plain array, so rows.length/rows[i]/JSON.stringify(rows)
  // are all unaffected), so a caller can inspect what was loaded or use it
  // purely for extraction. When a target was given, whatever that load
  // function returned (a file id, a BigQuery job id, ...) is attached as
  // rows.loadResult - an extra property on the array, not a new element,
  // so it doesn't show up in rows.length or get serialized by
  // JSON.stringify(rows).
  function move(config) {
    if (!config || !config.source) {
      throw new Error('move(): config.source is required.');
    }
    var rows = extract(config.source);
    if (config.target) {
      rows.loadResult = load(rows, config.target);
    }
    return rows;
  }

  // ==================================================================
  // cli() - the library's single public entrypoint
  // ==================================================================
  //
  // Everything above this line is machinery for moving data. Everything
  // below is the declarative layer on top of it: instead of calling
  // move() yourself, once per step, in the right order, you *declare*
  // plain objects at the top level of your script and let cli() find
  // them, order them by their dependencies, and run them. Same idea as
  // dbt, where you don't call each model - you write models and run
  // "dbt run --select ...".

  // Maps a node's "kind" to the function that executes one node's config.
  // This is the only place a kind is registered: discovery, selection,
  // ordering and the run loop below are all kind-agnostic, so adding
  // model() later means adding one entry here and nothing else.
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
    if (typeof input !== 'string' || !input.replace(/\s/g, '')) {
      throw new Error('cli(): a command is required, e.g. cli("run").\n\n' + usage());
    }
    var tokens = input.replace(/^\s+|\s+$/g, '').split(/\s+/);
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
        .map(function (item) { return item.replace(/^\s+|\s+$/g, ''); })
        .filter(function (item) { return !!item; });
      if (!list.length) {
        throw new Error('cli(): "' + flag + '" needs a comma-separated value, e.g. ' + flag + ' orders,customers.');
      }
      parsed[flag === '--select' ? 'select' : 'exclude'] =
        parsed[flag === '--select' ? 'select' : 'exclude'].concat(list);
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
    var claimedNames = {};
    keys.forEach(function (key) {
      var value;
      try {
        value = scope[key];
      } catch (error) {
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
      }
      var kind;
      var declaredName;
      var dependsOn;
      try {
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
      (dependsOn || []).forEach(function (dependency) {
        if (typeof dependency !== 'string' || !dependency) {
          throw new Error('cli(): node "' + name + '" has a "dependsOn" entry that is not a node name string.');
        }
      });
      nodes.push({
        name: name,
        kind: kind,
        variable: key,
        config: value,
        dependsOn: (dependsOn || []).slice()
      });
    });
    return { nodes: nodes, ignored: ignored };
  }

  // Every dependsOn entry must name a node that actually exists. Checked
  // against everything discovered, not just the current selection, so
  // "--select" narrowing what runs never turns a real typo into a
  // silently-ignored dependency.
  function assertDependenciesExist(nodes) {
    var byName = {};
    nodes.forEach(function (node) { byName[node.name] = true; });
    nodes.forEach(function (node) {
      node.dependsOn.forEach(function (dependency) {
        if (!has(byName, dependency)) {
          throw new Error('cli(): node "' + node.name + '" dependsOn "' + dependency + '", which is not a declared node. Known nodes: ' + Object.keys(byName).join(', ') + '.');
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
    if (byKind.length) {
      return byKind.map(function (node) { return node.name; });
    }
    var byName = nodes.filter(function (node) { return node.name === token; });
    if (byName.length) {
      return byName.map(function (node) { return node.name; });
    }
    throw new Error('cli(): "' + token + '" matched no kind and no node name. Kinds: ' + knownKinds().join(', ') + '. Nodes: ' + nodes.map(function (node) { return node.name; }).join(', ') + '.');
  }

  // Applies --select then --exclude. Note --select selects exactly what it
  // names: it does not pull in upstream dependencies, which are assumed to
  // have run already. (dbt spells that distinction "orders" vs "+orders";
  // the "+" operators are deliberately left out of this first version.)
  function applySelection(nodes, select, exclude) {
    var selected = nodes;
    if (select.length) {
      var wanted = {};
      select.forEach(function (token) {
        resolveSelector(nodes, token).forEach(function (name) { wanted[name] = true; });
      });
      selected = selected.filter(function (node) { return has(wanted, node.name); });
    }
    if (exclude.length) {
      var unwanted = {};
      exclude.forEach(function (token) {
        resolveSelector(nodes, token).forEach(function (name) { unwanted[name] = true; });
      });
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
    var byName = {};
    var waitingOn = {};
    var dependents = {};
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
      var stuck = nodes
        .filter(function (node) { return ordered.indexOf(node) === -1; })
        .map(function (node) { return node.name; });
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
    var blocked = {};
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
    var discovered;
    try {
      discovered = discoverNodes();
    } catch (error) {
      lines.push('But discovering nodes failed: ' + error.message);
      var failureMessage = lines.join('\n');
      Logger.log(failureMessage);
      return failureMessage;
    }
    if (discovered.nodes.length) {
      lines.push('Discovered ' + discovered.nodes.length + ' node(s): ' + discovered.nodes.map(function (node) {
        return node.name + ' (' + node.kind + ')';
      }).join(', ') + '.');
    } else {
      lines.push('Discovered 0 nodes. If you expected some, check they are declared as top-level "var"s - a config object declared inside a function is invisible to cli().');
    }
    if (discovered.ignored.length) {
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
