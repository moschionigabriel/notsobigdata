// 90-test-registry.js — Script Properties bootstrap, TEST_CATEGORIES, and runAllTests().

// ===================================================================
// Setup and suite runner
// ===================================================================

function setupScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    // Pointed at release/12, now that all 9 fixes tested on the (deleted)
    // test/release-12-integration branch have merged in. Flip to 'main'
    // once release/12 itself merges. Remember src.js is generated - only
    // worth testing once ./build.sh has been run and the rebuilt src.js
    // committed, which it has been here.
    SRC_REF: 'release/12',
    NOTSOBIGDATA_DRIVE_FOLDER_ID: '16ZrtrxrO40w4InGi_bzL8I7WLGODa4Dd',
    // Sheets/Drive fixtures below all hold the same 3-row orders sample
    // (order_id, customer, amount), created inside the notsobigdata Drive
    // folder for testing the move kind's extract functions.
    SHEETS_SOURCE_SPREADSHEET_ID: '1uGbl_bmdPr9I0BPhvkTIrX8XM7bZknYjceSnH7YMEvI',
    // No sheet-name prefix: getRange('A1:C4') without a "SheetName!" prefix
    // resolves against the active sheet, so this works regardless of what
    // the default tab is actually called in your account's locale (e.g.
    // "Sheet1" vs "Página1").
    SHEETS_SOURCE_RANGE: 'A1:C4',
    DRIVE_CSV_FILE_ID: '1grRMY88zhxnn8dsen0CSINOB2LQujVRn',
    DRIVE_XLSX_FILE_ID: '1dggNdQpl3wnPn3tkKppVyElTBKrrkADC',
    DRIVE_JSON_FILE_ID: '1iEIotZZJfd9FC-T1nvRqZknRHc7P2sDM',
    // Same 3-row orders sample, but wrapped in an envelope
    // ({"status":..., "data":[...]}) instead of being a bare array. Exists
    // only to prove the library rejects that shape with a readable message
    // rather than a raw "objects.reduce is not a function" TypeError.
    DRIVE_JSON_ENVELOPE_FILE_ID: '1HZwttZGBafLidpl64PuQUufFMNGELOF2',
    BIGQUERY_PROJECT_ID: 'notsobigdata',
    BIGQUERY_DATASET: 'test',
    BIGQUERY_TABLE: 'test_orders',
    // .sql fixture in the notsobigdata Drive folder, aggregating the same
    // test_orders table for testing bigquery source.queryFileId.
    BIGQUERY_QUERY_FILE_ID: '1cVk1JHGb4CSpYwGURVJzwXXMsFuqB8C2',
    // Public JSONPlaceholder endpoints (no auth, always available) for the
    // external API source tests. /todos is the flat happy path - every
    // field is a primitive. /users is the edge case: each object has
    // nested objects (address, company), which objectsToRows() doesn't
    // flatten - it pushes the nested object straight into the cell.
    API_SOURCE_URL_FLAT: 'https://jsonplaceholder.typicode.com/todos',
    API_SOURCE_URL_NESTED: 'https://jsonplaceholder.typicode.com/users',
    // GitHub's search API, no auth required - wraps its results as
    // {"items": [...], "total_count": ...} instead of a bare array, for
    // testing the api source's "envelope" key.
    API_SOURCE_URL_ENVELOPED: 'https://api.github.com/search/repositories?q=topic:google-apps-script&per_page=5',

    // Fixtures for the url source. The csv one is a real, stable public
    // GitHub raw link (dbt Labs' own jaffle-shop-classic tutorial seed
    // data); the blob-form variant is the exact URL GitHub's own
    // file-view UI hands you for the same file, for testing
    // rewriteGithubBlobUrl(). json/xlsx reuse the same style of public,
    // no-auth test endpoints the api source fixtures above already use.
    URL_SOURCE_CSV: 'https://raw.githubusercontent.com/dbt-labs/jaffle-shop-classic/main/seeds/raw_customers.csv',
    URL_SOURCE_GITHUB_BLOB_CSV: 'https://github.com/dbt-labs/jaffle-shop-classic/blob/main/seeds/raw_customers.csv',
    URL_SOURCE_JSON: 'https://jsonplaceholder.typicode.com/todos',
    // Microsoft's own "Financial Sample.xlsx", used across their own Power
    // BI/Excel tutorials for years - about as stable as a public xlsx
    // download link gets.
    URL_SOURCE_XLSX: 'https://go.microsoft.com/fwlink/?LinkID=521962',

    // --- load target fixtures below ---
    // Deliberately separate from the SOURCE fixtures above: the load tests
    // overwrite these files/table every run, and reusing a source fixture
    // as a load target would corrupt the fixed 3-row sample the extract
    // tests depend on. The three DRIVE_*_TARGET_FILE_ID placeholders
    // (csv/json/xlsx) already exist in the notsobigdata Drive folder -
    // their starting content doesn't matter since every load test run
    // overwrites it.
    DRIVE_CSV_TARGET_FILE_ID: '1-vl35N8UaICtB9VjugYdQRLoTqvJiDeI',
    DRIVE_JSON_TARGET_FILE_ID: '1XROtHw71uEMNS4dF4w-SVYf5Krq0B0zu',
    DRIVE_XLSX_TARGET_FILE_ID: '1iNj_eHlRymqbduOlSqZeTJdGVXJrKjL1',
    // No manual setup needed - BigQuery load jobs create the destination
    // table automatically if it doesn't exist yet, so these can just be
    // fresh names distinct from BIGQUERY_TABLE (the read fixture above).
    BIGQUERY_LOAD_TABLE: 'test_orders_load',
    // Scratch table for the target.schema test, kept separate from
    // BIGQUERY_LOAD_TABLE so the forced STRING schema can't collide with
    // the autodetected one. Lives here rather than inline in the test
    // because table names are identifying values (see CLAUDE.md, "About
    // testing").
    BIGQUERY_SCHEMA_TABLE: 'test_orders_schema_test',
    // Two more scratch tables, for the target.allowSchemaEvolution tests -
    // kept separate from each other (not just from BIGQUERY_LOAD_TABLE/
    // BIGQUERY_SCHEMA_TABLE above) so the "control" fixture proving
    // today's fail-loud default still holds can't be polluted by the
    // "enabled" fixture's own successful column addition.
    BIGQUERY_EVOLUTION_TABLE: 'test_orders_evolution',
    BIGQUERY_EVOLUTION_CONTROL_TABLE: 'test_orders_evolution_control',
    // Scratch tables for the target.sqlTests staging tests - a "real"
    // table the passing/failing fixtures stage+promote into, and a small
    // reference table the sqlTests query joins against for the
    // referential-integrity check.
    BIGQUERY_SQLTEST_TABLE: 'test_orders_sqltest',
    BIGQUERY_SQLTEST_REFERENCE_TABLE: 'test_customers_sqltest',
    // A third scratch table, separate from BIGQUERY_SQLTEST_TABLE, for
    // the one combination never actually run before release/7's
    // simplify pass: sqlTests staging together with
    // allowSchemaEvolution on the same target.
    BIGQUERY_SQLTEST_EVOLUTION_TABLE: 'test_orders_sqltest_evolution',
    // Scratch table for the {{ ref() }}-resolves-a-move-node tests - a
    // model materializes straight off whatever this table holds, so it's
    // kept separate from every other scratch table above rather than
    // reused, the same "don't let one test's fixture data leak into
    // another's assumptions" reasoning those already follow.
    BIGQUERY_REF_TEST_TABLE: 'test_orders_ref_test',
    // JSONPlaceholder's /posts fakes a 201 and echoes the payload back
    // without actually persisting it - enough to confirm the api target
    // builds and sends a well-formed POST, same no-auth/always-available
    // reasoning as the API_SOURCE_URL_* properties above.
    API_TARGET_URL: 'https://jsonplaceholder.typicode.com/posts'
  });
  Logger.log('Script properties set. Re-run any test function to pick up the change.');
}

// The categories runAllTests() can filter down to - the same groupings
// the test list used to only mark with inline comments. Order matters:
// flattened together (the "no category" case) this is the same run order
// as before - cli() checks first since they're cheap and gate everything,
// then extract/load/bigquery/datatests exercise the move kind itself,
// then the empty-extract guards and regression fixtures, and the
// whole-pipeline tests last since they depend on nodes the earlier
// categories already exercised individually. "bigquery" is every
// BigQuery-touching test pulled out of extract/load (not duplicated -
// each test lives in exactly one category, so a full run's total test
// count is still every category's length summed once) - see its own
// comment below for why it's worth a category of its own.
var TEST_CATEGORIES = {
  cli: [
    testHello,
    testHelp,
    testList,
    testDependencyOrder,
    testSelectByKind,
    testSelectByName,
    testSelectCommaList,
    testExclude,
    testSelectDoesNotPullUpstreams,
    testUnknownSelectorThrows,
    testUnknownCommandThrows,
    testCycleThrows,
    testMissingDependencyThrows,
    testFailureSkipsDownstream,
    testFunctionScopedConfigIsInvisible,
    testDebugProbeIgnoresMuteHttpExceptionsOverride
  ],
  extract: [
    testExtractSheets,
    testExtractDriveCsv,
    testExtractDriveXlsx,
    testExtractDriveJson,
    testExtractApiFlat,
    testExtractApiNested,
    testExtractApiEnveloped,
    testExtractApiPaginated,
    testExtractApiPaginatedRespectsMaxPages,
    testExtractApiPaginationRejectsMissingTokenPath,
    testExtractApiPaginationRejectsMissingMaxPages,
    testExtractApiPaginationRejectsMissingParam,
    testExtractCustom,
    testExtractCustomRejectsNonFunction,
    testExtractCustomRejectsBadShape,
    testExtractUrlCsv,
    testExtractUrlGithubBlob,
    testExtractUrlGithubBlobWithQueryStringAndFragment,
    testExtractUrlJson,
    testExtractUrlXlsx,
    testExtractUrlRejectsUnsupportedFileType
  ],
  load: [
    testLoadSheets,
    testLoadSheetsRangeAndIncludeHeader,
    testLoadDriveCsv,
    testLoadDriveJson,
    testLoadDriveXlsx,
    testLoadDriveUpsertByName,
    testLoadDriveUpsertRejectsDuplicates,
    testLoadApi,
    testLoadCustom
  ],
  // Every BigQuery-touching extract/load test, pulled out of extract/load
  // above rather than duplicated - each BigQuery API round trip is slow
  // enough in practice (a single node load/query has been observed
  // taking 3-9 seconds) that "extract"/"load" as whole categories risk
  // Apps Script's own execution-time limit even though neither is a
  // huge test count. This category exists to re-verify anything
  // BigQuery-specific (like a bigquery target fix) without waiting
  // through the unrelated Sheets/Drive/API tests those two categories
  // still carry.
  bigquery: [
    testExtractBigQueryTable,
    testExtractBigQueryQuery,
    testExtractBigQueryQueryFile,
    testExtractBigQueryRejectsNonSelect,
    testLoadBigQuery,
    testLoadBigQuerySchema,
    testLoadBigQuerySchemaEvolutionEnabled,
    testLoadBigQuerySchemaEvolutionControlFails,
    testLoadBigQuerySqlTestsPass,
    testLoadBigQuerySqlTestsFail,
    testLoadBigQuerySqlTestsWithSchemaEvolution
  ],
  // Same reasoning as "bigquery" above - every model test round-trips
  // through BigQuery, so model gets its own categories rather than being
  // folded into "bigquery" itself (which predates the model kind and is
  // scoped to move's own connector). Originally one flat "model" category;
  // split by what each test actually exercises once it grew to 29 tests,
  // the same complaint that motivated splitting "bigquery" out of
  // extract/load in the first place - a fix to one area (say, the
  // template-call dispatch) shouldn't need waiting through unrelated
  // dbt-test or SQL-file-resolution round trips just to re-verify it.
  // Dropped the flat "model" key entirely rather than keeping it as a
  // duplicate union of these six - same precedent "bigquery" set (it was
  // removed from extract/load, not kept there too).
  'model-core': [
    testModelViewDependencyOrderAndTableMaterialization
  ],
  'model-dependson': [
    testModelDependsOnMoveNodeOrdersCorrectly,
    testModelDependsOnUnionsWithRefDependencies,
    testModelDependsOnEntryOverridesRegistryDefault,
    testModelMalformedDependsOnFailsAtList
  ],
  // {{ ref() }}/{{ config() }} and anything about the template-call
  // dispatch itself - not sqlFile/tag *resolution* (see "model-files"
  // below for that).
  'model-jinja': [
    testModelRefToNonModelNodeThrows,
    testModelRefResolvesMoveNodeBigQueryTarget,
    testModelRefToNonBigQueryMoveTargetFailsAtList,
    testModelUnsupportedTemplateCallThrows,
    testModelKwargStyleCallThrows,
    testModelConfigMacroOverridesMaterialized,
    testModelConfigUnknownKeyThrows,
    testModelConfigTwoCallsThrows,
    testModelSetVarDryUsage,
    testModelSetUndefinedThrows,
    testModelSetDuplicateKeyThrows,
    testModelVarMissingNoDefaultThrows,
    testModelVarResolvesFromRegistryAndDefault,
    testModelVarCommentedOutIsInert,
    testModelForLoopExpandsAndRuns,
    testModelForLoopCommaInsideQuotedItemRuns,
    testModelForLoopNestedFailsAtList,
    testModelForLoopUnterminatedFailsAtList,
    testModelMacroExpandsAndPropagatesRefDependency,
    testModelMacroUnknownNameThrows,
    testModelMacroArgCountMismatchFailsAtList,
    testModelMacroCallingMacroThrows,
    testModelMacroCrossFileNameCollisionThrows,
    testModelMacroUnterminatedThrows
  ],
  'model-files': [
    testModelSqlFileDefaultsToNodeName,
    testModelMultipleSqlTagsWithoutIdsFailsAtList,
    testModelNoTagWholeFileIsSql,
    testModelSharedFileResolvesByIdAndOrdersCorrectly,
    testModelSingleTagMismatchedIdFailsAtList,
    testModelSharedFileNoIdMatchFailsAtList,
    testModelSharedFileDuplicateIdFailsAtList
  ],
  // Registry/config shape errors and discovery's own isolation guarantee
  // (one broken model must not take down the rest) - not a template call,
  // not a SQL-file resolution rule.
  'model-discovery': [
    testModelRegistryNameCollisionThrows,
    testModelMultiStatementThrows,
    testModelMalformedRegistryThrows,
    testModelTopLevelVarRejected,
    testModelBrokenModelDoesNotBlockUnrelatedNode
  ],
  'model-tests': [
    testModelTestsPassAndRelationshipsOrdersCorrectly,
    testModelGenericTestsFailCollectAllViolations,
    testModelCustomQueryTestFails,
    testModelTestsBothCheckAndQueryFailsAtList,
    testModelTestsAcceptedValuesEmptyValuesFailsAtList,
    testModelTestsRelationshipsUnknownToThrows,
    testModelTestsRelationshipsToNonModelNodeFailsAtList,
    testModelTableStagedTestsPassPromotesRelation,
    testModelTableStagedTestsFailBlocksPromotion
  ],
  // cli('compile') - resolves a model's SQL without executing anything.
  // Its own category rather than folded into "model-jinja"/"model-core":
  // every test here is about the compile *command* itself (does it run
  // BigQuery, does a move node no-op correctly, does a discovery error
  // propagate the same way "list" already does), not about a specific
  // template-call or SQL-file-resolution rule the way those categories are.
  'model-compile': [
    testCompileResolvesRefWithoutExecuting,
    testCompileMoveNodeReportsPlannedWithNoCompiledSql,
    testCompileSurfacesDiscoveryErrorsSameAsList,
    testCompileManifestWrittenSeparatelyFromRunManifest,
    testCompileManifestDisabled,
    testManifestCompileManifestCollisionRefusesToWrite
  ],
  manifest: [
    testManifestDefaultOverwritesSameFile,
    testManifestFolderAndFileNameOverride,
    testManifestDisabled,
    testManifestReflectsMixedNodeStatuses,
    testManifestWriteFailureDoesNotThrow,
    testManifestNotWrittenOnList
  ],
  datatests: [
    testDataTestsRaiseBlocksDownstream,
    testDataTestsDiscardRowKeepsGoodRows,
    testDataTestsNotNullAndUnique,
    testDataTestsUnknownColumnThrows,
    testDataTestsPrototypeShapedCheckNameIsRejected,
    testDataTestsValidatedEvenWhenExtractIsEmpty,
    testDataTestsMinTreatsBlankAsMissingNotZero,
    testDataTestsInvalidRegexPatternThrowsClearly
  ],
  emptyguards: [
    testEmptyGuardSheets,
    testEmptyGuardDriveCsv,
    testEmptyGuardDriveXlsx
  ],
  regressions: [
    testExtractBigQueryEmptyResultIsEmpty,
    testEmptyBigQueryResultDoesNotTruncateTarget,
    testExtractSheetsBlankRangeIsEmpty,
    testAmbiguousSelectorThrows,
    testProtoNamedNodeOrdersCorrectly,
    testModelRefProtoNamedMoveNodeResolves,
    testSelectorTolerateSpaceAfterComma,
    testJsonEnvelopeReportsAClearError
  ],
  pipeline: [
    testPipelineChain,
    testRunEverything
  ]
};

// One flat name -> function index, built once from every TEST_CATEGORIES
// entry (a function's own .name already equals its declared name, so no
// separate string list to keep in sync). Lets runAllTests() below
// resolve individual test names, not just whole categories - see there.
var ALL_TESTS_BY_NAME = Object.keys(TEST_CATEGORIES).reduce(function (index, key) {
  TEST_CATEGORIES[key].forEach(function (test) { index[test.name] = test; });
  return index;
}, {});

// Runs every test() function across the js/tests-*.js files in one go, or -
// given a category name
// from TEST_CATEGORIES above - just that category. runAllTests('datatests')
// runs only the config.tests fixtures instead of clicking through them one
// by one (or the whole ~50-function suite); runAllTests() with no argument
// still runs everything.
//
// runAllTests('testA,testB') - a comma-separated list of individual test
// function names - runs exactly that set, spanning categories if needed.
// This exists because categories can be slow to wait through when only a
// handful of tests inside one are actually relevant (e.g. re-verifying
// what a single fix touched): 'extract'+'load' together is ~35 tests,
// most doing several sequential BigQuery API round trips each, plus a
// few slow Drive-xlsx tests (temp Google Sheet create/write/export/
// delete) that have nothing to do with a bigquery-only fix. Naming
// exactly the tests that matter skips everything else in their category.
//
// Logging is deliberately minimal here: QUIET_TESTS silences every
// per-assertion PASS/FAIL line and every test's own informational
// Logger.log while this runs, so the output is just a pass/fail count and,
// if anything failed, which test and why - not a transcript of ~50 tests'
// worth of steps. Once you know which one failed, run that test function
// by itself (QUIET_TESTS is false outside of runAllTests, and Logger.log
// is back to normal) to see its full detail. Wrapped in try/finally so
// both reset even if a test throws something runAllTests itself doesn't
// expect.
//
// QUIET_TESTS only covers this file's own check()/testLog() calls -
// NotSoBigData.cli() does its own per-node/per-command logging inside the
// library itself (see cli.js), on every single call, by design. This
// project has no hook into that, so the only way to silence it too is to
// swap out Logger.log itself for a no-op for the duration of the run, and
// put the real one back before logging the summary below.
function runAllTests(selector) {
  var tests;
  if (selector === undefined) {
    tests = Object.keys(TEST_CATEGORIES).reduce(function (all, key) {
      return all.concat(TEST_CATEGORIES[key]);
    }, []);
  } else if (typeof selector === 'string' && selector.indexOf(',') !== -1) {
    // A comma-separated list of individual test function names - same
    // convention cli()'s own --select/--exclude use for node names -
    // for an ad-hoc set that spans categories (e.g. "just the tests one
    // fix touched") without waiting through whole categories' worth of
    // unrelated Sheets/Drive/API tests riding along in the same
    // category. Category names never contain a comma, so this is
    // unambiguous against the branch below.
    tests = selector.split(',').map(function (name) {
      var trimmed = name.trim();
      if (!Object.prototype.hasOwnProperty.call(ALL_TESTS_BY_NAME, trimmed)) {
        throw new Error('runAllTests(): unknown test "' + trimmed + '" - check the spelling against the function name.');
      }
      return ALL_TESTS_BY_NAME[trimmed];
    });
  } else if (Object.prototype.hasOwnProperty.call(TEST_CATEGORIES, selector)) {
    tests = TEST_CATEGORIES[selector];
  } else {
    throw new Error('runAllTests(): unknown category "' + selector + '". Expected one of: ' +
      Object.keys(TEST_CATEGORIES).join(', ') + ', a comma-separated list of test names, or no argument to run everything.');
  }

  QUIET_TESTS = true;
  var realLog = Logger.log;
  Logger.log = function () {};
  var failures;
  try {
    failures = tests.reduce(function (failed, test) {
      try {
        test();
      } catch (e) {
        failed.push(test.name + ' - ' + e.message);
      }
      return failed;
    }, []);
  } finally {
    Logger.log = realLog;
    QUIET_TESTS = false;
  }

  Logger.log((tests.length - failures.length) + '/' + tests.length + ' passed' +
    (selector ? ' (' + selector + ')' : '') + '.');
  if (failures.length) {
    Logger.log('FAILED:');
    failures.forEach(function (failure) { Logger.log('  ' + failure); });
    Logger.log('Run the failed test function by itself to see its full detail.');
  }
}
