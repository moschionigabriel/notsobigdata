// 05-fixtures-drive-targets.js — Declared move() nodes targeting Drive files (csv/json/xlsx). Backs the
// 'load'/'emptyguards'/'regressions' test categories.

// ===================================================================
// Declared nodes — Drive targets
// ===================================================================

// Creates a brand new file every run (Drive allows duplicate names), which
// is exactly what loadDriveUpsert below exists to offer an alternative to.
var loadDriveCsvNew = {
  kind: 'move',
  name: 'loadDriveCsvNew',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE },
  target: { type: 'drive', fileType: 'csv', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'notsobigdata-load-new-test.csv' }
};

var loadDriveCsvOverwrite = {
  kind: 'move',
  name: 'loadDriveCsvOverwrite',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE },
  target: { type: 'drive', fileType: 'csv', fileId: P.DRIVE_CSV_TARGET_FILE_ID }
};

// Regression fixture for the "[object Object]" data-loss bug: an api
// source with nested object values (address, company), loaded straight to
// a drive csv target - the exact combination that used to corrupt.
var loadNestedToCsv = {
  kind: 'move',
  name: 'loadNestedToCsv',
  source: { type: 'api', url: P.API_SOURCE_URL_NESTED },
  target: { type: 'drive', fileType: 'csv', folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'notsobigdata-nested-object-test.csv' }
};

var emptyGuardDriveCsv = {
  kind: 'move',
  name: 'emptyGuardDriveCsv',
  dependsOn: ['loadDriveCsvOverwrite'],
  source: { type: 'custom', fn: myCustomExtractEmpty },
  target: { type: 'drive', fileType: 'csv', fileId: P.DRIVE_CSV_TARGET_FILE_ID }
};

var loadDriveJson = {
  kind: 'move',
  name: 'loadDriveJson',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE },
  target: { type: 'drive', fileType: 'json', fileId: P.DRIVE_JSON_TARGET_FILE_ID }
};

var loadDriveXlsx = {
  kind: 'move',
  name: 'loadDriveXlsx',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE },
  target: { type: 'drive', fileType: 'xlsx', fileId: P.DRIVE_XLSX_TARGET_FILE_ID }
};

var emptyGuardDriveXlsx = {
  kind: 'move',
  name: 'emptyGuardDriveXlsx',
  dependsOn: ['loadDriveXlsx'],
  source: { type: 'custom', fn: myCustomExtractEmpty },
  target: { type: 'drive', fileType: 'xlsx', fileId: P.DRIVE_XLSX_TARGET_FILE_ID }
};

var loadDriveUpsert = {
  kind: 'move',
  name: 'loadDriveUpsert',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE },
  target: {
    type: 'drive',
    fileType: 'csv',
    folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID,
    fileName: 'notsobigdata-load-upsert-test.csv',
    upsertByName: true
  }
};
