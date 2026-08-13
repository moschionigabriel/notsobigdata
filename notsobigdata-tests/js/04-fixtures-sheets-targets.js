// 04-fixtures-sheets-targets.js — Declared move() nodes targeting Google Sheets. Backs the 'load' test category.

// ===================================================================
// Declared nodes — Sheets targets
//
// The LoadTest chain is sequenced with dependsOn because all three nodes
// write to the same tab: overwrite must land before append, and the
// empty-extract guard must run last so there's real content for it to
// prove it left alone. This is the ordering cli() exists to handle - the
// nodes say what they depend on, not what order to run in.
// ===================================================================

var loadSheetsOverwrite = {
  kind: 'move',
  name: 'loadSheetsOverwrite',
  source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_TABLE },
  target: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, sheetName: 'LoadTest', mode: 'overwrite' }
};

var loadSheetsAppend = {
  kind: 'move',
  name: 'loadSheetsAppend',
  dependsOn: ['loadSheetsOverwrite'],
  source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_TABLE },
  target: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, sheetName: 'LoadTest', mode: 'append' }
};

// Empty extract + overwrite target: the guard should skip the clear
// entirely rather than blanking the tab out for nothing.
var emptyGuardSheets = {
  kind: 'move',
  name: 'emptyGuardSheets',
  dependsOn: ['loadSheetsAppend'],
  source: { type: 'custom', fn: myCustomExtractEmpty },
  target: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, sheetName: 'LoadTest', mode: 'overwrite' }
};

var loadSheetsRangeOverwrite = {
  kind: 'move',
  name: 'loadSheetsRangeOverwrite',
  source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_TABLE },
  target: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, sheetName: 'RangeTest', range: 'B2', mode: 'overwrite' }
};

var loadSheetsRangeAppendNoHeader = {
  kind: 'move',
  name: 'loadSheetsRangeAppendNoHeader',
  dependsOn: ['loadSheetsRangeOverwrite'],
  source: { type: 'bigquery', projectId: P.BIGQUERY_PROJECT_ID, dataset: P.BIGQUERY_DATASET, table: P.BIGQUERY_TABLE },
  target: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, sheetName: 'RangeTest', range: 'B2', mode: 'append', includeHeader: false }
};
