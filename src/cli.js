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
  if (typeof input !== 'string' || !input.replace(/\s/g, '')) {
    throw new Error('cli(): a command is required, e.g. cli("run").\n\n' + usage());
  }
  var tokens = input.replace(/^\s+|\s+$/g, '').split(/\s+/);
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
      .map(function (item) { return item.replace(/^\s+|\s+$/g, ''); })
      .filter(function (item) { return !!item; });
    if (!list.length) {
      throw new Error('cli(): "' + flag + '" needs a comma-separated value, e.g. ' + flag + ' orders,customers.');
    }
    parsed[flag === '--select' ? 'select' : 'exclude'] =
      parsed[flag === '--select' ? 'select' : 'exclude'].concat(list);
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
  var claimedNames = {};
  keys.forEach(function (key) {
    var value;
    try {
      value = scope[key];
    } catch (error) {
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    var kind;
    var declaredName;
    var dependsOn;
    try {
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
    (dependsOn || []).forEach(function (dependency) {
      if (typeof dependency !== 'string' || !dependency) {
        throw new Error('cli(): node "' + name + '" has a "dependsOn" entry that is not a node name string.');
      }
    });
    nodes.push({
      name: name,
      kind: kind,
      variable: key,
      config: value,
      dependsOn: (dependsOn || []).slice()
    });
  });
  return { nodes: nodes, ignored: ignored };
}

// Every dependsOn entry must name a node that actually exists. Checked
// against everything discovered, not just the current selection, so
// "--select" narrowing what runs never turns a real typo into a
// silently-ignored dependency.
function assertDependenciesExist(nodes) {
  var byName = {};
  nodes.forEach(function (node) { byName[node.name] = true; });
  nodes.forEach(function (node) {
    node.dependsOn.forEach(function (dependency) {
      if (!has(byName, dependency)) {
        throw new Error('cli(): node "' + node.name + '" dependsOn "' + dependency + '", which is not a declared node. Known nodes: ' + Object.keys(byName).join(', ') + '.');
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
  if (byKind.length) {
    return byKind.map(function (node) { return node.name; });
  }
  var byName = nodes.filter(function (node) { return node.name === token; });
  if (byName.length) {
    return byName.map(function (node) { return node.name; });
  }
  throw new Error('cli(): "' + token + '" matched no kind and no node name. Kinds: ' + knownKinds().join(', ') + '. Nodes: ' + nodes.map(function (node) { return node.name; }).join(', ') + '.');
}

// Applies --select then --exclude. Note --select selects exactly what it
// names: it does not pull in upstream dependencies, which are assumed to
// have run already. (dbt spells that distinction "orders" vs "+orders";
// the "+" operators are deliberately left out of this first version.)
function applySelection(nodes, select, exclude) {
  var selected = nodes;
  if (select.length) {
    var wanted = {};
    select.forEach(function (token) {
      resolveSelector(nodes, token).forEach(function (name) { wanted[name] = true; });
    });
    selected = selected.filter(function (node) { return has(wanted, node.name); });
  }
  if (exclude.length) {
    var unwanted = {};
    exclude.forEach(function (token) {
      resolveSelector(nodes, token).forEach(function (name) { unwanted[name] = true; });
    });
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
  var byName = {};
  var waitingOn = {};
  var dependents = {};
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
    var stuck = nodes
      .filter(function (node) { return ordered.indexOf(node) === -1; })
      .map(function (node) { return node.name; });
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
function runNodes(nodes, dryRun) {
  var results = [];
  var blocked = {};
  nodes.forEach(function (node) {
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

// The smoke test. This is the first thing to run when anything looks
// wrong, so it is the one command that never throws: it has to be able
// to report "I found nothing" as a finding rather than as a failure,
// and it deliberately checks both fragile things at once - that the
// eval() install put the library in scope at all, and that the global
// scan can see the caller's declared nodes.
function hello() {
  var lines = ['notsobigdata loaded OK. Kinds available: ' + knownKinds().join(', ') + '.'];
  var discovered;
  try {
    discovered = discoverNodes();
  } catch (error) {
    lines.push('But discovering nodes failed: ' + error.message);
    var failureMessage = lines.join('\n');
    Logger.log(failureMessage);
    return failureMessage;
  }
  if (discovered.nodes.length) {
    lines.push('Discovered ' + discovered.nodes.length + ' node(s): ' + discovered.nodes.map(function (node) {
      return node.name + ' (' + node.kind + ')';
    }).join(', ') + '.');
  } else {
    lines.push('Discovered 0 nodes. If you expected some, check they are declared as top-level "var"s - a config object declared inside a function is invisible to cli().');
  }
  if (discovered.ignored.length) {
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
function cli(input) {
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
  return {
    ok: results.every(function (result) { return result.status !== 'failed' && result.status !== 'skipped'; }),
    command: parsed.command,
    nodes: results,
    ignored: discovered.ignored
  };
}
