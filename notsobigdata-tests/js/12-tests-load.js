// 12-tests-load.js — load test category (see PROJECT.md; runAllTests('load')).


// ===================================================================
// Tests — the move kind, load
// ===================================================================

function testLoadSheets() {
  var spreadsheetId = P.SHEETS_SOURCE_SPREADSHEET_ID;
  var overwritten = runOne('loadSheetsOverwrite');
  var afterOverwrite = SpreadsheetApp.openById(spreadsheetId).getSheetByName('LoadTest').getLastRow();
  check('overwrite wrote the source rows',
    afterOverwrite === overwritten.loadResult.numRows,
    'tab has ' + afterOverwrite + ' rows, loadResult reports ' + overwritten.loadResult.numRows);

  var appended = runOne('loadSheetsAppend');
  var afterAppend = SpreadsheetApp.openById(spreadsheetId).getSheetByName('LoadTest').getLastRow();
  check('append added rows after the existing ones',
    afterAppend === afterOverwrite + appended.loadResult.numRows,
    'tab went from ' + afterOverwrite + ' to ' + afterAppend + ' rows, starting at row ' + appended.loadResult.startRow);
}


function testLoadSheetsRangeAndIncludeHeader() {
  var rangeSheet = SpreadsheetApp.openById(P.SHEETS_SOURCE_SPREADSHEET_ID).getSheetByName('RangeTest');
  var overwritten = runOne('loadSheetsRangeOverwrite');
  check('overwrite with range "B2" started at row 2, column 2',
    overwritten.loadResult.startRow === 2 && overwritten.loadResult.startColumn === 2,
    'wrote ' + overwritten.loadResult.numRows + ' rows at row ' + overwritten.loadResult.startRow + ', column ' + overwritten.loadResult.startColumn);

  // overwrite only clears the anchor cell, not the whole sheet below it, so
  // RangeTest's last row keeps growing across repeated runs - append's real
  // landing spot is "wherever the sheet's last row actually is right now",
  // never a fixed offset from this run's own overwrite. Read that live,
  // before and after, the same way the non-range testLoadSheets above does.
  var beforeAppend = rangeSheet.getLastRow();
  var appended = runOne('loadSheetsRangeAppendNoHeader');
  var afterAppend = rangeSheet.getLastRow();
  var expectedDataRows = overwritten.loadResult.numRows - 1;
  check('append with includeHeader:false skipped the header row and landed after existing data',
    appended.loadResult.startColumn === 2 && appended.loadResult.numRows === expectedDataRows &&
    appended.loadResult.startRow === beforeAppend + 1 && afterAppend === beforeAppend + expectedDataRows,
    'wrote ' + appended.loadResult.numRows + ' rows (expected ' + expectedDataRows + ') at row ' + appended.loadResult.startRow +
    ' (expected ' + (beforeAppend + 1) + '), sheet lastRow ' + afterAppend + ' (expected ' + (beforeAppend + expectedDataRows) + '), column ' + appended.loadResult.startColumn);
}


function testLoadDriveCsv() {
  var created = runOne('loadDriveCsvNew');
  var createdContent = DriveApp.getFileById(created.loadResult).getBlob().getDataAsString();
  check('created a new csv file with the extracted rows',
    createdContent.split('\n').length - 1 >= created.length - 1,
    'file ' + created.loadResult + ' holds: ' + createdContent.split('\n')[0]);
  DriveApp.getFileById(created.loadResult).setTrashed(true);

  var staleMarker = 'notsobigdata-stale-marker-' + new Date().getTime();
  DriveApp.getFileById(P.DRIVE_CSV_TARGET_FILE_ID).setContent(staleMarker);
  var overwritten = runOne('loadDriveCsvOverwrite');
  var overwrittenContent = DriveApp.getFileById(overwritten.loadResult).getBlob().getDataAsString();
  check('overwrote the existing csv target by fileId',
    overwrittenContent.indexOf(staleMarker) === -1 && overwrittenContent.indexOf(String(overwritten[0][0])) === 0,
    'first line: ' + overwrittenContent.split('\n')[0]);
}


function testLoadDriveJson() {
  var rows = runOne('loadDriveJson');
  var parsed = JSON.parse(DriveApp.getFileById(rows.loadResult).getBlob().getDataAsString());
  check('json target wrote an array of objects',
    Array.isArray(parsed) && parsed.length === rows.length - 1,
    parsed.length + ' objects for ' + (rows.length - 1) + ' data rows; keys: ' + Object.keys(parsed[0] || {}));
}


function testLoadDriveXlsx() {
  var rows = runOne('loadDriveXlsx');
  check('xlsx target reported the written file id', !!rows.loadResult, 'file id ' + rows.loadResult);
  var readBack = NotSoBigData.cli('run --select extractDriveXlsx').nodes[0];
  check('the xlsx source fixture still reads back after the write', readBack.status === 'success', readBack.error || '');
}


function testLoadDriveUpsertByName() {
  var first = runOne('loadDriveUpsert');
  var second = runOne('loadDriveUpsert');
  check('upsertByName reused the same file on the second run',
    first.loadResult === second.loadResult,
    first.loadResult + ' vs ' + second.loadResult);
  DriveApp.getFileById(first.loadResult).setTrashed(true);
}


// upsertByName refuses to guess which file to overwrite when more than one
// already carries the name. Creates the duplicates itself so this is
// self-contained and repeatable, and cleans up in a finally.
function testLoadDriveUpsertRejectsDuplicates() {
  var duplicateName = 'notsobigdata-load-upsert-duplicate-test.csv';
  var folder = DriveApp.getFolderById(P.NOTSOBIGDATA_DRIVE_FOLDER_ID);
  var fileA = folder.createFile(duplicateName, 'a', MimeType.CSV);
  var fileB = folder.createFile(duplicateName, 'b', MimeType.CSV);
  try {
    withTemporaryNodes({
      tmpUpsertDuplicate: {
        kind: 'move', name: 'tmpUpsertDuplicate',
        source: { type: 'custom', fn: myCustomExtract },
        target: { type: 'drive', fileType: 'csv', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: duplicateName, upsertByName: true }
      }
    }, function () {
      var error = runOneExpectingFailure('tmpUpsertDuplicate');
      check('upsertByName rejected duplicate filenames', error.length > 0, error);
    });
  } finally {
    fileA.setTrashed(true);
    fileB.setTrashed(true);
  }
}


function testLoadApi() {
  var rows = runOne('loadApi');
  check('api target got a 2xx back',
    rows.loadResult.statusCode >= 200 && rows.loadResult.statusCode < 300,
    'HTTP ' + rows.loadResult.statusCode);
}


function testLoadCustom() {
  var rows = runOne('loadCustom');
  check('custom target return value came back as loadResult',
    rows.loadResult === 'custom-load-wrote-' + rows.length + '-rows',
    String(rows.loadResult));
}

// Not wired into TEST_CATEGORIES below - runAllTests() never runs this
// one on its own. Pre-existing gap, left as-is by this reorg; worth
// deciding on deliberately rather than folding it in silently.

function testLoadNestedObjectsToCsv() {
  var rows = runOne('loadNestedToCsv');
  var content = DriveApp.getFileById(rows.loadResult).getBlob().getDataAsString();
  check('csv output does not contain the data-loss marker "[object Object]"',
    content.indexOf('[object Object]') === -1, content.slice(0, 300));
  check('csv output contains readable JSON for the nested "address" field',
    content.indexOf('city') !== -1, content.slice(0, 300));
  DriveApp.getFileById(rows.loadResult).setTrashed(true);
}
