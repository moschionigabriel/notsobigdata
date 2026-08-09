// model - the "T" of ELT.
//
// A model is SQL, stored in an Apps Script .html file, read back at run
// time with HtmlService because .html is the only plain-text file Apps
// Script lets a project hold. Models reference each other dbt-style, with
// {{ ref('other_model') }} placeholders inside the SQL. Those refs *are*
// the dependency declaration: a model never writes its own dependsOn, and
// they get substituted with the real table identifier just before the
// SQL runs.
//
// A model's .html file can hold its SQL three ways, chosen by how many
// <script type="text/sql"> tags it contains - see extractModelSql() below:
//
//   - zero tags: the whole file is the SQL (nothing else in it to be).
//   - one tag: that tag's content is the SQL. It may carry an "id", but if
//     it does, the id must match the model name - same rule as the
//     several-tags case below, so a copy-pasted tag with a stale id fails
//     loudly instead of silently running under the wrong model.
//   - more than one tag: every model sharing that file gets its own
//     tagged block, and each tag needs an "id" matching a model name -
//     this is what makes "several small models in one .html file" work,
//     the way a single dbt project holds many .sql files.
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

// Guarded read of the single notsobigdataModels global, reusing cli.js's
// readOptionalGlobal() - same "never throw because of a global this
// library doesn't own" reasoning discoverNodes() applies to every other
// global. Absent entirely means "no models declared" and returns quietly,
// so a move-only project never notices this global exists. But once it
// *is* declared, its shape is this library's business - unlike an
// unrelated global that happens to exist, nobody else would coincidentally
// declare something named notsobigdataModels, so a malformed one (an
// array, a string, a models field that isn't itself a plain object) is a
// clear mistake worth failing loudly on rather than silently treating the
// same as "not declared at all". Only a specific model *entry* being
// malformed is deferred to resolveModelConfig below, once we know a
// caller actually wants that entry.
function readModelsRegistry() {
  var raw = readOptionalGlobal('notsobigdataModels');
  if (raw === undefined) {
    return { defaults: {}, models: {} };
  }
  if (!isPlainObject(raw)) {
    throw new Error('model(): notsobigdataModels must be an object - got ' + (Array.isArray(raw) ? 'an array' : typeof raw) + '.');
  }
  var defaults = {};
  MODEL_DEFAULT_KEYS.forEach(function (key) {
    if (raw[key] !== undefined) {
      defaults[key] = raw[key];
    }
  });
  var models = {};
  if (raw.models !== undefined) {
    if (!isPlainObject(raw.models)) {
      throw new Error('model(): notsobigdataModels.models must be an object - got ' + (Array.isArray(raw.models) ? 'an array' : typeof raw.models) + '.');
    }
    models = raw.models;
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
// registry is optional - a caller that hasn't already read the registry
// (there is no other one right now, but a future caller might) can omit
// it and get a fresh read. Both current callers already have one in hand
// (expandModelNodes() reads it once for every model it expands; model()
// reads it once for however many ref()s its own SQL contains) and pass it
// through, so resolving N models' configs never re-reads and re-validates
// the same global N times over.
//
// has() is cli.js's guard against a model named e.g. "toString" or
// "__proto__" testing as present in a plain {} it was never added to -
// the same risk cli.js's own node/kind lookups already guard against, so
// reused rather than re-implemented here.
function resolveModelConfig(name, registry) {
  registry = registry || readModelsRegistry();
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

// Reads one .html file's raw content. HtmlService reads a file that
// lives in the Apps Script project itself, unlike move.js's
// readDriveFileText (a Drive file, found by id) - models are project
// source, not a data source. Separate from extractModelSql() below so
// expandModelNodes() can read a shared file once and reuse it for every
// model whose sqlFile points at it, rather than re-fetching per model.
//
// createHtmlOutputFromFile() takes the file's name as registered in the
// project, which Google's own examples always give without the ".html"
// extension (e.g. HtmlService.createHtmlOutputFromFile('Dialog') for a
// file created as "Dialog.html") - sqlFile keeps its extension as a
// config value, since "a model's SQL file" reads more naturally that way
// and matches every fixture/example in this repo, but it's stripped here
// before the actual API call so this matches the documented contract
// rather than depending on any leniency the runtime may or may not have.
function readModelHtml(sqlFile) {
  var scriptFileName = sqlFile.replace(/\.html$/i, '');
  try {
    return HtmlService.createHtmlOutputFromFile(scriptFileName).getContent();
  } catch (error) {
    throw new Error('model(): could not read "' + sqlFile + '" - ' + error.message + '. Every model needs a matching .html file - see README.md\'s "The model kind" section.');
  }
}

// Finds every <script type="text/sql"> tag in a file's content, in
// whatever order its attributes appear (id before or after type). Each
// tag's "id" is null when the attribute is absent - only extractModelSql()
// below decides whether that's allowed, since that depends on how many
// tags the file has.
function extractSqlTags(html) {
  var tagPattern = /<script([^>]*)type=["']text\/sql["']([^>]*)>([\s\S]*?)<\/script>/gi;
  var idPattern = /\bid=["']([^"']*)["']/i;
  var tags = [];
  var match;
  while ((match = tagPattern.exec(html))) {
    var idMatch = idPattern.exec(match[1] + match[2]);
    tags.push({ id: idMatch ? idMatch[1] : null, sql: match[3] });
  }
  return tags;
}

// Picks the right SQL out of an already-read .html file for one named
// model - see the module comment above for the three tag-count cases.
// Takes the file's content rather than reading it itself, so a caller
// (expandModelNodes() below) can read a shared file once and call this
// once per model that points at it.
function extractModelSql(html, sqlFile, modelName) {
  var tags = extractSqlTags(html);
  if (tags.length === 0) {
    return html.trim();
  }
  if (tags.length === 1) {
    var tag = tags[0];
    if (tag.id && tag.id !== modelName) {
      throw new Error('model(): "' + sqlFile + '" has one <script type="text/sql"> tag with id "' + tag.id + '", which does not match model "' + modelName + '".');
    }
    return tag.sql.trim();
  }
  var missingId = tags.some(function (candidate) { return !candidate.id; });
  if (missingId) {
    throw new Error('model(): "' + sqlFile + '" has more than one <script type="text/sql"> tag, so each one needs an "id" attribute matching a model name - found one without an id.');
  }
  var matches = tags.filter(function (candidate) { return candidate.id === modelName; });
  if (!matches.length) {
    throw new Error('model(): "' + sqlFile + '" has no <script type="text/sql" id="' + modelName + '"> tag. Ids found: ' + tags.map(function (candidate) { return candidate.id; }).join(', ') + '.');
  }
  if (matches.length > 1) {
    throw new Error('model(): "' + sqlFile + '" has more than one <script type="text/sql" id="' + modelName + '"> tag - ids must be unique within a file.');
  }
  return matches[0].sql.trim();
}

// The dependency-derivation hook: a model's ref() calls *are* its edges,
// so dependsOn is read out of the SQL instead of being hand-written. Scans
// stripSqlComments()'s output (move.js's own comment-stripping, reused
// rather than re-implemented) rather than the raw SQL, so a ref() a user
// has commented out (e.g. "-- from {{ ref('old_model') }}") doesn't become
// a real dependency edge on a model that may not even exist any more.
function extractRefDependencies(sql) {
  return scanTemplateExpressions(stripSqlComments(sql))
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
  var compiled = sql.replace(templateExpressionPattern(), function (raw, call, args) {
    if (call !== 'ref') {
      throw new Error('model(): unsupported template call "' + call + '(...)" in SQL - only ref() is implemented so far.');
    }
    return resolveRef(parseSingleStringArgument('ref', args));
  });
  // templateExpressionPattern()'s args group is [^)]* - it can't match a
  // call containing its own ")" (e.g. a ref() argument with a stray
  // paren, or a macro call nesting another call), so that span is skipped
  // over entirely rather than reaching the "unsupported call" check above.
  // Left alone, that malformed placeholder would ship to BigQuery as
  // literal, unsubstituted "{{ ... }}" text instead of being rejected -
  // exactly the failure mode the module comment above says the generic
  // scanner exists to avoid.
  if (compiled.indexOf('{{') !== -1) {
    throw new Error('model(): SQL still contains "{{" after substitution - check for a malformed template call (e.g. unbalanced parentheses inside {{ ref(...) }}).');
  }
  return compiled;
}

// Builds config.name's fully-qualified relation, reusing move.js's own
// qualifiedTableRef() for the actual backtick-quoting so a model's
// relation and a bigquery source/test's table reference are spelled the
// same way by construction. ['projectId', 'dataset'] loops rather than two
// near-identical if/throw blocks, since both checks are the same shape
// and only differ in which key and word they name.
function qualifiedRelation(config) {
  ['projectId', 'dataset'].forEach(function (key) {
    if (!config[key]) {
      throw new Error('model(): "' + config.name + '" is missing "' + key + '" - set it on notsobigdataModels or on this model entry.');
    }
  });
  return qualifiedTableRef(config.projectId, config.dataset, config.name);
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
//
// Stashes the SQL it had to read anyway (to derive dependsOn) onto the
// node's config, so model() below - which runs later, once this node's
// turn comes up in cli()'s run loop - reuses it instead of asking
// HtmlService for the same file a second time.
//
// htmlCache is scoped to this one call, keyed by sqlFile: several models
// can now share one file (see the module comment above), so without this
// a shared file would be re-read from HtmlService once per model instead
// of once total. Caches a read failure too (as { error }), not just a
// success - several models can share one broken file just as easily as a
// working one, and without this every one of them would retry the same
// doomed HtmlService call. Reuses cli.js's has()/emptyMap()
// prototype-pollution guards for the same reason readModelsRegistry()
// does - sqlFile is a caller-chosen string, same risk class as a node or
// model name.
//
// One model's own config/file/tag problem must not take down discovery
// for every other node in the project - move nodes included, since this
// is folded into the same discoverNodes() scan they come from. Each
// model's own try/catch below is what makes that true: a bad sqlFile,
// mismatched tag id, or duplicate id becomes that one node's
// config.expandError (thrown by model() below, once this node's turn
// comes up in the run loop) instead of an exception that unwinds
// discoverNodes() itself and hides every node, of any kind, from
// cli("hello")/cli("list")/cli("run --select ...") alike. A malformed
// notsobigdataModels/registry.models shape is deliberately not covered
// here - readModelsRegistry() above still throws for that, since it's a
// mistake in the one shared config every model reads, not one model's own
// problem.
function expandModelNodes() {
  var registry = readModelsRegistry();
  var htmlCache = emptyMap();
  function readCached(sqlFile) {
    if (!has(htmlCache, sqlFile)) {
      try {
        htmlCache[sqlFile] = { content: readModelHtml(sqlFile) };
      } catch (error) {
        htmlCache[sqlFile] = { error: error.message };
      }
    }
    return htmlCache[sqlFile];
  }
  return Object.keys(registry.models).map(function (name) {
    var node = {
      name: name,
      kind: 'model',
      variable: 'notsobigdataModels.models.' + name,
      config: { name: name },
      dependsOn: []
    };
    try {
      var config = resolveModelConfig(name, registry);
      var cached = readCached(config.sqlFile);
      if (cached.error) {
        throw new Error(cached.error);
      }
      config.sql = extractModelSql(cached.content, config.sqlFile, name);
      node.config = config;
      node.dependsOn = extractRefDependencies(config.sql);
    } catch (error) {
      node.config = { name: name, expandError: error.message };
    }
    return node;
  });
}

// The EXECUTORS.model entry: compiles the model's SQL (substituting every
// ref()) and materializes it as a view or table. Deliberately does not
// call move.js's assertReadOnlySelect - that guard exists to keep move()
// read-only, and a model's whole job is writing. It does reuse
// assertSingleStatement, move.js's other SQL-shape guard: a model can
// write, but a stray ";" splitting its SQL into more than one statement
// is a mistake either way, not a second statement this library intends
// to run.
//
// config.sql is set by expandModelNodes() above whenever that node's own
// discovery succeeded - every model node comes from there (discoverNodes()
// rejects a hand-declared kind: 'model' var, see cli.js). When it didn't
// succeed, expandModelNodes() stashes the reason as config.expandError
// instead, so this node reports "failed" (and blocks its own dependents,
// same as any other failure - see cli.js's runNodes()) rather than
// crashing config.sql's read below with a confusing "undefined" error.
function model(config) {
  if (config.expandError) {
    throw new Error(config.expandError);
  }
  var sql = config.sql;
  assertSingleStatement(sql, 'model(): "' + config.name + '"');
  var registry = readModelsRegistry();
  var compiled = compileModelSql(sql, function (refName) {
    return qualifiedRelation(resolveModelConfig(refName, registry));
  });
  var relation = qualifiedRelation(config);
  var materialized = resolveMaterialized(config);
  var statement = 'CREATE OR REPLACE ' + materialized.toUpperCase() + ' ' + relation + ' AS\n' + compiled;
  runBigQueryQueryJob({ query: statement, useLegacySql: false }, config.projectId);
  return { relation: relation, materialized: materialized };
}
