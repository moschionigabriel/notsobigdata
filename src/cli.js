// cli() - the library's single public entrypoint.
//
// The kind modules (move.js, model.js) are machinery for doing one step's
// work. This module is the declarative layer on top of them: instead of
// calling move() yourself, once per step, in the right order, you
// *declare* plain objects at the top level of your script and let cli()
// find them, order them by their dependencies, and run them. Same idea as
// dbt, where you don't call each model - you write models and run
// "dbt run --select ...".

// Maps a node's "kind" to the function that executes one node's config.
// This is the only place a kind is registered for *execution*: selection,
// ordering and the run loop below are all kind-agnostic, and knownKinds()
// feeds the help text, the selector errors and hello(), so all of those
// pick up a new kind from this map alone.
//
// One honest caveat, so nobody discovers it mid-change: discovery is
// kind-agnostic only for kinds whose *edges* are hand-written. move's
// dependsOn is read straight off its config below; model's isn't - a
// model derives its edges by parsing {{ ref() }} out of its own SQL, and
// its nodes don't even come from a top-level var each (see
// discoverNodes() below) - they're expanded from the single
// notsobigdataModels registry by model.js's expandModelNodes(). Both of
// those are model-specific hooks, kept as narrow as the kind that needed
// them; a third kind needing something similar gets its own hook, not a
// generalized version of this one.
var EXECUTORS = {
  move: move,
  model: model
};

// The compile-time counterpart to EXECUTORS, consulted only by
// cli('compile') (see runNodes()'s 'compile' branch below). Not every kind
// has something to compile - move has no {{ }}-style templating, so a move
// node under cli('compile') just reports 'planned' with no compiledSql,
// the same as it already does under cli('list'). Deliberately its own
// small map rather than folded into EXECUTORS: EXECUTORS answers "how do I
// run this kind for real", COMPILERS answers a different, narrower
// question ("can this kind's SQL be resolved without running it") that
// only 'model' can answer yes to today.
var COMPILERS = {
  model: compileModel
};

function knownKinds() {
  return Object.keys(EXECUTORS);
}

// Membership test that ignores the prototype chain. Every lookup map
// below is keyed by node names and kinds that come from the caller's own
// config, and a plain {} already "has" toString, constructor, valueOf and
// friends. Without this, a node named "toString" would test as present in
// maps it was never added to - passing dependency validation and then
// failing inside the sort with a TypeError instead of a clear message.
function has(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// True for a plain, non-array object - the shape check every "is this
// really a config object" guard in this library repeats: discoverNodes()'s
// var-scan below, and model.js's readModelsRegistry (twice, once for the
// registry itself and once for its .models field). One predicate means
// whether "typeof x === 'object'" needs the Array.isArray() exclusion too
// never has to be decided more than once.
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Every lookup map below is built with this rather than {}, because has()
// only fixes half the problem. It guards the *read* side; this guards the
// *write* side, and the write side has a worse failure. Assigning
// obj['__proto__'] = value on a plain object doesn't create an own property
// at all - it sets the prototype - so a node named "__proto__" silently
// vanishes from every map it was added to. The symptoms are absurd: a node
// with no dependencies at all gets reported as a cycle, and a dependency on
// it is reported as "not a declared node" while it sits right there in the
// graph. A null prototype has no __proto__ setter to hijack, so the key
// stores like any other.
function emptyMap() {
  return Object.create(null);
}

// Claims a node name against the shared map every discovery path
// populates - the plain var-scan below and model.js's expandModelNodes()
// fold-in both need "is this name already taken, and by what" to agree,
// so the check and its error message live in one place instead of being
// copy-pasted per discovery path.
function claimName(claimedNames, name, variable) {
  if (has(claimedNames, name)) {
    throw new Error('cli(): two nodes are both named "' + name + '" (declared as "' + claimedNames[name] + '" and "' + variable + '"). Node names must be unique - set an explicit "name" on one of them.');
  }
  claimedNames[name] = variable;
}

// Guarded read of a single optional global - shared by every "config
// object declared as a top-level var, or omitted entirely" reader in this
// library (resolveManifestConfig/resolveLoggingConfig below, and
// model.js's readModelsRegistry). Never throws because of a global this
// library doesn't own, same reasoning discoverNodes()'s own scan already
// applies to every global it walks past.
function readOptionalGlobal(name) {
  try {
    return globalThis[name];
  } catch (error) {
    return undefined;
  }
}

// Node lists appear in three different error messages and in hello()'s
// output. Going through one helper keeps them rendering identically by
// construction rather than by coincidence.
function nodeNames(nodes) {
  return nodes.map(function (node) { return node.name; });
}

// Same reasoning as nodeNames() above, for the single-node case: the
// "<name> (<kind>)" label appears at every log line runNodes() writes
// (START/SKIP/PLAN/OK/FAIL) plus hello()'s node listing - one helper keeps
// all six rendering identically by construction.
function nodeLabel(node) {
  return node.name + ' (' + node.kind + ')';
}

var COMMANDS = ['run', 'list', 'compile', 'debug', 'hello', 'help'];

function usage() {
  return [
    'notsobigdata commands:',
    '',
    '  cli("run")                     run every declared node, in dependency order',
    '  cli("run --select move")       run only nodes of a given kind',
    '  cli("run --select a,b")        run only the named nodes',
    '  cli("run --exclude a")         run everything except the named nodes',
    '  cli("list")                    show what would run, in order, without running it',
    '  cli("compile")                 resolve model SQL ({{ ref() }}/var()/config()) without running anything',
    '  cli("debug")                   check OAuth scopes/services for each node\'s connector, without writing anything',
    '  cli("hello")                   check the library loaded and see which nodes it can find',
    '  cli("help")                    this message',
    '',
    'Nodes are plain objects declared as top-level "var"s, marked with a',
    '"kind" (one of: ' + knownKinds().join(', ') + '). Their name defaults to',
    'the variable name, and "dependsOn" lists the names they must run after.'
  ].join('\n');
}

// Turns a command string into { command, select, exclude }. Deliberately
// a tiny hand-rolled parser rather than anything clever: the whole
// grammar is one verb plus two optional list flags, and both
// "--select a,b" and "--select=a,b" are accepted because both spellings
// are muscle memory for anyone who has used a real CLI.
function parseCommand(input) {
  var text = typeof input === 'string' ? input.trim() : '';
  if (!text) {
    throw new Error('cli(): a command is required, e.g. cli("run").\n\n' + usage());
  }
  // Collapse whitespace around commas before splitting on whitespace.
  // Without this, "--select a, b" tokenizes as "--select", "a," and "b",
  // and the parser rejects "b" as an unknown option - a confusing message
  // for an input people write by reflex. A comma is the list separator, so
  // it can never be part of a node name; closing the gap costs nothing.
  var tokens = text.replace(/\s*,\s*/g, ',').split(/\s+/);
  var command = tokens.shift();
  if (COMMANDS.indexOf(command) === -1) {
    throw new Error('cli(): unknown command "' + command + '".\n\n' + usage());
  }
  var parsed = { command: command, select: [], exclude: [] };
  while (tokens.length) {
    var token = tokens.shift();
    var flag = token;
    var value = null;
    var equalsAt = token.indexOf('=');
    if (equalsAt !== -1) {
      flag = token.slice(0, equalsAt);
      value = token.slice(equalsAt + 1);
    }
    if (flag !== '--select' && flag !== '--exclude') {
      throw new Error('cli(): unknown option "' + flag + '". Expected "--select" or "--exclude".\n\n' + usage());
    }
    if (value === null) {
      value = tokens.length && tokens[0].indexOf('--') !== 0 ? tokens.shift() : '';
    }
    var list = value.split(',')
      .map(function (item) { return item.trim(); })
      .filter(function (item) { return !!item; });
    if (!list.length) {
      throw new Error('cli(): "' + flag + '" needs a comma-separated value, e.g. ' + flag + ' orders,customers.');
    }
    // Both flags are "--" plus the key they fill, and flag was validated
    // above, so this is the key rather than a lookup that could miss.
    var key = flag.slice(2);
    parsed[key] = parsed[key].concat(list);
  }
  return parsed;
}

// Finds every declared node by scanning the global scope.
//
// This is the one place the library reaches outside its own closure, and
// it needs care. In Apps Script the global scope also holds every
// built-in service (SpreadsheetApp, DriveApp, ...) and every function
// the user wrote, and some of those are lazily initialized behind
// property getters that can be slow or throw on access. So the scan
// only ever *reads* properties - it never calls anything it finds - and
// every read is guarded, because a scan must never fail because of a
// global it wasn't interested in.
//
// Note this only sees top-level "var" declarations. A config object
// declared inside a function is invisible here - the caller's local
// scope isn't reachable from in here, only the other way around. That's
// the same scoping rule the eval() install line is subject to, which is
// why cli("hello") exists and why zero discovered nodes is reported
// loudly rather than treated as "nothing to do".
function discoverNodes() {
  var scope;
  var keys;
  try {
    scope = globalThis;
    keys = Object.keys(scope);
  } catch (error) {
    throw new Error('cli(): could not read the global scope to find declared nodes - ' + error.message);
  }
  var nodes = [];
  var ignored = [];
  var claimedNames = emptyMap();
  keys.forEach(function (key) {
    var value;
    var kind;
    var declaredName;
    var dependsOn;
    // One guard covering every read of a global this library didn't
    // declare: the property itself may throw on access, and so may any of
    // its keys. Either way the answer is the same - it isn't one of ours,
    // move on - so there's no reason to distinguish the two cases.
    try {
      value = scope[key];
      if (!isPlainObject(value)) {
        return;
      }
      kind = value.kind;
      declaredName = value.name;
      dependsOn = value.dependsOn;
    } catch (error) {
      return;
    }
    if (typeof kind !== 'string') {
      return;
    }
    var name = typeof declaredName === 'string' && declaredName ? declaredName : key;
    // An unrecognized kind is reported, not thrown: an unrelated global
    // could legitimately carry a "kind" key and it isn't this library's
    // business. But surfacing it in hello/list output means a typo like
    // kind: "mvoe" is visible instead of silently doing nothing.
    if (!has(EXECUTORS, kind)) {
      ignored.push({ name: name, kind: kind, variable: key });
      return;
    }
    // model is a known kind but not one this scan can ever build a
    // correct node for: its dependsOn comes from parsing {{ ref() }} out
    // of its SQL (see expandModelNodes() below), which this loop has no
    // way to do for a bare top-level var. Without this check, a var
    // written this way - the shape an earlier version of this README
    // documented - wouldn't be ignored (model is a real EXECUTORS entry
    // now) and wouldn't fail loudly either: it would silently become a
    // node with no derived edges at all, ordering wrong relative to
    // whatever it actually ref()s.
    if (kind === 'model') {
      throw new Error('cli(): "' + key + '" is declared as a top-level var with kind "model" - models are declared as entries in notsobigdataModels.models instead, not their own var. See README.md\'s "The model kind" section.');
    }
    claimName(claimedNames, name, key);
    var edges = parseDependsOnList('cli(): node "' + name + '"', dependsOn);
    nodes.push({
      name: name,
      kind: kind,
      variable: key,
      config: value,
      dependsOn: edges
    });
  });
  // model nodes don't come from the scan above at all - see the EXECUTORS
  // comment. expandModelNodes() (model.js) turns the single
  // notsobigdataModels registry into one fully-formed node per entry,
  // already carrying config and dependsOn; folding them in here, right
  // where the var-scan finishes, means every downstream step
  // (assertDependenciesExist, selection, ordering, running) sees one flat
  // node list and never has to know two different discovery mechanisms
  // produced it.
  //
  // nodes (everything the scan above already found - today, only move) is
  // passed in so a model's {{ ref() }} can also resolve a move node with a
  // bigquery target, not just another model - see expandModelNodes()'s own
  // comment for how it uses this list.
  expandModelNodes(nodes).forEach(function (node) {
    claimName(claimedNames, node.name, node.variable);
    nodes.push(node);
  });
  return { nodes: nodes, ignored: ignored };
}

// Validates an optional dependsOn value and normalizes it to an edge list
// (no dependsOn means no edges). Shared by discoverNodes() below (a move
// node's own dependsOn) and model.js's expandModelNodes() (a model's
// hand-written dependsOn, unioned with its {{ ref() }}-derived edges) -
// same shape, same failure mode, validated once instead of twice. context
// is the caller's own error-message prefix (e.g. 'cli(): node "orders"' or
// 'model(): "orders_summary"'), so the thrown message still reads right
// for whichever caller hit it. The copy on the valid path matters: the
// node's edges must not alias the caller's array, which they could mutate
// later.
function parseDependsOnList(context, raw) {
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new Error(context + ' has a "dependsOn" that is not an array - got ' + typeof raw + '.');
  }
  var edges = raw ? raw.slice() : [];
  edges.forEach(function (dependency) {
    if (typeof dependency !== 'string' || !dependency) {
      throw new Error(context + ' has a "dependsOn" entry that is not a node name string.');
    }
  });
  return edges;
}

// Every dependsOn entry must name a node that actually exists. Checked
// against everything discovered, not just the current selection, so
// "--select" narrowing what runs never turns a real typo into a
// silently-ignored dependency.
function assertDependenciesExist(nodes) {
  var byName = emptyMap();
  nodes.forEach(function (node) { byName[node.name] = true; });
  nodes.forEach(function (node) {
    node.dependsOn.forEach(function (dependency) {
      if (!has(byName, dependency)) {
        throw new Error('cli(): node "' + node.name + '" dependsOn "' + dependency + '", which is not a declared node. Known nodes: ' + nodeNames(nodes).join(', ') + '.');
      }
    });
  });
}

// Resolves one --select/--exclude token to node names, matching kinds
// before names: "--select move" means every move node, "--select orders"
// means the node called orders. A token matching neither is an error
// rather than an empty selection, since silently running nothing is the
// failure mode this whole design has to guard against hardest.
function resolveSelector(nodes, token) {
  var byKind = nodes.filter(function (node) { return node.kind === token; });
  var byName = nodes.filter(function (node) { return node.name === token; });
  // Matching both is ambiguous, and quietly preferring the kind is the one
  // selector mistake in this design that wouldn't announce itself. A node's
  // name defaults to its variable name, so "var move = { kind: 'move' }" is
  // an easy thing to write - and then "--exclude move" drops every move
  // node in the project instead of that one. Everything else here fails
  // loudly; so does this.
  if (byKind.length && byName.length) {
    throw new Error('cli(): "' + token + '" is ambiguous - it is both a kind and the name of a declared node. Rename the node, or name the ones you mean explicitly: ' + nodeNames(byKind).join(', ') + '.');
  }
  var matches = byKind.length ? byKind : byName;
  if (!matches.length) {
    throw new Error('cli(): "' + token + '" matched no kind and no node name. Kinds: ' + knownKinds().join(', ') + '. Nodes: ' + nodeNames(nodes).join(', ') + '.');
  }
  return nodeNames(matches);
}

// Turns a list of selector tokens into a name lookup map. Shared by both
// --select and --exclude so the two can't drift in how they resolve a
// token - which is exactly what would happen the day dbt's "+" operators
// get added to one branch and not the other.
function namesMatching(nodes, tokens) {
  var names = emptyMap();
  tokens.forEach(function (token) {
    resolveSelector(nodes, token).forEach(function (name) { names[name] = true; });
  });
  return names;
}

// Applies --select then --exclude. Note --select selects exactly what it
// names: it does not pull in upstream dependencies, which are assumed to
// have run already. (dbt spells that distinction "orders" vs "+orders";
// the "+" operators are deliberately left out of this first version.)
function applySelection(nodes, select, exclude) {
  var selected = nodes;
  if (select.length) {
    var wanted = namesMatching(nodes, select);
    selected = selected.filter(function (node) { return has(wanted, node.name); });
  }
  if (exclude.length) {
    var unwanted = namesMatching(nodes, exclude);
    selected = selected.filter(function (node) { return !has(unwanted, node.name); });
  }
  return selected;
}

// Sorts nodes so every node comes after the ones it dependsOn, using
// Kahn's algorithm: repeatedly take nodes with nothing left to wait for.
// Picked over the recursive alternative because of how it fails - when
// it stalls, the nodes it could not place *are* the cycle, so the error
// can name them instead of just saying a cycle exists.
//
// Dependencies on nodes outside the given set (because --select narrowed
// things down) are skipped rather than treated as unsatisfiable: they
// were validated to exist by assertDependenciesExist, and running a
// subset means deliberately assuming its upstreams already ran.
function orderNodes(nodes) {
  var byName = emptyMap();
  var waitingOn = emptyMap();
  var dependents = emptyMap();
  nodes.forEach(function (node) {
    byName[node.name] = node;
    waitingOn[node.name] = 0;
    dependents[node.name] = [];
  });
  nodes.forEach(function (node) {
    node.dependsOn.forEach(function (dependency) {
      if (!has(byName, dependency)) {
        return;
      }
      waitingOn[node.name] += 1;
      dependents[dependency].push(node.name);
    });
  });
  var ready = nodes
    .filter(function (node) { return waitingOn[node.name] === 0; })
    .map(function (node) { return node.name; });
  var ordered = [];
  while (ready.length) {
    var name = ready.shift();
    ordered.push(byName[name]);
    dependents[name].forEach(function (dependent) {
      waitingOn[dependent] -= 1;
      if (waitingOn[dependent] === 0) {
        ready.push(dependent);
      }
    });
  }
  if (ordered.length !== nodes.length) {
    // A node is unplaced exactly when its counter never reached zero, which
    // waitingOn already knows - no need to re-derive it by searching the
    // ordered list for what's missing.
    var stuck = nodeNames(nodes.filter(function (node) {
      return waitingOn[node.name] > 0;
    }));
    throw new Error('cli(): dependsOn forms a cycle - these nodes each wait on another one in the group: ' + stuck.join(', ') + '.');
  }
  return ordered;
}

// Runs the ordered nodes, one at a time.
//
// A failure does not abort the run. The failed node is recorded, every
// node downstream of it is marked "skipped" (transitively - a node
// skipped for a missing upstream also blocks its own dependents), and
// unrelated branches still run. That matters more here than in a normal
// scheduler: each run is a human clicking Run in the Apps Script editor
// and waiting, so surfacing every independent failure in one pass beats
// fixing them one run at a time.
//
// Logged output stays deliberately small - names, statuses, row counts -
// never the extracted rows themselves, which can be huge and may hold
// data the user would rather not have sitting in an execution log.
//
// START logs immediately before the one branch that can actually take
// real time - the EXECUTORS[node.kind] call - not before the blocked-check
// or the dry-run/compile checks above it, since none of those waits on
// anything: a skipped, planned or compiled node is decided instantly, so a
// START line there would never carry the "is this still working" signal it
// exists for. That signal matters for real execution (a BigQuery job can
// poll for tens of seconds) - without it, a human watching the Apps Script
// log during a long run can only see which nodes have already finished,
// never which one is currently in flight.
//
// SKIP and FAIL always log - they're exactly what needs a human's
// attention. OK only logs when verbose is true: nothing failed is already
// implied by START's presence plus the absence of a FAIL/SKIP line, and
// the row-count/timing detail OK would add is never lost from the
// permanent record either way - it's always in the returned result and
// (for "run") the Drive manifest, regardless of what hits the console.
// verbose defaults false (see resolveLoggingConfig()) precisely so a
// normal run's console output stays proportional to what needs attention,
// not to how many nodes happened to succeed.
//
// command is one of 'run', 'list' or 'compile' - not a bare dryRun boolean,
// since 'list' and 'compile' are both "don't touch BigQuery/Sheets/Drive"
// modes but differ in what they report: 'list' always reports 'planned'
// with nothing else attached, kind-agnostically; 'compile' additionally
// resolves a model's SQL via COMPILERS (see its own comment above
// EXECUTORS) for any kind that has something to compile, attaching the
// result as compiledSql on the same 'planned' status, and treating a
// compile failure the same way a real run failure is treated - it blocks
// dependents transitively via the same `blocked` map, rather than needing
// a parallel skip mechanism just for this mode.
function runNodes(nodes, command, verbose) {
  var results = [];
  var blocked = emptyMap();
  nodes.forEach(function (node) {
    // A node can arrive already known to be broken - model.js's
    // expandModelNodes() sets this when a model's own sqlFile/tag
    // configuration is bad, discovered while building the graph, well
    // before any node's turn to actually run. Checked here, kind-
    // agnostically (a plain node-level field, not something only model
    // nodes could have), and ahead of the dry-run/compile branches below:
    // the whole point of a "list"/"compile" dry run is surfacing a config
    // mistake before anything executes for real, and this error is already
    // fully known with nothing to execute to see it - reporting it only on
    // a real "run" would make "list"/"compile" strictly less useful for
    // exactly the errors that are cheapest to catch early.
    if (node.discoveryError) {
      blocked[node.name] = true;
      results.push({ name: node.name, kind: node.kind, status: 'failed', error: node.discoveryError });
      Logger.log('FAIL  ' + nodeLabel(node) + ' - ' + node.discoveryError);
      return;
    }
    var blockers = node.dependsOn.filter(function (dependency) { return has(blocked, dependency); });
    if (blockers.length) {
      blocked[node.name] = true;
      results.push({ name: node.name, kind: node.kind, status: 'skipped', blockedBy: blockers });
      Logger.log('SKIP  ' + nodeLabel(node) + ' - waiting on ' + blockers.join(', '));
      return;
    }
    if (command === 'compile') {
      if (!has(COMPILERS, node.kind)) {
        results.push({ name: node.name, kind: node.kind, status: 'planned' });
        Logger.log('PLAN  ' + nodeLabel(node));
        return;
      }
      try {
        var compiledSql = COMPILERS[node.kind](node.config);
        results.push({ name: node.name, kind: node.kind, status: 'planned', compiledSql: compiledSql });
        Logger.log('PLAN  ' + nodeLabel(node) + ' - compiled');
      } catch (error) {
        blocked[node.name] = true;
        results.push({ name: node.name, kind: node.kind, status: 'failed', error: error.message });
        Logger.log('FAIL  ' + nodeLabel(node) + ' - ' + error.message);
      }
      return;
    }
    if (command === 'list') {
      results.push({ name: node.name, kind: node.kind, status: 'planned' });
      Logger.log('PLAN  ' + nodeLabel(node));
      return;
    }
    Logger.log('START ' + nodeLabel(node));
    var startedAt = new Date().getTime();
    try {
      var result = EXECUTORS[node.kind](node.config);
      var elapsed = new Date().getTime() - startedAt;
      results.push({ name: node.name, kind: node.kind, status: 'success', ms: elapsed, result: result });
      if (verbose) {
        Logger.log('OK    ' + nodeLabel(node) + ' - ' + (Array.isArray(result) ? result.length + ' rows, ' : '') + elapsed + 'ms');
      }
    } catch (error) {
      blocked[node.name] = true;
      results.push({ name: node.name, kind: node.kind, status: 'failed', ms: new Date().getTime() - startedAt, error: error.message });
      Logger.log('FAIL  ' + nodeLabel(node) + ' - ' + error.message);
    }
  });
  return results;
}

// Counts each status in a runNodes() result set and renders it as the
// "DONE" summary line cli() logs at the end of a run/list - see there.
// Only non-zero counts are rendered - a "list" run (every node
// "planned") would otherwise print "0 passed, 0 failed, 0 skipped, 5
// planned", which buries the one number that matters in noise nobody
// asked about. One function rather than a count/format split: this
// project's tests are black-box (a human runs cli() from the Apps
// Script editor - see CLAUDE.md's "About testing"), so there is no
// caller that would ever want the raw counts independent of this one
// string.
function formatStatusCounts(results) {
  var counts = { success: 0, failed: 0, skipped: 0, planned: 0 };
  results.forEach(function (result) { counts[result.status] += 1; });
  var labels = { success: 'passed', failed: 'failed', skipped: 'skipped', planned: 'planned' };
  var parts = ['success', 'failed', 'skipped', 'planned']
    .filter(function (status) { return counts[status] > 0; })
    .map(function (status) { return counts[status] + ' ' + labels[status]; });
  return parts.length ? parts.join(', ') : 'nothing to do';
}

// Reads the optional notsobigdataManifest global the same guarded way
// discoverNodes() reads every other global - the read must never throw
// because of something this library doesn't own. Every field is
// optional; omitting the global entirely gives all three defaults.
function resolveManifestConfig() {
  var raw = readOptionalGlobal('notsobigdataManifest');
  var config = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled: config.enabled !== false,
    folderId: typeof config.folderId === 'string' && config.folderId ? config.folderId : null,
    fileName: typeof config.fileName === 'string' && config.fileName ? config.fileName : 'notsobigdata-manifest.json'
  };
}

// Reads the optional notsobigdataLogging global, same guarded pattern as
// resolveManifestConfig() above. verbose is the only field: false by
// default, so a normal run's console output stays proportional to what
// needs attention (see runNodes()'s own comment) rather than to how many
// nodes happened to succeed. Set true to restore an OK line for every
// successful node too.
function resolveLoggingConfig() {
  var raw = readOptionalGlobal('notsobigdataLogging');
  var config = (raw && typeof raw === 'object') ? raw : {};
  return { verbose: config.verbose === true };
}

// Auto-detects "the folder the Apps Script project lives in" when no
// explicit folderId is configured - every Apps Script project has its own
// Drive file entry, even standalone ones, so its parent folder is the
// project's folder. Falls back to Drive's root when that file has no
// parent (e.g. it sits directly in "My Drive").
function resolveManifestFolderId(folderId) {
  if (folderId) {
    return folderId;
  }
  var scriptFile = DriveApp.getFileById(ScriptApp.getScriptId());
  var parents = scriptFile.getParents();
  return parents.hasNext() ? parents.next().getId() : DriveApp.getRootFolder().getId();
}

// Turns one runNodes() result into a manifest-safe summary. Kind-agnostic
// by construction: it never branches on node.kind, only on the *shape* of
// the result (an array of rows, an object carrying loadResult/testResults,
// or model()'s relation/materialized) - the same shapes every EXECUTORS
// entry already produces. The raw rows are never included, only their
// size - a manifest is an observability artifact, not a second copy of
// the data that already landed at its real destination.
function summarizeNodeResult(result) {
  var summary = { name: result.name, kind: result.kind, status: result.status };
  if (result.status === 'skipped') {
    summary.blockedBy = result.blockedBy;
  } else if (result.status === 'failed') {
    summary.ms = result.ms;
    summary.error = result.error;
  } else if (result.status === 'planned') {
    // Only cli('compile') ever sets this - cli('list')'s own 'planned'
    // results never carry a compiledSql, and 'list' never calls
    // buildManifest() at all (see cli()'s dispatch below), so this branch
    // is a no-op for every manifest except the compile one.
    if (result.compiledSql !== undefined) {
      summary.compiledSql = result.compiledSql;
    }
  } else if (result.status === 'success') {
    summary.ms = result.ms;
    if (Array.isArray(result.result)) {
      summary.rowCount = result.result.length;
      summary.columnCount = Array.isArray(result.result[0]) ? result.result[0].length : 0;
    }
    if (result.result && result.result.loadResult !== undefined) {
      summary.loadResult = result.result.loadResult;
    }
    if (result.result && result.result.testResults !== undefined) {
      summary.testResults = result.result.testResults;
    }
    if (result.result && result.result.relation !== undefined) {
      summary.relation = result.result.relation;
      summary.materialized = result.result.materialized;
    }
  }
  return summary;
}

function buildManifest(commandText, ok, results, ignored) {
  return {
    notsobigdata: 'manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    command: String(commandText).trim(),
    ok: ok,
    nodes: results.map(summarizeNodeResult),
    ignored: ignored
  };
}

// Shared by writeManifest()/writeCompileManifest() below - both do the
// exact same "resolve folder, upsert by name via Drive, log every outcome,
// never throw" work, differing only in which global they read config from
// and what prefix they log under (logPrefix), so this is the one place
// that actually writes, called with each caller's own already-resolved
// config plus the *other* one's config for the collision guard right
// below. Best-effort: a Drive failure here must never throw or affect the
// node results actually being reported, so every path is caught and
// turned into one of four report.manifest shapes instead.
//
// Every outcome also gets a Logger.log line, same as every other outcome
// in a run (the call-level START/DONE, each node's START/OK/FAIL/SKIP/PLAN).
// Without it, a failed write was only visible in the returned
// report.manifest - which the documented usage pattern (Logger.log(report.ok))
// never inspects - so a human watching the Apps Script execution log, the
// one place CLAUDE.md's testing section says they actually look, had no way
// to tell a manifest failed to write from one that succeeded silently.
//
// Reuses resolveDriveWriteTarget/writeDriveText from move.js rather than
// re-implementing "resolve an existing file or create one" a second
// time - the first helper call to cross the move.js/cli.js boundary, and
// deliberately so: this is genuinely the same primitive loadDriveJson
// already uses, not new drive-writing logic.
//
// otherConfig is only consulted (and only ever costs a Drive lookup, via
// resolveManifestFolderId(), when its own folderId is unset) if it's
// enabled - a disabled manifest can never actually be overwritten, so
// there is nothing to guard against. When both configs resolve to the
// same folderId + fileName, refusing to write (rather than writing
// anyway) is the only choice that can't silently destroy whichever
// manifest was written most recently - a run's manifest overwritten by a
// later compile, or vice versa, with no error either time it happened
// before this guard existed.
function writeManifestFile(logPrefix, config, otherConfig, commandText, ok, results, ignored) {
  if (!config.enabled) {
    Logger.log(logPrefix + ' skipped - enabled is false');
    return { written: false, reason: 'disabled' };
  }
  try {
    var folderId = resolveManifestFolderId(config.folderId);
    if (otherConfig.enabled) {
      var otherFolderId = resolveManifestFolderId(otherConfig.folderId);
      if (folderId === otherFolderId && config.fileName === otherConfig.fileName) {
        var message = 'notsobigdataManifest and notsobigdataCompileManifest resolve to the same Drive file (folderId "'
          + folderId + '", fileName "' + config.fileName + '") - refusing to write, since cli(\'run\') and cli(\'compile\') '
          + 'would otherwise silently overwrite each other\'s manifest. Give one of them its own folderId or fileName.';
        Logger.log(logPrefix + ' failed - ' + message);
        return { written: false, reason: 'collision', error: message };
      }
    }
    var manifest = buildManifest(commandText, ok, results, ignored);
    var target = { folderId: folderId, fileName: config.fileName, upsertByName: true };
    var fileId = resolveDriveWriteTarget(target);
    fileId = writeDriveText(fileId, target, JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT);
    Logger.log(logPrefix + ' written to ' + fileId);
    return { written: true, fileId: fileId };
  } catch (error) {
    Logger.log(logPrefix + ' failed - ' + error.message);
    return { written: false, reason: 'error', error: error.message };
  }
}

function writeManifest(commandText, ok, results, ignored) {
  return writeManifestFile('MANIFEST', resolveManifestConfig(), resolveCompileManifestConfig(), commandText, ok, results, ignored);
}

// Reads the optional notsobigdataCompileManifest global, same guarded
// pattern and shape as resolveManifestConfig() above - a deliberately
// separate global, not a second field on notsobigdataManifest, so
// configuring (or disabling) the compile manifest can never accidentally
// touch the run manifest's own settings. Different default fileName for
// the same reason: the two are meant to coexist as two files, not fight
// over one.
function resolveCompileManifestConfig() {
  var raw = readOptionalGlobal('notsobigdataCompileManifest');
  var config = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled: config.enabled !== false,
    folderId: typeof config.folderId === 'string' && config.folderId ? config.folderId : null,
    fileName: typeof config.fileName === 'string' && config.fileName ? config.fileName : 'notsobigdata-compile-manifest.json'
  };
}

// cli('compile')'s counterpart to writeManifest() above - same
// writeManifestFile() call, to its own file via resolveCompileManifestConfig()
// rather than resolveManifestConfig(). A compile pass never touches
// BigQuery/Sheets/Drive, so it must never overwrite the run manifest's own
// record of what the last real run actually did - see docs/cli.md's "The
// compile manifest" for the user-facing version of this reasoning, and
// writeManifestFile()'s own comment above for how the same-target case is
// now caught rather than silently allowed.
function writeCompileManifest(commandText, ok, results, ignored) {
  return writeManifestFile('COMPILE MANIFEST', resolveCompileManifestConfig(), resolveManifestConfig(), commandText, ok, results, ignored);
}

// cli('debug') - a diagnostic, non-mutating check of whether the current
// Apps Script project's OAuth scopes / Advanced Services actually cover
// what each declared node's connector needs.
//
// This exists because of the eval() scoping gotcha documented in
// CLAUDE.md: Apps Script auto-detects required OAuth scopes and Advanced
// Services by statically scanning a project's own .gs files. Code that
// arrives via eval(UrlFetchApp.fetch(...).getContentText()) was never in
// those files, so a call this library makes from inside that eval'd text -
// to DriveApp, SpreadsheetApp, BigQuery, UrlFetchApp - can be invisible to
// that scan. The consuming project's appsscript.json can end up missing a
// scope nobody was ever shown a prompt to grant. cli('debug') probes each
// connector for real (safely - see below) so that gap turns into a clear
// message here instead of a bare permission error surfacing deep inside a
// real move()/model() run.
//
// Safety rule, load-bearing: a debug check must never trigger a write.
// A source connector's probe is (as close as possible to) the real read
// call, since a source is already read-only by contract. A target
// connector's probe is a read-only stand-in for the same resource instead
// - open it, don't write to it. probeApi's target case is the one
// deliberate compromise: loadApi (move.js) always POSTs a JSON body, so
// probing a target sends a GET instead. That means a POST-only endpoint
// reads back as reachable-but-non-2xx rather than as an auth failure -
// fetchProbe() below treats any HTTP response at all, regardless of
// status code, as proof UrlFetchApp itself is authorized, and leaves the
// status code out of the ok/not-ok decision entirely.
var SCOPE_ERROR_PATTERN = /permission|scope|not authorized|unauthorized|PERMISSION_DENIED|insufficient/i;

// The message every 'missing_scope'/'service_not_enabled' check ends with.
// kind is a short phrase naming what to add ("an oauthScopes entry",
// "the BigQuery Advanced Service") so the same explanation reads right
// in both callers below.
function evalScopingHint(kind) {
  return 'Apps Script only auto-adds OAuth scopes/Advanced Services by scanning a project\'s own .gs files for the calls that need them - it can\'t see calls made from code installed via eval(), which is how notsobigdata loads. Add ' + kind + ' by hand in the Apps Script editor (Project Settings > "Show appsscript.json") rather than expecting an authorization prompt to add it for you.';
}

function classifyProbeError(error, type, role) {
  var message = error && error.message ? error.message : String(error);
  if (SCOPE_ERROR_PATTERN.test(message)) {
    return { status: 'missing_scope', message: type + ' ' + role + ': ' + message + ' - ' + evalScopingHint('the missing oauthScopes entry') };
  }
  return { status: 'error', message: type + ' ' + role + ': ' + message };
}

function bigQueryServiceNotEnabledMessage() {
  return 'BigQuery is not available as a "BigQuery" service in this project, so the Advanced BigQuery Service isn\'t enabled - a separate switch from OAuth scopes (Apps Script editor > Services > add "BigQuery API", and confirm the BigQuery API is enabled on the linked GCP project). ' + evalScopingHint('the BigQuery Advanced Service');
}

// Shared by probeUrl and probeApi. Always forces a GET and always mutes
// HTTP exceptions: the status code is deliberately irrelevant to whether
// this counts as 'ok' (see the module comment above) - only a thrown
// error means UrlFetchApp itself couldn't make the call. method/payload
// are stripped out of options rather than merged in, so a target's own
// POST configuration can never leak through and turn a probe into a
// second real write.
function fetchProbe(url, options, type, role) {
  var fetchOptions = { method: 'get', muteHttpExceptions: true };
  if (options) {
    Object.keys(options).forEach(function (key) {
      if (key !== 'method' && key !== 'payload') {
        fetchOptions[key] = options[key];
      }
    });
  }
  try {
    var response = UrlFetchApp.fetch(url, fetchOptions);
    return { status: 'ok', message: 'UrlFetchApp reached ' + url + ' (HTTP ' + response.getResponseCode() + ').' };
  } catch (error) {
    return classifyProbeError(error, type, role);
  }
}

function probeSheets(role, config) {
  if (!config.spreadsheetId) {
    return { status: 'error', message: 'sheets ' + role + ' has no "spreadsheetId" to check.' };
  }
  try {
    SpreadsheetApp.openById(config.spreadsheetId);
    return { status: 'ok', message: 'opened spreadsheet ' + config.spreadsheetId + '.' };
  } catch (error) {
    return classifyProbeError(error, 'sheets', role);
  }
}

function probeDrive(role, config) {
  if (config.fileId) {
    try {
      DriveApp.getFileById(config.fileId);
      return { status: 'ok', message: 'opened Drive file ' + config.fileId + '.' };
    } catch (error) {
      return classifyProbeError(error, 'drive', role);
    }
  }
  if (config.folderId) {
    try {
      DriveApp.getFolderById(config.folderId);
      return { status: 'ok', message: 'opened Drive folder ' + config.folderId + '.' };
    } catch (error) {
      return classifyProbeError(error, 'drive', role);
    }
  }
  return { status: 'error', message: 'drive ' + role + ' has neither "fileId" nor "folderId" to check.' };
}

// dataset is optional on a bigquery *source* (a "query"/"queryFileId" mode
// source has a projectId but no particular dataset to name - see
// resolveBigQuerySql in move.js) but always present on a target and on a
// resolved model config. When there's no dataset to check, this falls back
// to listing one page of datasets in the project - still a real,
// scope-sensitive call, just not scoped to one dataset.
function probeBigQuery(role, config) {
  if (typeof BigQuery === 'undefined') {
    return { status: 'service_not_enabled', message: bigQueryServiceNotEnabledMessage() };
  }
  if (!config.projectId) {
    return { status: 'error', message: 'bigquery ' + role + ' has no "projectId" to check.' };
  }
  try {
    if (config.dataset) {
      BigQuery.Datasets.get(config.projectId, config.dataset);
      return { status: 'ok', message: 'read dataset metadata for ' + config.projectId + '.' + config.dataset + '.' };
    }
    BigQuery.Datasets.list(config.projectId, { maxResults: 1 });
    return { status: 'ok', message: 'listed datasets in project ' + config.projectId + '.' };
  } catch (error) {
    return classifyProbeError(error, 'bigquery', role);
  }
}

// A url source is always a GET (extractUrl in move.js never writes), so
// this probe is the real call, github-blob rewrite included - the same
// request a real run would make.
function probeUrl(role, config) {
  if (!config.url) {
    return { status: 'error', message: 'url ' + role + ' has no "url" to check.' };
  }
  return fetchProbe(rewriteGithubBlobUrl(config.url), config.options, 'url', role);
}

// An api source is a real GET too (extractApi), so this probe is exactly
// that call. An api target's real call (loadApi) is always a POST with a
// JSON body - fetchProbe forces a GET instead, the one deliberate
// compromise described in this section's module comment above.
function probeApi(role, config) {
  if (!config.url) {
    return { status: 'error', message: 'api ' + role + ' has no "url" to check.' };
  }
  return fetchProbe(config.url, config.options, 'api', role);
}

function probeCustom(role) {
  return { status: 'unverifiable', message: 'custom ' + role + ' calls your own "fn" - cli(\'debug\') has no way to know what services it uses.' };
}

// Keyed by connector type (source.type/target.type - the same six strings
// extract()/load() in move.js switch on), parallel to EXECUTORS/COMPILERS
// above: one small map per question this module can answer about a kind
// or a connector, rather than one map trying to answer all of them.
var DEBUG_PROBES = {
  sheets: probeSheets,
  drive: probeDrive,
  bigquery: probeBigQuery,
  api: probeApi,
  url: probeUrl,
  custom: probeCustom
};

// Pulls (role, type, config) probe tuples out of one discovered node. A
// model node never carries a source/target shape at all - its single
// implicit tuple is built from the projectId/dataset resolveModelConfig()
// (model.js) already resolved onto every model node's config, the same
// two fields a real bigquery target requires and probeBigQuery already
// expects. One nuance: expandModelNodes() only attaches that resolved
// config to the node once every discovery-time check (SQL file read,
// {{ }} validation, ref() resolution) has already passed - a model with a
// discoveryError keeps the placeholder { name: name } config it started
// with, so this reports 'error' (no projectId to check) for a broken
// model rather than silently skipping it or crashing.
function connectorTuplesForNode(node) {
  if (node.kind === 'model') {
    return [{ role: 'target', type: 'bigquery', config: { projectId: node.config.projectId, dataset: node.config.dataset } }];
  }
  var tuples = [];
  if (isPlainObject(node.config.source) && typeof node.config.source.type === 'string') {
    tuples.push({ role: 'source', type: node.config.source.type, config: node.config.source });
  }
  if (isPlainObject(node.config.target) && typeof node.config.target.type === 'string') {
    tuples.push({ role: 'target', type: node.config.target.type, config: node.config.target });
  }
  return tuples;
}

// Runs every connector check for one selected node. Deliberately
// independent of every other node's status - unlike runNodes()'s
// run/list/compile branches, this never consults a `blocked` map: the
// whole point of cli('debug') is surfacing every connector problem in one
// pass, not respecting dependency order, which a diagnostic dry run has
// no use for in the first place.
function debugNode(node) {
  return connectorTuplesForNode(node).map(function (tuple) {
    var probe = DEBUG_PROBES[tuple.type];
    var outcome = probe
      ? probe(tuple.role, tuple.config)
      : { status: 'error', message: 'unknown connector type "' + tuple.type + '".' };
    return { node: node.name, kind: node.kind, role: tuple.role, type: tuple.type, status: outcome.status, message: outcome.message };
  });
}

function runDebugChecks(nodes) {
  var checks = [];
  nodes.forEach(function (node) {
    debugNode(node).forEach(function (check) {
      checks.push(check);
      var label = nodeLabel(node) + ' ' + check.role + ' (' + check.type + ')';
      if (check.status === 'ok') {
        Logger.log('OK    ' + label + ' - ' + check.message);
      } else if (check.status === 'unverifiable') {
        Logger.log('SKIP  ' + label + ' - ' + check.message);
      } else {
        Logger.log('FAIL  ' + label + ' - ' + check.message);
      }
    });
  });
  return checks;
}

// formatStatusCounts()'s counterpart for a debug report's check statuses
// rather than a run report's node statuses - same "only render non-zero
// counts" reasoning, kept separate since the two status vocabularies
// don't overlap (a check is never 'success'/'skipped'/'planned').
function formatDebugStatusCounts(checks) {
  var counts = { ok: 0, missing_scope: 0, service_not_enabled: 0, error: 0, unverifiable: 0 };
  checks.forEach(function (check) { counts[check.status] += 1; });
  var labels = { ok: 'ok', missing_scope: 'missing scope', service_not_enabled: 'service not enabled', error: 'error', unverifiable: 'unverifiable' };
  var parts = Object.keys(labels)
    .filter(function (status) { return counts[status] > 0; })
    .map(function (status) { return counts[status] + ' ' + labels[status]; });
  return parts.length ? parts.join(', ') : 'nothing to check';
}

// The smoke test. This is the first thing to run when anything looks
// wrong, so it is the one command that never throws: it has to be able
// to report "I found nothing" as a finding rather than as a failure,
// and it deliberately checks both fragile things at once - that the
// eval() install put the library in scope at all, and that the global
// scan can see the caller's declared nodes.
function hello() {
  var lines = ['notsobigdata loaded OK. Kinds available: ' + knownKinds().join(', ') + '.'];
  var discovered = null;
  try {
    discovered = discoverNodes();
  } catch (error) {
    lines.push('But discovering nodes failed: ' + error.message);
  }
  // Single exit below rather than an early return on the failure path, so
  // there is only one place that decides how this message is logged and
  // returned - two copies of that tail would drift the first time the
  // format changes.
  if (discovered && discovered.nodes.length) {
    lines.push('Discovered ' + discovered.nodes.length + ' node(s): ' + discovered.nodes.map(nodeLabel).join(', ') + '.');
  } else if (discovered) {
    lines.push('Discovered 0 nodes. If you expected some, check they are declared as top-level "var"s - a config object declared inside a function is invisible to cli().');
  }
  if (discovered && discovered.ignored.length) {
    lines.push('Ignored ' + discovered.ignored.length + ' object(s) with an unknown kind: ' + discovered.ignored.map(function (node) {
      return node.variable + ' (kind: "' + node.kind + '")';
    }).join(', ') + '.');
  }
  var message = lines.join('\n');
  Logger.log(message);
  return message;
}

// The single public entrypoint. Takes one command string and returns
// either a run report (for "run"/"list"/"compile") or a message string
// (for "hello"/"help").
//
// Logs "START"/"DONE" bookends around every call, padded to the same
// six characters as runNodes()'s own "OK"/"FAIL"/"SKIP"/"PLAN" labels so
// every line in the execution log lines up. "START" is the very first
// thing this function does, before parseCommand() - so a call that
// throws immediately (an unknown command, zero discovered nodes) still
// leaves a marker that cli() actually ran, not silence up to the error.
// "DONE" only fires for "run"/"list"/"compile": hello()/help() already log
// their own single result line and have no per-node pass/fail/skip status
// to roll up. Both are pure Logger.log side effects - report is unchanged.
function cli(input) {
  Logger.log('START cli("' + input + '")');
  var parsed = parseCommand(input);
  if (parsed.command === 'help') {
    var helpText = usage();
    Logger.log(helpText);
    return helpText;
  }
  if (parsed.command === 'hello') {
    return hello();
  }
  var discovered = discoverNodes();
  if (!discovered.nodes.length) {
    throw new Error('cli(): found no declared nodes. Config objects must be declared as top-level "var"s marked with a "kind" - one declared inside a function is invisible to cli(). Run cli("hello") to see what the library can find.');
  }
  assertDependenciesExist(discovered.nodes);
  var selected = applySelection(discovered.nodes, parsed.select, parsed.exclude);
  if (!selected.length) {
    throw new Error('cli(): the selection matched no nodes. Run cli("list") to see everything available.');
  }
  // debug diverges from run/list/compile right here, before orderNodes():
  // it checks every selected node's connector independently of every
  // other node's status, so it has no use for dependency order or the
  // blocked-node skip logic runNodes() applies to the other three
  // commands - see runDebugChecks()'s own comment above.
  if (parsed.command === 'debug') {
    var checks = runDebugChecks(selected);
    var debugOk = checks.every(function (check) { return check.status === 'ok' || check.status === 'unverifiable'; });
    Logger.log('DONE  cli("' + input + '") - ' + formatDebugStatusCounts(checks) + ' (' + checks.length + ' total).');
    return { ok: debugOk, command: 'debug', checks: checks, ignored: discovered.ignored };
  }
  var ordered = orderNodes(selected);
  var results = runNodes(ordered, parsed.command, resolveLoggingConfig().verbose);
  var ok = results.every(function (result) { return result.status !== 'failed' && result.status !== 'skipped'; });
  Logger.log('DONE  cli("' + input + '") - ' + formatStatusCounts(results) + ' (' + results.length + ' total).');
  var report = {
    ok: ok,
    command: parsed.command,
    nodes: results,
    ignored: discovered.ignored
  };
  // "run" and "compile" each write their own manifest; "list" writes
  // neither - it's a pure dry run with nothing, not even compiled SQL, to
  // record. "compile" gets a *separate* file from "run" (writeCompileManifest,
  // not writeManifest) rather than sharing one: a compile pass never
  // touches BigQuery/Sheets/Drive, so it must never overwrite the run
  // manifest's own record of what the last real run actually did.
  if (parsed.command === 'run') {
    report.manifest = writeManifest(input, ok, results, discovered.ignored);
  } else if (parsed.command === 'compile') {
    report.manifest = writeCompileManifest(input, ok, results, discovered.ignored);
  }
  return report;
}
