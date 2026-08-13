// 02-fixtures-custom-connectors.js — Plain functions passed as source.fn/target.fn to the custom connector
// fixtures in this project.

// ===================================================================
// Custom source/target functions
//
// These are plain functions in this project, passed to a node config as a
// direct reference. cli()'s global scan finds *config objects* and never
// calls anything it discovers - executable code only enters the library
// this way, as a reference you handed it yourself.
// ===================================================================

function myCustomExtract(source) {
  return [['col1', 'col2'], ['a', 1], ['b', 2]];
}

function myCustomExtractEmpty(source) {
  return [];
}

function myCustomExtractBadShape(source) {
  return ['not', 'a', '2d', 'array'];
}

function myCustomLoad(rows, target) {
  testLog('myCustomLoad received ' + rows.length + ' rows; first row: ' + rows[0]);
  return 'custom-load-wrote-' + rows.length + '-rows';
}

// Note there's no "custom source wrapping extractPaginated" example here:
// extractPaginated (and everything else in move.js) lives inside the
// library's own IIFE and is private to it - cli.js's IIFE returns only
// { cli: cli }. A custom source needing to page through a native Advanced
// Service call (YouTube.Search.list() and friends) has to walk its own
// pages by hand; see README.md's api source section.

// One row (status "not_a_real_status") violates an accepted_values test -
// used by both the "raise" and "discard_row" data-tests fixtures below.
function myCustomExtractForDataTests(source) {
  return [
    ['order_id', 'status'],
    ['1', 'open'],
    ['2', 'not_a_real_status'],
    ['3', 'closed']
  ];
}

// A duplicate order_id ("1" twice) and a blank one, for the unique/not_null
// data-tests fixture below.
function myCustomExtractForUniquenessTest(source) {
  return [['order_id'], ['1'], ['1'], ['']];
}

// Base (a, b) then evolved (a, b, c) rows for the schema-evolution
// fixtures below - a real Drive/Sheets source wouldn't usually change
// shape between runs, so this fakes that with two fixed custom extracts
// instead of hand-editing a live fixture file between test runs.
function myCustomExtractSchemaEvolutionBase(source) {
  return [['a', 'b'], ['1', 'x'], ['2', 'y']];
}

function myCustomExtractSchemaEvolutionEvolved(source) {
  return [['a', 'b', 'c'], ['3', 'z', 'new']];
}

// Fixtures for the target.sqlTests staging feature: a small "reference"
// table (two known customer ids) plus two orders batches - one whose
// customer_id values all exist in the reference table (passes the
// referential-integrity sqlTests check below) and one with a "999" that
// doesn't (fails it).
function myCustomExtractSqlTestCustomers(source) {
  return [['customer_id'], ['1'], ['2']];
}

function myCustomExtractSqlTestOrdersValid(source) {
  return [['order_id', 'customer_id'], ['100', '1'], ['101', '2']];
}

function myCustomExtractSqlTestOrdersOrphan(source) {
  return [['order_id', 'customer_id'], ['200', '1'], ['201', '999']];
}

// Same valid customer_ids as myCustomExtractSqlTestOrdersValid, but with
// an extra "region" column the destination table doesn't have yet -
// combined with target.allowSchemaEvolution below, this is the one
// interaction release/7's independent review flagged as never actually
// run: does a promotion copy job (not a load job) really accept
// schemaUpdateOptions the same way?
function myCustomExtractSqlTestOrdersValidWithNewColumn(source) {
  return [['order_id', 'customer_id', 'region'], ['300', '1', 'us'], ['301', '2', 'eu']];
}
