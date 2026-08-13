// 07-fixtures-api-custom-targets.js — Declared move() nodes targeting an external API/custom function, plus
// the deliberate-typo-kind fixture. Backs the 'load' test category.

// ===================================================================
// Declared nodes — API and custom targets
// ===================================================================

var loadApi = {
  kind: 'move',
  name: 'loadApi',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE },
  target: { type: 'api', url: P.API_TARGET_URL }
};

var loadCustom = {
  kind: 'move',
  name: 'loadCustom',
  source: { type: 'sheets', spreadsheetId: P.SHEETS_SOURCE_SPREADSHEET_ID, range: P.SHEETS_SOURCE_RANGE },
  target: { type: 'custom', fn: myCustomLoad }
};

// Not a node: an unrecognized kind. cli() ignores it rather than throwing
// (an unrelated global could legitimately have a "kind" key) but reports it
// in hello/list output, so a typo like this is visible instead of silent.
var deliberateTypoKind = {
  kind: 'mvoe',
  source: { type: 'custom', fn: myCustomExtract }
};
