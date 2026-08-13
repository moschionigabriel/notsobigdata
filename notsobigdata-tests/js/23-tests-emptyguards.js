// 23-tests-emptyguards.js — emptyguards test category (see PROJECT.md; runAllTests('emptyguards')).


// ===================================================================
// Tests — the empty-extract guards
//
// Each guard node dependsOn the real load that writes the content it must
// prove it left alone, so a full cli('run') always seeds before guarding.
// ===================================================================

function testEmptyGuardSheets() {
  var spreadsheetId = P.SHEETS_SOURCE_SPREADSHEET_ID;
  runOne('loadSheetsOverwrite');
  var before = SpreadsheetApp.openById(spreadsheetId).getSheetByName('LoadTest').getLastRow();
  runOne('emptyGuardSheets');
  var after = SpreadsheetApp.openById(spreadsheetId).getSheetByName('LoadTest').getLastRow();
  check('an empty extract left the sheet untouched instead of clearing it',
    before === after && before > 0,
    before + ' rows before, ' + after + ' after');
}


function testEmptyGuardDriveCsv() {
  runOne('loadDriveCsvOverwrite');
  var before = DriveApp.getFileById(P.DRIVE_CSV_TARGET_FILE_ID).getBlob().getDataAsString();
  runOne('emptyGuardDriveCsv');
  var after = DriveApp.getFileById(P.DRIVE_CSV_TARGET_FILE_ID).getBlob().getDataAsString();
  check('an empty extract left the csv file untouched',
    before === after && before.length > 0,
    before.length + ' bytes before, ' + after.length + ' after');
}


function testEmptyGuardDriveXlsx() {
  runOne('loadDriveXlsx');
  var before = DriveApp.getFileById(P.DRIVE_XLSX_TARGET_FILE_ID).getSize();
  runOne('emptyGuardDriveXlsx');
  var after = DriveApp.getFileById(P.DRIVE_XLSX_TARGET_FILE_ID).getSize();
  check('an empty extract left the xlsx file untouched',
    before === after && before > 0,
    before + ' bytes before, ' + after + ' after');
}
