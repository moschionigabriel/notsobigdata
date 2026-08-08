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
// kind-agnostic only for kinds whose edges are hand-written. discoverNodes()
// below reads dependencies straight off config.dependsOn, and the planned
// model kind derives its edges by parsing {{ ref() }} out of its SQL
// instead. So adding model() means an entry here *plus* a per-kind hook for
// deriving dependsOn. That hook doesn't exist yet - it isn't written
// speculatively, because the kind that needs it isn't written either, and
// guessing its shape now is how you get the wrong abstraction.
var EXECUTORS = {
  move: move
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

// Node lists appear in three different error messages and in hello()'s
// output. Going through one helper keeps them rendering identically by
// construction rather than by coincidence.
function nodeNames(nodes) {
  return nodes.map(function (node) { return node.name; });
}

var COMMANDS = ['run', 'list', 'hello', 'help'];

function usage() {
  return [
    'notsobigdata commands:',
    '',
    '  cli("run")                     run every declared node, in dependency order',
    '  cli("run --select move")       run only nodes of a given kind',
    '  cli("run --select a,b")        run only the named nodes',
    '  cli("run --exclude a")         run everything except the named nodes',
    '  cli("list")                    show what would run, in order, without running it',
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
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
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
    if (has(claimedNames, name)) {
      throw new Error('cli(): two nodes are both named "' + name + '" (declared as "' + claimedNames[name] + '" and "' + key + '"). Node names must be unique - set an explicit "name" on one of them.');
    }
    claimedNames[name] = key;
    if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
      throw new Error('cli(): node "' + name + '" has a "dependsOn" that is not an array - got ' + typeof dependsOn + '.');
    }
    // Normalized once, here, so "no dependsOn means no edges" is stated in
    // one place instead of at each use. The copy matters: the node's edges
    // must not alias the caller's array, which they could mutate later.
    var edges = dependsOn ? dependsOn.slice() : [];
    edges.forEach(function (dependency) {
      if (typeof dependency !== 'string' || !dependency) {
        throw new Error('cli(): node "' + name + '" has a "dependsOn" entry that is not a node name string.');
      }
    });
    nodes.push({
      name: name,
      kind: kind,
      variable: key,
      config: value,
      dependsOn: edges
    });
  });
  return { nodes: nodes, ignored: ignored };
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
// Every node gets its own START/outcome bookend pair - START right before
// it's handled, then OK/FAIL/SKIP/PLAN once its outcome is known - mirroring
// the START/DONE pair cli() itself logs around the whole call below. Without
// a per-node START, a human watching the Apps Script log during a long run
// can only see which nodes have already finished, never which one is
// currently in flight. START logs unconditionally, even for nodes that turn
// out skipped or merely planned, so every node in the ordered list produces
// a matching pair - not just the ones that reach EXECUTORS.
function runNodes(nodes, dryRun) {
  var results = [];
  var blocked = emptyMap();
  nodes.forEach(function (node) {
    Logger.log('START ' + node.name + ' (' + node.kind + ')');
    var blockers = node.dependsOn.filter(function (dependency) { return has(blocked, dependency); });
    if (blockers.length) {
      blocked[node.name] = true;
      results.push({ name: node.name, kind: node.kind, status: 'skipped', blockedBy: blockers });
      Logger.log('SKIP  ' + node.name + ' (' + node.kind + ') - waiting on ' + blockers.join(', '));
      return;
    }
    if (dryRun) {
      results.push({ name: node.name, kind: node.kind, status: 'planned' });
      Logger.log('PLAN  ' + node.name + ' (' + node.kind + ')');
      return;
    }
    var startedAt = new Date().getTime();
    try {
      var result = EXECUTORS[node.kind](node.config);
      var elapsed = new Date().getTime() - startedAt;
      results.push({ name: node.name, kind: node.kind, status: 'success', ms: elapsed, result: result });
      Logger.log('OK    ' + node.name + ' (' + node.kind + ') - ' + (Array.isArray(result) ? result.length + ' rows, ' : '') + elapsed + 'ms');
    } catch (error) {
      blocked[node.name] = true;
      results.push({ name: node.name, kind: node.kind, status: 'failed', ms: new Date().getTime() - startedAt, error: error.message });
      Logger.log('FAIL  ' + node.name + ' (' + node.kind + ') - ' + error.message);
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
  var raw;
  try {
    raw = globalThis.notsobigdataManifest;
  } catch (error) {
    raw = undefined;
  }
  var config = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled: config.enabled !== false,
    folderId: typeof config.folderId === 'string' && config.folderId ? config.folderId : null,
    fileName: typeof config.fileName === 'string' && config.fileName ? config.fileName : 'notsobigdata-manifest.json'
  };
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
// the result (an array of rows, or an object carrying loadResult/
// testResults) - the same shape every EXECUTORS entry already produces.
// The raw rows are never included, only their size - a manifest is an
// observability artifact, not a second copy of the data that already
// landed at its real destination.
function summarizeNodeResult(result) {
  var summary = { name: result.name, kind: result.kind, status: result.status };
  if (result.status === 'skipped') {
    summary.blockedBy = result.blockedBy;
  } else if (result.status === 'failed') {
    summary.ms = result.ms;
    summary.error = result.error;
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

// Writes the run manifest to Drive, overwriting the same file every time
// (found by name via upsertByName, never a fresh file per run - creating
// one per run is exactly the pattern that piled up duplicate fixture
// files in the test project before, see CLAUDE.md's "About testing").
// Best-effort: a Drive failure here must never throw or affect the
// node results actually being reported, so every path is caught and
// turned into one of three report.manifest shapes instead.
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
function writeManifest(commandText, ok, results, ignored) {
  var config = resolveManifestConfig();
  if (!config.enabled) {
    Logger.log('MANIFEST skipped - notsobigdataManifest.enabled is false');
    return { written: false, reason: 'disabled' };
  }
  try {
    var folderId = resolveManifestFolderId(config.folderId);
    var manifest = buildManifest(commandText, ok, results, ignored);
    var target = { folderId: folderId, fileName: config.fileName, upsertByName: true };
    var fileId = resolveDriveWriteTarget(target);
    fileId = writeDriveText(fileId, target, JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT);
    Logger.log('MANIFEST written to ' + fileId);
    return { written: true, fileId: fileId };
  } catch (error) {
    Logger.log('MANIFEST failed - ' + error.message);
    return { written: false, reason: 'error', error: error.message };
  }
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
    lines.push('Discovered ' + discovered.nodes.length + ' node(s): ' + discovered.nodes.map(function (node) {
      return node.name + ' (' + node.kind + ')';
    }).join(', ') + '.');
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
// either a run report (for "run"/"list") or a message string (for
// "hello"/"help").
//
// Logs "START"/"DONE" bookends around every call, padded to the same
// six characters as runNodes()'s own "OK"/"FAIL"/"SKIP"/"PLAN" labels so
// every line in the execution log lines up. "START" is the very first
// thing this function does, before parseCommand() - so a call that
// throws immediately (an unknown command, zero discovered nodes) still
// leaves a marker that cli() actually ran, not silence up to the error.
// "DONE" only fires for "run"/"list": hello()/help() already log their
// own single result line and have no per-node pass/fail/skip status to
// roll up. Both are pure Logger.log side effects - report is unchanged.
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
  var ordered = orderNodes(selected);
  var results = runNodes(ordered, parsed.command === 'list');
  var ok = results.every(function (result) { return result.status !== 'failed' && result.status !== 'skipped'; });
  Logger.log('DONE  cli("' + input + '") - ' + formatStatusCounts(results) + ' (' + results.length + ' total).');
  var report = {
    ok: ok,
    command: parsed.command,
    nodes: results,
    ignored: discovered.ignored
  };
  // Only "run" writes a manifest - "list" is a dry run where nothing
  // executed, and overwriting the last real run's record with a no-op
  // would defeat the "reflects what actually happened" point of it.
  if (parsed.command === 'run') {
    report.manifest = writeManifest(input, ok, results, discovered.ignored);
  }
  return report;
}
