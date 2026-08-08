// model - the "T" of ELT.
//
// A model is SQL, stored in an Apps Script .html file - one <script
// type="text/sql"> tag, read back at run time with HtmlService, because
// .html is the only plain-text file Apps Script lets a project hold.
// Models reference each other dbt-style, with {{ ref('other_model') }}
// placeholders inside the SQL. Those refs *are* the dependency
// declaration: a model never writes its own dependsOn, and they get
// substituted with the real table identifier just before the SQL runs.
//
// Every model is declared once, as an entry in a single shared registry -
// not as its own top-level "var" the way a move node is:
//
//   var notsobigdataModels = {
//     projectId: 'my-project', dataset: 'analytics', materialized: 'view',
//     models: {
//       stg_orders: { sqlFile: 'stg_orders.html' },
//       orders_summary: { sqlFile: 'orders_summary.html', materialized: 'table' }
//     }
//   };
//
// projectId/dataset/materialized at the top level are project-wide
// defaults; anything a model entry sets itself overrides them. sqlFile
// defaults to "<model name>.html" when omitted, same spirit as a node's
// own name defaulting from its variable elsewhere in this library.
//
// This is a deliberately different discovery shape than move's "every
// node is its own var": with dozens of models, N boilerplate top-level
// vars just to register them is worse than one object naming them all.
// The cost is that cli.js's discoverNodes() - which normally finds nodes
// by scanning the global scope for a "kind" key - cannot find these at
// all, since notsobigdataModels itself carries no "kind". expandModelNodes()
// below is the hook that makes up the difference: it turns the one
// registry into N fully-formed nodes, and discoverNodes() folds its
// output straight into the same list the var-scan produces. Selection,
// ordering and the run loop never learn the difference.

// Every {{ ... }} placeholder this library understands is a call with one
// string argument - {{ ref('other_model') }} today. Written as a generic
// scan-and-dispatch rather than a ref()-only regex, because more
// Jinja-like calls (starting with config(), most likely) are expected
// later: growing the dispatch in compileModelSql() below should be an
// added case, not a rewrite of the scanner.
//
// Matches the call *shape* only - name plus whatever sits between its
// parens - deliberately not the "exactly one quoted string" shape ref()
// itself requires. Matching that narrowly here would let a call this
// library doesn't recognize (a no-arg {{ macro() }}, a kwarg-style
// {{ config(materialized='table') }}) fail to match at all and pass
// through as literal, unsubstituted text instead of being rejected by the
// "unsupported template call" check in compileModelSql() below - which
// defeats the point of that check. parseSingleStringArgument() below
// enforces ref()'s own stricter shape once a call is known to be ref().
function templateExpressionPattern() {
  return /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]*)\)\s*\}\}/g;
}

function scanTemplateExpressions(sql) {
  var pattern = templateExpressionPattern();
  var matches = [];
  var match;
  while ((match = pattern.exec(sql))) {
    matches.push({ raw: match[0], call: match[1], args: match[2] });
  }
  return matches;
}

// The only argument shape ref() accepts: exactly one quoted string, no
// more. Called after a call is already known to be "ref" (extractRefDependencies,
// compileModelSql), so a ref() with no argument, two arguments, or an
// unquoted name is a clear error rather than silently matching nothing.
function parseSingleStringArgument(call, args) {
  var match = /^\s*(['"])([^'"]*)\1\s*$/.exec(args);
  if (!match) {
    throw new Error('model(): "' + call + '(' + args + ')" is not a valid call - ' + call + '() takes exactly one quoted name, e.g. ' + call + '(\'model_name\').');
  }
  return match[2];
}

// The keys a model entry or the registry's top level may set as a
// materialization default. Kept as an explicit list rather than copying
// every key on notsobigdataModels, so an unrelated key a user attaches to
// the registry (notes, a comment, anything) never leaks into a model's
// resolved config.
var MODEL_DEFAULT_KEYS = ['projectId', 'dataset', 'materialized'];

// Guarded read of the single notsobigdataModels global, same "never throw
// because of a global this library doesn't own" pattern discoverNodes()
// uses for every other global. Absent or malformed just means "no models
// declared" - only a specific model *entry* being malformed is this
// library's business, and that's checked in resolveModelConfig below,
// once we know a caller actually wants that entry.
function readModelsRegistry() {
  var raw;
  try {
    raw = globalThis.notsobigdataModels;
  } catch (error) {
    raw = undefined;
  }
  var defaults = {};
  var models = {};
  if (raw && typeof raw === 'object') {
    MODEL_DEFAULT_KEYS.forEach(function (key) {
      if (raw[key] !== undefined) {
        defaults[key] = raw[key];
      }
    });
    if (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
      models = raw.models;
    }
  }
  return { defaults: defaults, models: models };
}

// Merges the registry's defaults with one model's own entry (the entry
// wins on any key both set) and resolves sqlFile's naming-convention
// default. Reused for two different callers: expandModelNodes() below
// resolves a model's *own* config, and compileModelSql()'s ref() handler
// resolves what a ref() *points at* - both need "here is everything known
// about model X", and an unknown model name has to be an error either way
// (never substitute a name that didn't resolve to a real entry - see the
// model() executor below).
//
// has() is cli.js's guard against a model named e.g. "toString" or
// "__proto__" testing as present in a plain {} it was never added to -
// the same risk cli.js's own node/kind lookups already guard against, so
// reused rather than re-implemented here.
function resolveModelConfig(name) {
  var registry = readModelsRegistry();
  if (!has(registry.models, name)) {
    throw new Error('model(): "' + name + '" is not declared in notsobigdataModels.models. Known models: ' + Object.keys(registry.models).join(', ') + '.');
  }
  var entry = registry.models[name];
  if (!entry || typeof entry !== 'object') {
    throw new Error('model(): notsobigdataModels.models["' + name + '"] must be an object - got ' + typeof entry + '.');
  }
  var config = {};
  Object.keys(registry.defaults).forEach(function (key) { config[key] = registry.defaults[key]; });
  Object.keys(entry).forEach(function (key) { config[key] = entry[key]; });
  config.name = name;
  if (!config.sqlFile) {
    config.sqlFile = name + '.html';
  }
  return config;
}

// Reads one model's SQL out of its .html file. HtmlService reads a file
// that lives in the Apps Script project itself, unlike move.js's
// readDriveFileText (a Drive file, found by id) - models are project
// source, not a data source.
function readModelSql(sqlFile) {
  var html;
  try {
    html = HtmlService.createHtmlOutputFromFile(sqlFile).getContent();
  } catch (error) {
    throw new Error('model(): could not read "' + sqlFile + '" - ' + error.message + '. Every model needs a matching .html file with a <script type="text/sql"> tag - see README.md\'s "The model kind" section.');
  }
  var match = /<script[^>]*type=["']text\/sql["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) {
    throw new Error('model(): "' + sqlFile + '" has no <script type="text/sql"> tag.');
  }
  return match[1].trim();
}

// The dependency-derivation hook: a model's ref() calls *are* its edges,
// so dependsOn is read out of the SQL instead of being hand-written.
function extractRefDependencies(sql) {
  return scanTemplateExpressions(sql)
    .filter(function (expression) { return expression.call === 'ref'; })
    .map(function (expression) { return parseSingleStringArgument('ref', expression.args); });
}

// Substitutes every {{ ref('x') }} with x's resolved, backtick-quoted
// relation - same quoting convention move.js's resolveBigQuerySql already
// uses for an interpolated table identifier. resolveRef is expected to
// throw on an unknown name (resolveModelConfig does), which this function
// deliberately does not catch: ref substitution is string interpolation
// into SQL that runs with the script owner's live BigQuery credentials,
// so an unresolved name must stop the run, never fall through as literal
// text. Any *other* template call is rejected the same way, for the same
// reason - see the module comment above about growing this later.
function compileModelSql(sql, resolveRef) {
  return sql.replace(templateExpressionPattern(), function (raw, call, args) {
    if (call !== 'ref') {
      throw new Error('model(): unsupported template call "' + call + '(...)" in SQL - only ref() is implemented so far.');
    }
    return resolveRef(parseSingleStringArgument('ref', args));
  });
}

function qualifiedRelation(config) {
  if (!config.projectId) {
    throw new Error('model(): "' + config.name + '" is missing "projectId" - set it on notsobigdataModels or on this model entry.');
  }
  if (!config.dataset) {
    throw new Error('model(): "' + config.name + '" is missing "dataset" - set it on notsobigdataModels or on this model entry.');
  }
  return '`' + config.projectId + '.' + config.dataset + '.' + config.name + '`';
}

// view/table only - incremental (dbt's third materialization) is v2, same
// deferral as column-level tests.
function resolveMaterialized(config) {
  var materialized = config.materialized || 'view';
  if (materialized !== 'view' && materialized !== 'table') {
    throw new Error('model(): "' + config.name + '" has materialized "' + materialized + '" - expected "view" or "table" (incremental is not implemented yet).');
  }
  return materialized;
}

// cli.js's discoverNodes() calls this once, after its own var-scan, and
// folds the result into the same node list - see the module comment above
// for why models need this instead of being found by that scan directly.
// Absent notsobigdataModels means "no models declared", not an error:
// this returns [] and a move-only project never notices model.js exists.
function expandModelNodes() {
  var registry = readModelsRegistry();
  return Object.keys(registry.models).map(function (name) {
    var config = resolveModelConfig(name);
    var sql = readModelSql(config.sqlFile);
    return {
      name: name,
      kind: 'model',
      variable: 'notsobigdataModels.models.' + name,
      config: config,
      dependsOn: extractRefDependencies(sql)
    };
  });
}

// The EXECUTORS.model entry: compiles the model's SQL (substituting every
// ref()) and materializes it as a view or table. Deliberately does not
// call move.js's assertReadOnlySelect - that guard exists to keep move()
// read-only, and a model's whole job is writing.
function model(config) {
  var sql = readModelSql(config.sqlFile);
  var compiled = compileModelSql(sql, function (refName) {
    return qualifiedRelation(resolveModelConfig(refName));
  });
  var relation = qualifiedRelation(config);
  var materialized = resolveMaterialized(config);
  var statement = 'CREATE OR REPLACE ' + materialized.toUpperCase() + ' ' + relation + ' AS\n' + compiled;
  runBigQueryQueryJob({ query: statement, useLegacySql: false }, config.projectId);
  return { relation: relation, materialized: materialized };
}
