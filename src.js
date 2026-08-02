var NotSoBigData = (function () {
  function helloWorld() {
    return 'Hello, World! notsobigdata is alive.';
  }

  // Flattens an array of plain objects into a 2D array: a header row taken
  // from the first element's keys, followed by one row per element. Keys
  // missing on a later element become blank cells rather than throwing,
  // since JSON/API payloads commonly have optional fields.
  function objectsToRows(objects) {
    if (!objects || objects.length === 0) {
      return [];
    }
    var headers = Object.keys(objects[0]);
    var rows = [headers];
    for (var i = 0; i < objects.length; i++) {
      var row = [];
      for (var j = 0; j < headers.length; j++) {
        var value = objects[i][headers[j]];
        row.push(value === undefined ? '' : value);
      }
      rows.push(row);
    }
    return rows;
  }

  function extractSheets(source) {
    var spreadsheet = SpreadsheetApp.openById(source.spreadsheetId);
    var range = source.range
      ? spreadsheet.getRange(source.range)
      : spreadsheet.getActiveSheet().getDataRange();
    return range.getValues();
  }

  function extractDriveCsv(file) {
    return Utilities.parseCsv(file.getBlob().getDataAsString());
  }

  function extractDriveJson(file) {
    var parsed = JSON.parse(file.getBlob().getDataAsString());
    return objectsToRows(parsed);
  }

  // Apps Script has no native XLSX parser, so this converts the file to a
  // temporary Google Sheet via the Advanced Drive Service, reads it with
  // SpreadsheetApp, and always deletes the temp copy afterward — including
  // on error — so a failed extract never leaves an orphan file in the
  // user's Drive.
  function extractDriveXlsx(file) {
    var tempFileMetadata = Drive.Files.copy(
      { name: 'notsobigdata-xlsx-import-' + file.getId(), mimeType: MimeType.GOOGLE_SHEETS },
      file.getId()
    );
    try {
      var spreadsheet = SpreadsheetApp.openById(tempFileMetadata.id);
      return spreadsheet.getActiveSheet().getDataRange().getValues();
    } finally {
      Drive.Files.remove(tempFileMetadata.id);
    }
  }

  function extractDrive(source) {
    var file = DriveApp.getFileById(source.fileId);
    switch (source.fileType) {
      case 'csv':
        return extractDriveCsv(file);
      case 'json':
        return extractDriveJson(file);
      case 'xlsx':
        return extractDriveXlsx(file);
      default:
        throw new Error('move(): unsupported drive source fileType "' + source.fileType + '". Expected "csv", "json", or "xlsx".');
    }
  }

  // Reads a full BigQuery table via the Advanced BigQuery Service. The
  // table identifier is backtick-quoted since it's interpolated into SQL
  // text, even though it's the pipeline author's own declared config, not
  // runtime user input — move() never accepts arbitrary SQL, that stays
  // model()'s job.
  function extractBigQuery(source) {
    var tableRef = '`' + source.projectId + '.' + source.dataset + '.' + source.table + '`';
    var queryRequest = {
      query: 'SELECT * FROM ' + tableRef,
      useLegacySql: false
    };
    var queryResults = BigQuery.Jobs.query(queryRequest, source.projectId);

    var jobId = queryResults.jobReference.jobId;
    while (!queryResults.jobComplete) {
      Utilities.sleep(500);
      queryResults = BigQuery.Jobs.getQueryResults(source.projectId, jobId);
    }

    var fields = queryResults.schema.fields;
    var headers = fields.map(function (field) { return field.name; });
    var rows = [headers];
    var apiRows = queryResults.rows || [];
    for (var i = 0; i < apiRows.length; i++) {
      var values = apiRows[i].f;
      var row = [];
      for (var j = 0; j < values.length; j++) {
        row.push(values[j].v);
      }
      rows.push(row);
    }
    return rows;
  }

  // Expects the API to respond with a JSON array of objects, using the
  // same first-object-keys flattening as Drive JSON sources.
  function extractApi(source) {
    var response = UrlFetchApp.fetch(source.url, source.options || {});
    var parsed = JSON.parse(response.getContentText());
    return objectsToRows(parsed);
  }

  function extract(source) {
    switch (source.type) {
      case 'sheets':
        return extractSheets(source);
      case 'drive':
        return extractDrive(source);
      case 'bigquery':
        return extractBigQuery(source);
      case 'api':
        return extractApi(source);
      default:
        throw new Error('move(): unsupported source type "' + source.type + '". Expected "sheets", "drive", "bigquery", or "api".');
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
