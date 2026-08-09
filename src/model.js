// model - the "T" of ELT.
//
// A model is SQL, stored in an Apps Script .html file, read back at run
// time with HtmlService because .html is the only plain-text file Apps
// Script lets a project hold. Models reference each other dbt-style, with
// {{ ref('other_model') }} placeholders inside the SQL. Those refs *are*
// the model-to-model dependency declaration - a model never hand-writes
// dependsOn for another *model*, and refs get substituted with the real
// table identifier just before the SQL runs. A model can still have its
// own hand-written dependsOn for a non-model (move) dependency ref()
// can't reach - see MODEL_DEFAULT_KEYS and mergeDependsOn() below, and
// docs/model.md's "Depending on a move node" for the user-facing version.
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

// Every {{ ... }} placeholder this library understands is a call - either
// ref()'s one positional string argument, config()'s kwarg-style
// key='value' arguments, or var()'s one-or-two positional string arguments
// (see parseSingleStringArgument, parseKwargsArgument and
// parseVarArguments below). Written as a generic scan-and-dispatch rather
// than a ref()-only regex, since more calls beyond the first were always
// expected: growing the dispatch in compileModelSql() below should stay an
// added case, not a rewrite of the scanner.
//
// {% set key = 'value' %} is deliberately a different bracket shape
// ({% %}, not {{ }}) - see setStatementPattern()/bareVarPattern() below -
// because it is a real Jinja *statement* (it defines a name, it doesn't
// evaluate to a substituted value itself), unlike every call this pattern
// matches, which stands in for the value it evaluates to.
//
// Matches the call *shape* only - name plus whatever sits between its
// parens - deliberately not either call's own stricter argument shape.
// Matching narrowly here would let a call this library doesn't recognize
// (a no-arg {{ macro() }}, some other kwarg-style call) fail to match at
// all and pass through as literal, unsubstituted text instead of being
// rejected by the "unsupported template call" check in compileModelSql()
// below - which defeats the point of that check. parseSingleStringArgument(),
// parseKwargsArgument() and parseVarArguments() below enforce each call's
// own stricter shape once a call is already known by name.
function templateExpressionPattern() {
  return /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]*)\)\s*\}\}/g;
}

// {% set key = 'value' %} - a real Jinja *statement*, not a {{ }} call:
// defines a name, scoped to this one model's SQL, read back later as a
// bare {{ key }} reference (see bareVarPattern() below) rather than
// through a var() wrapper. Deliberately a single-line, single
// string-literal assignment - not the general "any Jinja expression on
// the right-hand side" a real {% set %} allows - matching every other
// value in this file being string-only text substitution, not a real
// expression evaluator. A multi-line {% set %} block (the
// {% set x %}...{% endset %} form) is a different, larger construct and
// isn't implemented.
function setStatementPattern() {
  return /\{%\s*set\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(['"])([^'"]*)\2\s*%\}/g;
}

// A bare {{ key }} reference - no parens, so it can never collide with
// templateExpressionPattern()'s call shape above - reading back a value a
// {% set %} statement defined earlier in the same SQL. Scoped narrowly to
// what {% set %} needs; this is not a general "evaluate any Jinja
// expression" mechanism.
function bareVarPattern() {
  return /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
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

// var()'s own argument shape: one quoted name, and an optional second
// quoted default - e.g. var('region') or var('region', 'US'). Separate
// from parseSingleStringArgument (ref() takes exactly one, always
// required) and parseKwargsArgument (config()'s key='value' pairs) because
// var() is positional but optionally two-argument - neither existing
// parser's shape fits. Deliberately string-only, same posture as every
// other value in this file.
function parseVarArguments(call, args) {
  var match = /^\s*(['"])([^'"]*)\1(?:\s*,\s*(['"])([^'"]*)\3)?\s*$/.exec(args);
  if (!match) {
    throw new Error('model(): "' + call + '(' + args + ')" is not a valid call - ' + call + '() takes a quoted name and an optional quoted default, e.g. ' + call + '(\'region\') or ' + call + '(\'region\', \'US\').');
  }
  return { name: match[2], hasDefault: match[3] !== undefined, defaultValue: match[4] };
}

// The kwarg-style argument shape config() uses: one or more
// comma-separated key='value' pairs, each value a quoted string - e.g.
// config(materialized='table'). Splits on top-level commas first, then
// matches each segment against a single key='value' pattern, so a bad
// segment (missing quotes, no "=", an empty key) names exactly which one
// is wrong rather than failing on the whole argument list at once.
// Deliberately string-only, same posture parseSingleStringArgument takes
// for ref() - config()'s only key so far (materialized) is itself a
// closed enum ('view'/'table'), so it doesn't need numbers/booleans/nested
// values yet, and adding them later is an easy extension of this same
// function rather than a redesign.
//
// Comma-splitting is naive - a value containing a literal "," would be cut
// in half - which is fine today (no config() value needs one) but would
// need a real scanner if a future key's value legitimately contains a
// comma.
function parseKwargsArgument(call, args) {
  var trimmed = args.trim();
  if (!trimmed) {
    throw new Error('model(): "' + call + '()" needs at least one key=\'value\' argument.');
  }
  var kwargPattern = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(['"])([^'"]*)\2$/;
  var result = {};
  trimmed.split(',').forEach(function (segment) {
    var match = kwargPattern.exec(segment.trim());
    if (!match) {
      throw new Error('model(): "' + call + '(' + args + ')" is not a valid call - every argument must be key=\'value\', e.g. ' + call + '(materialized=\'table\').');
    }
    var key = match[1];
    if (has(result, key)) {
      throw new Error('model(): "' + call + '(' + args + ')" sets "' + key + '" more than once.');
    }
    result[key] = match[3];
  });
  return result;
}

// The keys a model entry or the registry's top level may set as a
// default. Kept as an explicit list rather than copying every key on
// notsobigdataModels, so an unrelated key a user attaches to the registry
// (notes, a comment, anything) never leaks into a model's resolved
// config. dependsOn joins this list for the same reason a project-wide
// materialized default is useful - a registry-wide "every model waits on
// this" is a real shape (e.g. a shared staging load) - and it gets the
// override behavior below (an entry's own dependsOn replaces the
// registry's, not merges with it) for free, the same way materialized
// already does. (Union-with-ref() semantics - dependsOn can never
// suppress a real ref() - are enforced separately in mergeDependsOn()
// below, not by this override.)
var MODEL_DEFAULT_KEYS = ['projectId', 'dataset', 'materialized', 'dependsOn'];

// The keys a {{ config(...) }} call inside a model's own SQL may set - see
// extractConfigOverrides below. Kept separate from MODEL_DEFAULT_KEYS (even
// though "materialized" is the only member of both lists today) since the
// two lists answer different questions and may diverge: MODEL_DEFAULT_KEYS
// is "what the registry may set as a default", this is "what the SQL file
// itself may override inline" - projectId/dataset/dependsOn are registry
// routing concerns a model's own SQL has no business changing, even once a
// second config()-settable key beyond materialized eventually shows up.
var MODEL_CONFIG_KEYS = ['materialized'];

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
    return { defaults: {}, models: {}, vars: {} };
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
  var vars = {};
  if (raw.vars !== undefined) {
    if (!isPlainObject(raw.vars)) {
      throw new Error('model(): notsobigdataModels.vars must be an object - got ' + (Array.isArray(raw.vars) ? 'an array' : typeof raw.vars) + '.');
    }
    Object.keys(raw.vars).forEach(function (key) {
      if (typeof raw.vars[key] !== 'string') {
        throw new Error('model(): notsobigdataModels.vars.' + key + ' must be a string - got ' + typeof raw.vars[key] + '.');
      }
    });
    vars = raw.vars;
  }
  return { defaults: defaults, models: models, vars: vars };
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

// The dependency-derivation hook: a model's ref() calls *are* its edges to
// other models, so a model-to-model dependency is read out of the SQL
// instead of being hand-written - see mergeDependsOn() below for the one
// other source of edges a model can have (a hand-written dependsOn,
// naming a non-model node the SQL has no way to ref()). Scans
// stripSqlComments()'s output (move.js's own comment-stripping, reused
// rather than re-implemented) rather than the raw SQL, so a ref() a user
// has commented out (e.g. "-- from {{ ref('old_model') }}") doesn't become
// a real dependency edge on a model that may not even exist any more.
function extractRefDependencies(sql) {
  return scanTemplateExpressions(stripSqlComments(sql))
    .filter(function (expression) { return expression.call === 'ref'; })
    .map(function (expression) { return parseSingleStringArgument('ref', expression.args); });
}

// The config()-override-derivation hook, mirroring extractRefDependencies
// above: a model's own {{ config(...) }} call (if any) sets values that win
// over both the registry's project-wide defaults and the model's own
// registry entry - the same "closest to the model wins" relationship dbt's
// own inline config() has with dbt_project.yml. Scans stripSqlComments()'s
// output for the same reason ref()'s scan does - a commented-out config()
// call must not take effect.
//
// At most one config() call is allowed per model - unlike ref(), which is
// expected to appear once per dependency, a second config() call setting
// (or re-setting) the same or different keys has no obvious precedence
// rule, so it's rejected outright rather than guessed at (last-wins,
// first-wins, or a per-key merge would each be a silent, surprising choice
// for whichever one wasn't picked).
//
// Every key returned is already validated against MODEL_CONFIG_KEYS here,
// at discovery time, so expandModelNodes() below can merge the result
// straight into a model's resolved config without a second whitelist check.
function extractConfigOverrides(sql) {
  var calls = scanTemplateExpressions(stripSqlComments(sql))
    .filter(function (expression) { return expression.call === 'config'; });
  if (!calls.length) {
    return {};
  }
  if (calls.length > 1) {
    throw new Error('model(): SQL has ' + calls.length + ' {{ config(...) }} calls - at most one is allowed per model.');
  }
  var overrides = parseKwargsArgument('config', calls[0].args);
  Object.keys(overrides).forEach(function (key) {
    if (MODEL_CONFIG_KEYS.indexOf(key) === -1) {
      throw new Error('model(): config() set "' + key + '", which is not a supported key. Supported: ' + MODEL_CONFIG_KEYS.join(', ') + '.');
    }
  });
  return overrides;
}

// {% set %}: a model's own SQL can define one or more named string values
// with {% set key = 'value' %} and read them back elsewhere in the *same*
// file as a bare {{ key }} reference - a real Jinja statement, not a
// {{ }} call standing in for one (see setStatementPattern()/
// bareVarPattern() above), so it needs its own extraction/validation pair
// rather than reusing scanTemplateExpressions(). File-local by design -
// the value only exists to avoid repeating a literal twice in one query
// (e.g. the same threshold in a WHERE and a HAVING), not to parameterize a
// model from outside its own SQL. That's a different job from var() below,
// which is project-level - the two used to be conflated into one
// set()/var() pair (var() reading back whatever set() had just defined),
// which was a mistake: real dbt's var() has nothing to do with {% set %}
// at all, it reads a value from outside the model entirely. See
// src/model.md's "set()/var() corrected to match real dbt/Jinja" note for
// the fuller story.
//
// extractSetStatements() is the single source of truth both
// validateSetUsage() (discovery, below) and compileModelSql() (run time)
// call - scans stripSqlComments()'s output, same reasoning
// extractRefDependencies() and extractConfigOverrides() already give: a
// commented-out {% set %} must not define a usable value. Multiple
// {% set %} statements are allowed (one per name) - only the same name
// being set twice is rejected, the same "no obvious precedence" reasoning
// config()'s at-most-one-call rule exists for.
function extractSetStatements(sql) {
  var pattern = setStatementPattern();
  var stripped = stripSqlComments(sql);
  var values = {};
  var match;
  while ((match = pattern.exec(stripped))) {
    var key = match[1];
    if (has(values, key)) {
      throw new Error('model(): "' + key + '" is set by more than one {% set %} statement in this SQL.');
    }
    values[key] = match[3];
  }
  return values;
}

// The discovery-time check for bare {{ key }} references: every one in the
// file must resolve against extractSetStatements()'s map, or it's a
// reference to a name that was never {% set %}. Same "fail loud at
// validation time, not two calls later" posture as validateModelTests()
// and extractConfigOverrides()'s key whitelist. Called from
// expandModelNodes()'s existing per-model try/catch, so a bad reference
// becomes that model's own discoveryError, caught by cli('list') before
// any real run.
function validateSetUsage(sql, messagePrefix) {
  var values = extractSetStatements(sql);
  var pattern = bareVarPattern();
  var stripped = stripSqlComments(sql);
  var match;
  while ((match = pattern.exec(stripped))) {
    var name = match[1];
    if (!has(values, name)) {
      throw new Error(messagePrefix + ' {{ ' + name + ' }} references "' + name + '", which is never set via {% set ' + name + ' = ... %} in this SQL.');
    }
  }
}

// var(): real dbt semantics, not this library's own invention - reads a
// project-level value from notsobigdataModels.vars (the model-SQL
// equivalent of dbt_project.yml's vars: section), with an optional second
// argument as a default when the key isn't set there. Deliberately has no
// relationship to {% set %} above (a real dbt model's {% set %} value is
// never read back through var() either - it's referenced by bare name).
//
// Both validateVarUsage() (discovery, below) and resolveVar() (run time,
// called from compileModelSql()) share this one resolution rule, so a
// var() that will fail at run time is already caught at discovery instead.
function resolveVar(registry, name, hasDefault, defaultValue) {
  if (has(registry.vars, name)) {
    return registry.vars[name];
  }
  if (hasDefault) {
    return defaultValue;
  }
  throw new Error('model(): {{ var(\'' + name + '\') }} references "' + name + '", which is not set in notsobigdataModels.vars and has no default.');
}

// The var()-side of discovery-time validation: every {{ var(...) }} call
// must resolve - either notsobigdataModels.vars has the key, or the call
// supplies its own default - same "fail loud at validation time, not two
// calls later" posture validateSetUsage() takes for bare {{ key }}
// references. Same resolution rule as resolveVar() above, duplicated
// rather than shared so this can embed messagePrefix the same way every
// other discovery-time validate* function in this file does - resolveVar()
// itself is also called at run time (from compileModelSql()), where no
// per-model prefix is available. Called from expandModelNodes()'s existing
// per-model try/catch, so a bad var() becomes that model's own
// discoveryError, caught by cli('list') before any real run.
function validateVarUsage(sql, registry, messagePrefix) {
  scanTemplateExpressions(stripSqlComments(sql))
    .filter(function (expression) { return expression.call === 'var'; })
    .forEach(function (expression) {
      var parsed = parseVarArguments('var', expression.args);
      if (!parsed.hasDefault && !has(registry.vars, parsed.name)) {
        throw new Error(messagePrefix + ' {{ var(\'' + parsed.name + '\') }} references "' + parsed.name + '", which is not set in notsobigdataModels.vars and has no default.');
      }
    });
}

// Unions a model's {{ ref() }}-derived edges with its hand-written
// dependsOn (see MODEL_DEFAULT_KEYS above for where that value comes
// from - a model entry's own dependsOn, or the registry's project-wide
// default), preserving first-seen order and dropping duplicates. The
// union is deliberate, not a merge choice made lightly: dependsOn is for
// naming a node ref() cannot reach (a move node, by convention - see
// docs/model.md), and must never be able to suppress an edge the SQL
// itself already declares via a real ref(). Reuses cli.js's
// emptyMap()/has() rather than Array#indexOf, same prototype-pollution
// reasoning as every other name-keyed lookup in this library.
function mergeDependsOn(refDeps, handWrittenDeps) {
  var seen = emptyMap();
  var merged = [];
  refDeps.concat(handWrittenDeps).forEach(function (name) {
    if (has(seen, name)) {
      return;
    }
    seen[name] = true;
    merged.push(name);
  });
  return merged;
}

// Substitutes every {{ ref('x') }} with x's resolved, backtick-quoted
// relation - same quoting convention move.js's resolveBigQuerySql already
// uses for an interpolated table identifier. resolveRef is expected to
// throw on an unknown name (resolveModelConfig does), which this function
// deliberately does not catch: ref substitution is string interpolation
// into SQL that runs with the script owner's live BigQuery credentials,
// so an unresolved name must stop the run, never fall through as literal
// text.
//
// {{ config(...) }} is stripped to '' - its values were already folded into
// node.config back in expandModelNodes(), so by the time this runs the call
// has nothing left to do except disappear from the compiled statement.
// parseKwargsArgument is still called here (its result discarded) rather
// than just matching the call name, so a config() call this SQL string
// carries that somehow differs from the one discovery already validated
// (there is no legitimate way for that to happen today, since config.sql is
// set once and never mutated - but ref() gets this same redundant
// re-validation on every compile, and diverging from that precedent for
// config() only would be its own small surprise) still throws instead of
// silently vanishing.
//
// {{ var(...) }} resolves via resolveVar() above - notsobigdataModels.vars
// (registry is the caller's, same one it already read for ref()
// resolution) or the call's own default. {{ config(...) }} is stripped to
// '' - its values were already folded into node.config back in
// expandModelNodes(), so by the time this runs the call has nothing left
// to do except disappear from the compiled statement. parseKwargsArgument
// is still called here (its result discarded) rather than just matching
// the call name, so a config() call this SQL string carries that somehow
// differs from the one discovery already validated (there is no
// legitimate way for that to happen today, since config.sql is set once
// and never mutated - but ref() gets this same redundant re-validation on
// every compile, and diverging from that precedent for config() only
// would be its own small surprise) still throws instead of silently
// vanishing.
//
// {% set key = 'value' %} strips to '' after this first pass, in its own
// second replace() below - it's a different bracket shape ({% %}, not
// {{ }}), so templateExpressionPattern()'s call-shaped regex never matches
// it in the first place. A bare {{ key }} reference is resolved in a third
// pass, against setValues (computed once up front, before either replace()
// pass, the same "once per compile, not once per match" reasoning ref()'s
// own resolution already has) - validateSetUsage() already ran this same
// scan at discovery time, so a {{ key }} reaching this function with no
// matching {% set %} is not expected, but the lookup still throws instead
// of substituting undefined, for the same defense-in-depth reason ref()
// and config() both re-validate here rather than trusting discovery alone.
//
// Any *other* {{ name(...) }} call is rejected the same way ref()'s
// unknown name is, for the same reason - see the module comment above
// about growing this dispatch.
function compileModelSql(sql, resolveRef, registry) {
  var setValues = extractSetStatements(sql);
  var compiled = sql.replace(templateExpressionPattern(), function (raw, call, args) {
    if (call === 'config') {
      parseKwargsArgument('config', args);
      return '';
    }
    if (call === 'var') {
      var parsed = parseVarArguments('var', args);
      return resolveVar(registry, parsed.name, parsed.hasDefault, parsed.defaultValue);
    }
    if (call !== 'ref') {
      throw new Error('model(): unsupported template call "' + call + '(...)" in SQL - only ref(), config() and var() are implemented so far.');
    }
    return resolveRef(parseSingleStringArgument('ref', args));
  });
  compiled = compiled.replace(setStatementPattern(), '');
  compiled = compiled.replace(bareVarPattern(), function (raw, name) {
    if (!has(setValues, name)) {
      throw new Error('model(): {{ ' + name + ' }} references "' + name + '", which is never set via {% set ' + name + ' = ... %} in this SQL.');
    }
    return setValues[name];
  });
  // templateExpressionPattern()'s args group is [^)]* - it can't match a
  // call containing its own ")" (e.g. a ref() argument with a stray
  // paren, or a macro call nesting another call), so that span is skipped
  // over entirely rather than reaching the "unsupported call" check above.
  // Left alone, that malformed placeholder would ship to BigQuery as
  // literal, unsubstituted "{{ ... }}"/"{% ... %}" text instead of being
  // rejected - exactly the failure mode the module comment above says the
  // generic scanner exists to avoid. Checking for both "{{" and "{%"
  // catches a malformed {% set %} (or an unimplemented {% if %}) the same
  // way it already catches a malformed {{ ref(...) }}.
  if (compiled.indexOf('{{') !== -1 || compiled.indexOf('{%') !== -1) {
    throw new Error('model(): SQL still contains "{{" or "{%" after substitution - check for a malformed template call or {% set %} statement.');
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

// The check names a model's own tests[] entries may use for a "generic"
// (dbt-style) test - not_null, unique, accepted_values, relationships:
// dbt's own four built-in generic tests. Deliberately not move.js's
// extra tests[] vocabulary (min/max/regex) - those are row-level checks
// over an in-memory 2D array (see move.js's KNOWN_CHECKS) and don't apply
// to a materialized relation; a custom query test below already covers
// that same ground trivially (e.g. "WHERE amount < 0"). Checked by array
// membership rather than object-property lookup, same prototype-pollution
// reasoning as move.js's own KNOWN_CHECKS/isKnownCheck - check is a
// config-supplied string, and a plain {} object already "has" toString,
// constructor and friends.
var MODEL_TEST_KNOWN_CHECKS = ['not_null', 'unique', 'accepted_values', 'relationships'];

function isKnownModelTestCheck(check) {
  return MODEL_TEST_KNOWN_CHECKS.indexOf(check) !== -1;
}

// Extra config key each generic check needs beyond "column" - same "fail
// loud at validation time, not two calls later" reasoning as move.js's
// TEST_CHECK_REQUIRES. Object.create(null) for the same reason: test.check
// is config-supplied, not a hardcoded key.
var MODEL_TEST_REQUIRES = Object.create(null);
MODEL_TEST_REQUIRES.accepted_values = 'values';
MODEL_TEST_REQUIRES.relationships = 'to';

// Backtick-quotes a column/field name for interpolation into generated
// test SQL - MODEL_TEST_COMPILERS below builds SQL text out of
// config-supplied identifiers (test.column, test.field), and an unquoted
// identifier that happens to be a reserved word (order, group, ...) would
// otherwise break. Throws rather than stripping a stray backtick or
// backslash, since a name that already contains either can't be safely
// quoted at all - a backtick-quoted identifier uses the same backslash
// escape sequences a string literal does (see quoteSqlLiteral below), so
// a trailing backslash could otherwise escape the closing backtick the
// same way it can escape a string literal's closing quote. Same "reject,
// don't guess" posture as every other config-shape check in this file -
// a real BigQuery column name has no legitimate use for either character.
function quoteIdentifier(name) {
  if (name.indexOf('`') !== -1 || name.indexOf('\\') !== -1) {
    throw new Error('model(): "' + name + '" is not a valid column/field name - it contains a backtick or backslash.');
  }
  return '`' + name + '`';
}

// Renders one accepted_values entry as a SQL literal - numbers/booleans
// unquoted, strings single-quoted with a backslash escaped first, then an
// embedded "'" (valid GoogleSQL string-literal escaping, matching the
// useLegacySql: false this whole file already runs under). Escaping "\"
// before "'" matters, not just for style: a value ending in an odd number
// of backslashes would otherwise turn the escaped-quote sequence this
// function emits for the *next* value into an escaped quote inside the
// *current* one, closing the literal in the wrong place and letting
// whatever text follows (the rest of a comma-joined values list) be
// parsed as SQL instead of string content. Scoped narrowly to what
// accepted_values needs (test.values is config-supplied text landing in
// generated SQL, same trust model as everything else in this file), not a
// general-purpose SQL serializer - nothing else needs one yet.
function quoteSqlLiteral(value) {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return '\'' + value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') + '\'';
  }
  throw new Error('model(): accepted_values "values" entries must be a string, number, or boolean - got ' + typeof value + '.');
}

// Confirms one tests[] entry is well-formed before it's ever compiled to
// SQL or resolved against the registry - exactly one of check/query set,
// a known check, its required extra key, an accepted_values "values" that
// is a non-empty array of safely quotable literals, no backtick smuggled
// into an identifier. All of this is checked up front, inside
// expandModelNodes()'s own try/catch, so a bad test becomes that model's
// own discoveryError - caught by cli('list'), not just a real run - same
// "validated even before there's data to check" posture move.js's own
// validateTest takes for config.tests.
function validateModelTest(test, messagePrefix) {
  if (!test || typeof test !== 'object') {
    throw new Error(messagePrefix + ' every "tests" entry must be an object.');
  }
  var hasCheck = test.check !== undefined;
  var hasQuery = test.query !== undefined;
  if (hasCheck === hasQuery) {
    throw new Error(messagePrefix + ' every "tests" entry needs exactly one of "check" (a generic test) or "query" (a custom test).');
  }
  if (hasQuery) {
    if (typeof test.query !== 'string' || !test.query) {
      throw new Error(messagePrefix + ' a custom test\'s "query" must be a non-empty string.');
    }
    return;
  }
  if (typeof test.check !== 'string' || !isKnownModelTestCheck(test.check)) {
    throw new Error(messagePrefix + ' test has an unsupported "check" ("' + test.check + '"). Expected one of: ' + MODEL_TEST_KNOWN_CHECKS.join(', ') + '.');
  }
  if (typeof test.column !== 'string' || !test.column) {
    throw new Error(messagePrefix + ' test (check "' + test.check + '") needs a "column" (a non-empty string).');
  }
  quoteIdentifier(test.column);
  var requiredKey = MODEL_TEST_REQUIRES[test.check];
  if (requiredKey && test[requiredKey] === undefined) {
    throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "' + test.check + '") requires "' + requiredKey + '".');
  }
  if (test.check === 'accepted_values') {
    if (!Array.isArray(test.values) || !test.values.length) {
      throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "accepted_values") requires "values" to be a non-empty array.');
    }
    test.values.forEach(quoteSqlLiteral);
  }
  if (test.check === 'relationships') {
    if (typeof test.to !== 'string' || !test.to) {
      throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "relationships") requires "to" (another model\'s name).');
    }
    if (test.field !== undefined) {
      if (typeof test.field !== 'string' || !test.field) {
        throw new Error(messagePrefix + ' test on column "' + test.column + '" (check "relationships") has an invalid "field" - must be a non-empty string.');
      }
      quoteIdentifier(test.field);
    }
  }
}

function validateModelTests(tests, messagePrefix) {
  if (tests === undefined) {
    return;
  }
  if (!Array.isArray(tests)) {
    throw new Error(messagePrefix + ' "tests" must be an array of test objects.');
  }
  tests.forEach(function (test) { validateModelTest(test, messagePrefix); });
}

// The name a compiled test reports itself as in a failure message, when
// the model author didn't set test.name - e.g. not_null_customer_id,
// relationships_customer_id_to_stg_customers - mirroring dbt's own
// generated test names closely enough to be recognizable.
function defaultModelTestName(test) {
  if (test.check === 'relationships') {
    return 'relationships_' + test.column + '_to_' + test.to;
  }
  return test.check + '_' + test.column;
}

// One query-builder per generic check, each producing a query string that
// still contains the literal "{{ this }}" placeholder - substitution
// happens once, inside move.js's runSqlTests, not duplicated here. Every
// query follows the same dbt generic-test contract runSqlTests already
// expects: return the offending rows, zero rows back means the check
// passed. Object.create(null) and MODEL_TEST_KNOWN_CHECKS-based dispatch
// (never CELL_CHECKS-style truthiness) for the same prototype-pollution
// reason move.js's own CELL_CHECKS/TEST_CHECK_REQUIRES already are -
// test.check is a config-supplied string.
var MODEL_TEST_COMPILERS = Object.create(null);
MODEL_TEST_COMPILERS.not_null = function (test) {
  var column = quoteIdentifier(test.column);
  return 'SELECT * FROM {{ this }} WHERE ' + column + ' IS NULL';
};
MODEL_TEST_COMPILERS.unique = function (test) {
  var column = quoteIdentifier(test.column);
  return 'SELECT ' + column + ' FROM {{ this }} GROUP BY ' + column + ' HAVING COUNT(*) > 1';
};
MODEL_TEST_COMPILERS.accepted_values = function (test) {
  var column = quoteIdentifier(test.column);
  var values = test.values.map(quoteSqlLiteral).join(', ');
  return 'SELECT * FROM {{ this }} WHERE ' + column + ' NOT IN (' + values + ')';
};
// relationships needs the registry to resolve "to" into a real relation -
// the same resolveModelConfig()+qualifiedRelation() pair compileModelSql's
// own ref() substitution already uses above, reused here rather than a
// second way to look up a model's relation. The child column's own
// "IS NOT NULL" guard is deliberate: a NULL foreign key isn't a
// referential-integrity violation (pair with a not_null test if that
// matters), matching dbt's own relationships test.
MODEL_TEST_COMPILERS.relationships = function (test, registry) {
  var column = quoteIdentifier(test.column);
  var field = quoteIdentifier(test.field || test.column);
  var toRelation = qualifiedRelation(resolveModelConfig(test.to, registry));
  return 'SELECT ' + column + ' FROM {{ this }} WHERE ' + column + ' IS NOT NULL AND '
    + column + ' NOT IN (SELECT ' + field + ' FROM ' + toRelation + ')';
};

// Turns every tests[] entry into the {name, query} shape move.js's
// runSqlTests expects - a custom entry (test.query) passes through as-is;
// a generic entry (test.check) compiles via MODEL_TEST_COMPILERS. registry
// is only actually used by "relationships"' to-resolution, but passed to
// every compiler uniformly rather than special-casing one check's own
// signature.
function compileModelTests(tests, registry) {
  return tests.map(function (test) {
    if (test.query) {
      return { name: test.name, query: test.query };
    }
    return { name: test.name || defaultModelTestName(test), query: MODEL_TEST_COMPILERS[test.check](test, registry) };
  });
}

// The dependency-derivation hook for "relationships" tests, mirroring
// extractRefDependencies above for {{ ref() }}: a relationships test's
// "to" is a real edge to another model - this model can't meaningfully be
// tested against a model that hasn't run yet - so it has to be
// discoverable the same cheap, SQL-free way {{ ref() }}'s names are,
// without resolving anything against the registry yet (that happens once,
// at compile time, in MODEL_TEST_COMPILERS.relationships above).
function extractTestRefDependencies(tests) {
  return (tests || [])
    .filter(function (test) { return test && test.check === 'relationships'; })
    .map(function (test) { return test.to; });
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
// mismatched tag id, or duplicate id becomes that one node's own
// discoveryError (a plain node-level field, not nested in config - cli.js's
// runNodes() checks it kind-agnostically, the same way it already checks
// dependsOn) instead of an exception that unwinds discoverNodes() itself
// and hides every node, of any kind, from cli("hello")/cli("list")/
// cli("run --select ...") alike. A malformed notsobigdataModels/
// registry.models shape is deliberately not covered here -
// readModelsRegistry() above still throws for that, since it's a mistake
// in the one shared config every model reads, not one model's own problem.
//
// discoveryError is deliberately still reported by a dry "list" run, not
// only a real "run" - cli("list")'s whole point is surfacing a config
// mistake before anything executes for real, and this kind of error is
// already fully known at discovery time (no BigQuery call needed to see
// it), so deferring it to a real run would make "list" strictly less
// useful for exactly the errors that are cheapest to catch early.
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
      // {{ config(...) }} overrides applied after resolveModelConfig()'s own
      // defaults+entry merge, so a model's own SQL wins over both the
      // registry's project-wide default and its own registry entry - see
      // extractConfigOverrides above.
      var configOverrides = extractConfigOverrides(config.sql);
      Object.keys(configOverrides).forEach(function (key) { config[key] = configOverrides[key]; });
      validateModelTests(config.tests, 'model(): "' + name + '"');
      validateSetUsage(config.sql, 'model(): "' + name + '"');
      validateVarUsage(config.sql, registry, 'model(): "' + name + '"');
      // Computed from config.dependsOn (whichever hand-written value won
      // MODEL_DEFAULT_KEYS's override), then deleted off config - node.config
      // must not keep its own, pre-merge "dependsOn" once node.dependsOn
      // holds the real, merged edges below; two dependsOn-shaped values on
      // one node, disagreeing with each other, is exactly the kind of stale
      // state that confuses whoever inspects a node's config next.
      var handWritten = parseDependsOnList('model(): "' + name + '"', config.dependsOn);
      delete config.dependsOn;
      node.config = config;
      // A relationships test's "to" is unioned in alongside {{ ref() }}'s
      // own edges - see extractTestRefDependencies above - so a model
      // never runs (or is tested) against a relation that hasn't been
      // built yet, the same guarantee {{ ref() }} already gives.
      node.dependsOn = mergeDependsOn(
        extractRefDependencies(config.sql).concat(extractTestRefDependencies(config.tests)),
        handWritten
      );
    } catch (error) {
      node.discoveryError = error.message;
    }
    return node;
  });
}

// The EXECUTORS.model entry: compiles the model's SQL (substituting every
// ref()), materializes it as a view or table, then - if the model
// declares tests - runs them against the relation it just materialized.
// Deliberately does not call move.js's assertReadOnlySelect on the
// model's own SQL - that guard exists to keep move() read-only, and a
// model's whole job is writing. It does reuse assertSingleStatement,
// move.js's other SQL-shape guard: a model can write, but a stray ";"
// splitting its SQL into more than one statement is a mistake either way,
// not a second statement this library intends to run.
//
// Tests run *after* CREATE OR REPLACE, not staged-then-promoted the way a
// bigquery move target's sqlTests are (see loadBigQueryStaged in
// move.js). That's deliberate, not a missed guarantee: CREATE OR REPLACE
// is already atomic, and re-running a model's own SELECT a second time
// into a scratch table just to test-before-promote would double BigQuery
// compute on every single run - for a guarantee real dbt itself doesn't
// give either (dbt builds a model, then runs its tests afterward, as a
// separate step; a failing test never un-writes the model). A failing
// test here throws (via the reused runSqlTests), which fails this node
// and skips its dependents through cli()'s ordinary failure propagation -
// same outcome shape as any other model() failure, just discovered one
// step later. There is no "discard_row" equivalent for a model test:
// unlike move()'s in-memory tests, there's no row array left to filter -
// the relation is already fully written by the time a test can run.
//
// config.sql is always already set by expandModelNodes() above by the
// time this runs. A node whose own discovery failed instead carries a
// node-level discoveryError, which cli.js's runNodes() checks and reports
// as "failed" before ever calling an EXECUTORS entry - so there is no path
// into this function for a node that didn't get a real config.sql, and
// config.tests (if present) has already passed validateModelTests above.
function model(config) {
  var sql = config.sql;
  assertSingleStatement(sql, 'model(): "' + config.name + '"');
  var registry = readModelsRegistry();
  var compiled = compileModelSql(sql, function (refName) {
    return qualifiedRelation(resolveModelConfig(refName, registry));
  }, registry);
  var relation = qualifiedRelation(config);
  var materialized = resolveMaterialized(config);
  var statement = 'CREATE OR REPLACE ' + materialized.toUpperCase() + ' ' + relation + ' AS\n' + compiled;
  runBigQueryQueryJob({ query: statement, useLegacySql: false }, config.projectId);
  var result = { relation: relation, materialized: materialized };
  if (config.tests && config.tests.length) {
    var compiledTests = compileModelTests(config.tests, registry);
    result.testResults = runSqlTests(
      compiledTests,
      { projectId: config.projectId, dataset: config.dataset, table: config.name },
      'model(): "' + config.name + '" tests'
    );
  }
  return result;
}
