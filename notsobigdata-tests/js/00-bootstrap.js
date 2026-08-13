// 00-bootstrap.js — Loads the library and pulls Script Properties into P — must load
// first so every other file can read P.* and call the library.

// Loads the library at the top level (outside any function) so every
// function below can use NotSoBigData — a direct eval()'s var/function
// declarations only leak into the scope it's called from, so a helper
// function wrapping this eval would isolate NotSoBigData to itself and
// lose it the moment that helper returned.
//
// This re-fetches src.js from GitHub on every single execution, since
// Apps Script re-evaluates top-level code each time any function in the
// project runs. Skips quietly (doesn't throw) if SRC_REF isn't set yet,
// so setupScriptProperties() can still run standalone on a fresh project.
var SRC_REF = PropertiesService.getScriptProperties().getProperty('SRC_REF');
if (SRC_REF) {
  var SRC_URL = 'https://raw.githubusercontent.com/moschionigabriel/notsobigdata/' + SRC_REF + '/src.js';
  eval(UrlFetchApp.fetch(SRC_URL).getContentText());
}

// One round trip for every property, instead of one per lookup - top-level
// code re-runs on every single execution, so 20 separate getProperty()
// calls would be 20 API calls before any test even starts. Returns {} on a
// fresh project where nothing is set yet, which is fine: the node configs
// below just end up holding undefined ids, and only *running* one fails.
var P = PropertiesService.getScriptProperties().getProperties();
