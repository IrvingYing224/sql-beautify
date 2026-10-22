#!/usr/bin/env node
'use strict';

// Golden snapshot runner: the formatting spec for 3.0 (docs/technical/3.0-refactor-plan.md §6 P1).
// Usage: node tests/golden/run.js [--update] [--filter s] [--private <dir>] [--fuzz N]
// Requires a fresh `.tmp/v2-core` (node scripts/build-v2-core.js).

var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var casesDir = path.join(__dirname, 'cases');
var snapshotPath = path.join(__dirname, 'snapshot.json');
var knownIssuesPath = path.join(__dirname, 'known-issues.json');
var core = path.join(root, '.tmp', 'v2-core');

var format = require(path.join(core, 'core', 'api', 'format.js'));
var lexer = require(path.join(core, 'core', 'lexer', 'index.js'));
var analyze = require(path.join(core, 'core', 'analysis', 'analyze.js'));
var contract = require(path.join(core, 'core', 'syntax', 'contextual-fact-contract.js'));
var environment = require(path.join(core, 'core', 'renderer', 'environment.js'));
var hiveDdl = require(path.join(core, 'experimental', 'ddl', 'hive-ddl.js'));
var extract = require(path.join(core, 'experimental', 'ddl', 'extract.js'));
var ddlTransaction = require(path.join(core, 'adapters', 'transaction', 'experimental-ddl.js'));

var HEADER = '-- golden: ';
var FIELDS = ['op', 'options', 'mode', 'newline', 'tabSize', 'startColumn'];
var OPS = ['formatSql', 'formatHiveDdl', 'extractDdl'];
var DIALECTS = ['generic', 'hive', 'postgresql', 'mysql'];
var WAIVABLE = ['token', 'glue', 'idempotence'];
var WORD = { keyword: true, identifier: true, number: true, parameter: true };
var STOP = { ',': true, '(': true, ')': true, ';': true };

function parseArgs(argv) {
    var args = { update: false, filter: null, privateDir: null, fuzz: 0 };
    for (var i = 0; i < argv.length; i++) {
        if (argv[i] === '--update') {
            args.update = true;
        } else if (argv[i] === '--filter' && i + 1 < argv.length) {
            args.filter = argv[++i];
        } else if (argv[i] === '--private' && i + 1 < argv.length) {
            args.privateDir = path.resolve(argv[++i]);
        } else if (argv[i] === '--fuzz' && /^\d+$/.test(argv[i + 1] || '')) {
            args.fuzz = Number(argv[++i]);
        } else {
            throw new Error('usage: run.js [--update] [--filter s] [--private <dir>] [--fuzz N]');
        }
    }
    return args;
}

function readJson(file, fallback) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeSortedJson(file, value) {
    var sorted = {};
    Object.keys(value).sort().forEach(function(key) { sorted[key] = value[key]; });
    fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
}

function walk(dir, suffix) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir, { withFileTypes: true }).sort(function(a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }).reduce(function(files, entry) {
        var full = path.join(dir, entry.name);
        return files.concat(entry.isDirectory() ? walk(full, suffix)
            : entry.name.endsWith(suffix) ? [full] : []);
    }, []);
}

// Strips exactly one leading `-- golden: {...}\n` line; BOM and CRLF bodies stay byte-exact.
function readCase(file, key) {
    var raw = fs.readFileSync(file, 'utf8');
    var header = {};
    var source = raw;
    if (raw.startsWith(HEADER)) {
        var end = raw.indexOf('\n');
        if (end < 0 || raw.charAt(end - 1) === '\r') {
            throw new Error(key + ': header line must end with a bare \\n');
        }
        header = JSON.parse(raw.slice(HEADER.length, end));
        source = raw.slice(end + 1);
    }
    function checkFields(fields, allowVariants) {
        Object.keys(fields).forEach(function(field) {
            if (!(allowVariants && field === 'variants') && FIELDS.indexOf(field) < 0) {
                throw new Error(key + ': unknown header field ' + field);
            }
        });
    }
    checkFields(header, true);
    var base = {};
    FIELDS.forEach(function(field) {
        if (header[field] !== undefined) {
            base[field] = header[field];
        }
    });
    var variants = header.variants === undefined ? null : header.variants;
    var runs = variants === null
        ? [{ key: key, spec: base }]
        : Object.keys(variants).sort().map(function(name) {
            checkFields(variants[name], false);
            return { key: key + '#' + name, spec: Object.assign({}, base, variants[name]) };
        });
    return runs.map(function(run) {
        var suffix = run.key === key ? '' : '.' + run.key.slice(key.length + 1);
        return {
            key: run.key,
            source: source,
            spec: run.spec,
            outFile: path.join(casesDir, key + suffix + '.out.txt'),
        };
    });
}

// Defaults match the adapter: document mode, tab size 4, column 0, newline inferred from the text.
function resolveEnvironment(spec, source) {
    var op = spec.op === undefined ? 'formatSql' : spec.op;
    if (OPS.indexOf(op) < 0) {
        throw new Error('unknown op ' + op);
    }
    return {
        op: op,
        options: spec.options,
        mode: spec.mode === undefined ? 'document' : spec.mode,
        newline: spec.newline === undefined
            ? environment.inferRenderNewline(source, '\n')
            : spec.newline,
        tabSize: spec.tabSize === undefined ? environment.DEFAULT_RENDER_TAB_SIZE : spec.tabSize,
        startColumn: spec.startColumn === undefined ? 0 : spec.startColumn,
    };
}

function codesOf(diagnostics) {
    return diagnostics.map(function(value) { return value.code; });
}

// DDL goes through the adapter transaction so the text is the final, newline-normalized replacement;
// status and codes are the operation's own. startColumn is modelled as that many spaces before the
// target on its line. Adapter codes are added only when the adapter drops an editable result.
async function runDdl(source, env) {
    var prefix = ' '.repeat(env.startColumn);
    var document = { identity: {}, source: prefix + source, version: 1 };
    var execute = env.op === 'formatHiveDdl' ? hiveDdl.executeFormatHiveDdl : extract.executeExtractDdl;
    var raw = null;
    var edits = [];
    var transaction = await ddlTransaction.runExperimentalDdlTransaction({
        document: document,
        targets: [{ id: 'golden', start: prefix.length, end: document.source.length }],
        newline: env.newline,
        tabSize: env.tabSize,
    }, function(text, context) {
        raw = execute(text, env.options, false, context.tabSize, context.startColumn);
        return raw;
    }, {
        currentDocument: function() { return document; },
        apply: function(prepared) {
            edits = prepared.edits;
            return Promise.resolve(true);
        },
    });
    var text = document.source;
    edits.slice().sort(function(a, b) { return b.start - a.start; }).forEach(function(edit) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    });
    if (raw === null) {
        // The transaction rejected the target (e.g. a lexical error) before running the operation.
        raw = execute(source, env.options, false, env.tabSize, env.startColumn);
    }
    var codes = codesOf(raw.diagnostics);
    if (transaction.status === 'rejected' && (raw.status === 'formatted' || raw.status === 'extracted')) {
        codes = codes.concat(codesOf(transaction.diagnostics));
    }
    return { text: text.slice(prefix.length), status: raw.status, codes: codes };
}

async function execute(source, spec) {
    var env = resolveEnvironment(spec, source);
    if (env.op !== 'formatSql') {
        return runDdl(source, env);
    }
    var result = format.executeFormatSql(
        source, env.options, env.mode, env.newline, false, env.tabSize
    ).result;
    return { text: result.text, status: result.status, codes: codesOf(result.diagnostics) };
}

function codeLeaves(source, dialect) {
    var leaves = [];
    var gap = true;
    lexer.lexSql(source, { dialect: dialect }).leaves.forEach(function(leaf) {
        if (leaf.kind === 'whitespace' || leaf.kind === 'newline') {
            gap = true;
            return;
        }
        leaves.push({ id: leaf.id, kind: leaf.kind, channel: leaf.channel, raw: leaf.raw, gap: gap });
        gap = false;
    });
    return leaves;
}

function absorbable(leaf) {
    return leaf.kind !== 'line-comment' && leaf.kind !== 'block-comment' &&
        !(leaf.kind === 'punctuation' && STOP[leaf.raw]);
}

function describe(leaves, index) {
    return JSON.stringify(leaves.slice(Math.max(0, index - 1), index + 1).map(function(leaf) {
        return leaf.raw;
    }));
}

// Indexes into the input code leaves whose case formatSql may change: the CST keyword roles
// that the runtime token check accepts (src/core/api/format.ts).
function sqlCaseAuthorized(source, dialect, mode, a) {
    var analysis = analyze.analyzeSql(source, { dialect: dialect, mode: mode });
    var allowed = new Set();
    a.forEach(function(leaf, index) {
        if (analysis.leaves[leaf.id].raw !== leaf.raw) {
            throw new Error('analysis leaves differ from lexer leaves at ' + leaf.id);
        }
        var syntax = analysis.index ? analysis.index.leafContext(leaf.id).syntax : null;
        if (leaf.channel === 'code' && syntax !== null && syntax.keywordCaseEligible === true &&
            contract.isKeywordCaseRole(syntax.syntaxRole)) {
            allowed.add(index);
        }
    });
    return allowed;
}

// formatHiveDdl may change the case of its header and suffix keywords, `COMMENT` and builtin type
// names; table, column and struct field names stay verbatim.
function ddlCaseAuthorized(a) {
    var allowed = new Set();
    var i = 0;
    function take(word) {
        if (i < a.length && a[i].raw.toLowerCase() === word) {
            allowed.add(i++);
            return true;
        }
        return false;
    }
    take('create');
    take('external');
    take('table');
    if (take('if')) {
        take('not');
        take('exists');
    }
    var depth = 0;
    var listSeen = false;
    var itemStart = false;
    for (; i < a.length; i++) {
        var raw = a[i].raw.toLowerCase();
        if (raw === '(' || raw === '<') {
            depth += 1;
            listSeen = true;
            itemStart = depth === 1;
            continue;
        }
        if (raw === ')' || raw === '>' || raw === '>>') {
            depth -= raw === '>>' ? 2 : 1;
            continue;
        }
        if (raw === ',') {
            itemStart = depth === 1;
            continue;
        }
        var name = !listSeen || itemStart || (i + 1 < a.length && a[i + 1].raw === ':');
        itemStart = false;
        if (!name && (depth === 0 || raw === 'comment' || contract.isBuiltinTypeName(raw))) {
            allowed.add(i);
        }
    }
    return allowed;
}

function tokenMismatch(a, b, allowed) {
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
        var left = a[i];
        var right = b[i];
        if (left === undefined || right === undefined || left.kind !== right.kind ||
            left.channel !== right.channel || (left.raw !== right.raw &&
            !(allowed.has(i) && (right.raw === left.raw.toUpperCase() ||
                right.raw === left.raw.toLowerCase())))) {
            return 'token ' + i + ': ' + JSON.stringify(left && left.raw) +
                ' -> ' + JSON.stringify(right && right.raw);
        }
    }
    return null;
}

// Glue rules of plan §4 floor 2, plus no case change inside a template fragment (§4 floor 5);
// a and b are token-equivalent codeLeaves of input and output.
// Each violated gap is reported once, by the first rule that catches it.
function glueViolations(a, b) {
    var glue = new Map();
    function add(index, message) {
        if (!glue.has(index)) {
            glue.set(index, message + ' ' + describe(a, index));
        }
    }
    var i;
    for (i = 1; i < a.length; i++) {
        if (WORD[a[i - 1].kind] && WORD[a[i].kind] && a[i].gap !== b[i].gap) {
            add(i, 'word gap');
        }
    }
    for (i = 0; i < a.length; i++) {
        if (a[i].kind !== 'parameter' || a[i].raw.slice(0, 2) !== '${') {
            continue;
        }
        var low = i;
        var high = i;
        while (low > 0 && !a[low].gap && absorbable(a[low - 1])) {
            low -= 1;
        }
        while (high + 1 < a.length && !a[high + 1].gap && absorbable(a[high + 1])) {
            high += 1;
        }
        for (var j = low; j <= high; j++) {
            if (j > low && b[j].gap) {
                add(j, 'space inside template fragment');
            }
            if (b[j].raw !== a[j].raw) {
                glue.set('case ' + j, 'case changed inside template fragment ' +
                    JSON.stringify([a[j].raw, b[j].raw]));
            }
        }
        if (low > 0 && a[low].gap && !b[low].gap) {
            add(low, 'space removed before template fragment');
        }
        if (high + 1 < a.length && a[high + 1].gap && !b[high + 1].gap) {
            add(high + 1, 'space removed after template fragment');
        }
    }
    return Array.from(glue.values());
}

// Safety floor 2 (plan §4): token equivalence plus glue preservation. Returns failures by property.
function floorFailures(source, output, spec) {
    var env = resolveEnvironment(spec, source);
    var dialect = env.options && DIALECTS.indexOf(env.options.dialect) >= 0
        ? env.options.dialect
        : 'hive';
    var a = codeLeaves(source, dialect);
    var b = codeLeaves(output, dialect);
    var allowed = env.op === 'formatSql'
        ? sqlCaseAuthorized(source, dialect, env.mode, a)
        : ddlCaseAuthorized(a);
    var mismatch = tokenMismatch(a, b, allowed);
    if (mismatch !== null) {
        return { token: mismatch };
    }
    var glue = glueViolations(a, b);
    return glue.length === 0 ? {} : { glue: glue.join('; ') };
}

// The checker must catch known glue breaks, including deleted space beside a template, and
// case changes outside the keywords each operation is allowed to case.
function selfTest() {
    [
        ['select ${v} + 1 from t', 'select ${v}+ 1 from t', 1],
        ['order by ${p}desc', 'order by ${p} desc', 1],
        ['select ${a}${b}', 'select ${a} ${b}', 1],
        ['where ds=${hiveconf:run_date}', 'where ds = ${hiveconf:run_date}', 2],
        ['x=${v}and y=1', 'x=${v}\nand y=1', 1],
        ['select 0L', 'select 0 L', 1],
        ['select ${v},x from t', 'select ${v}, x from t', 0],
        ['select a  from t', 'select a\nfrom t', 0],
    ].forEach(function(probe) {
        var actual = glueViolations(codeLeaves(probe[0], 'hive'), codeLeaves(probe[1], 'hive'));
        if (actual.length !== probe[2]) {
            throw new Error('glue self-test ' + JSON.stringify(probe) + ' reported ' +
                JSON.stringify(actual));
        }
    });
    var ddl = { op: 'formatHiveDdl' };
    [
        ['select MixedCase from MyTable', 'SELECT MIXEDCASE FROM MYTABLE', {}, 'token'],
        ['add jar /tmp/current.jar;', 'ADD jar /tmp/CURRENT.jar;', {}, 'token'],
        ['select ${v}and from t', 'SELECT ${v}AND FROM t', {}, 'token'],
        ['select ${v}and from t', 'select ${v}AND from t', {}, 'glue'],
        ['select a rlike b from t', 'SELECT a RLIKE b FROM t', {}, ''],
        ['select cast(a as varchar(10)) from t', 'SELECT CAST(a AS VARCHAR(10)) FROM t', {}, ''],
        ['create table Orc (Date string)', 'CREATE TABLE ORC (Date STRING)', ddl, 'token'],
        ['create table t (date string)', 'CREATE TABLE t (DATE STRING)', ddl, 'token'],
        ['create table t (comment string)', 'CREATE TABLE t (COMMENT STRING)', ddl, 'token'],
        ['create table t (s struct<Name:string>)', 'CREATE TABLE t (s STRUCT<NAME:STRING>)', ddl,
            'token'],
        ['create external table if not exists Orc (comment map<string,array<int>> comment \'X\') ' +
            'partitioned by (date string) stored as orc',
            'CREATE EXTERNAL TABLE IF NOT EXISTS Orc (comment MAP<STRING,ARRAY<INT>> COMMENT \'X\') ' +
            'PARTITIONED BY (date STRING) STORED AS ORC', ddl, ''],
    ].forEach(function(probe) {
        var actual = Object.keys(floorFailures(probe[0], probe[1], probe[2])).join();
        if (actual !== probe[3]) {
            throw new Error('case self-test ' + JSON.stringify(probe) + ' reported ' +
                JSON.stringify(actual));
        }
    });
}

// Property failures of one run: floor 2 and idempotence for the formatters, determinism for Extract.
async function propertyFailures(source, spec, actual) {
    var failures = {};
    var op = resolveEnvironment(spec, source).op;
    if (op === 'extractDdl') {
        var again = await execute(source, spec);
        if (JSON.stringify(again) !== JSON.stringify(actual)) {
            failures.determinism = 'second Extract run differs';
        }
        return failures;
    }
    if (actual.text === source) {
        return failures;
    }
    failures = floorFailures(source, actual.text, spec);
    var second = await execute(actual.text, spec);
    if (second.text !== actual.text) {
        failures.idempotence = 'second pass changes ' + firstDifference(actual.text, second.text);
    }
    return failures;
}

function firstDifference(expected, actual) {
    var left = expected.split('\n');
    var right = actual.split('\n');
    for (var i = 0; i < Math.max(left.length, right.length); i++) {
        if (left[i] !== right[i]) {
            return 'line ' + (i + 1) + ': expected ' + JSON.stringify(left[i]) +
                ', actual ' + JSON.stringify(right[i]);
        }
    }
    return 'no textual difference';
}

function loadRuns() {
    return walk(casesDir, '.in.txt').reduce(function(all, file) {
        var key = path.relative(casesDir, file).split(path.sep).join('/').slice(0, -'.in.txt'.length);
        return all.concat(readCase(file, key));
    }, []);
}

async function runCases(args) {
    var snapshot = readJson(snapshotPath, {});
    var knownIssues = readJson(knownIssuesPath, {});
    var nextSnapshot = args.filter === null ? {} : Object.assign({}, snapshot);
    var produced = new Set();
    var failures = [];
    var count = 0;
    var runs = loadRuns();
    for (var run of runs) {
        produced.add(run.outFile);
        if (args.filter !== null && run.key.indexOf(args.filter) < 0) {
            continue;
        }
        count += 1;
        var actual = await execute(run.source, run.spec);
        var entry = {
            op: resolveEnvironment(run.spec, run.source).op,
            status: actual.status,
            codes: actual.codes,
        };
        nextSnapshot[run.key] = entry;
        var expectedText = fs.existsSync(run.outFile)
            ? fs.readFileSync(run.outFile, 'utf8')
            : run.source;
        if (args.update) {
            if (actual.text === run.source) {
                fs.rmSync(run.outFile, { force: true });
            } else {
                fs.writeFileSync(run.outFile, actual.text);
            }
        } else {
            if (actual.text !== expectedText) {
                failures.push(run.key + ': output ' + firstDifference(expectedText, actual.text));
            }
            if (JSON.stringify(snapshot[run.key]) !== JSON.stringify(entry)) {
                failures.push(run.key + ': snapshot ' + JSON.stringify(snapshot[run.key]) +
                    ' -> ' + JSON.stringify(entry));
            }
        }
        var properties = await propertyFailures(run.source, run.spec, actual);
        var known = knownIssues[run.key];
        var waived = known === undefined ? [] : known.waive;
        Object.keys(properties).forEach(function(property) {
            if (waived.indexOf(property) < 0) {
                failures.push(run.key + ': ' + property + ' ' + properties[property]);
            }
        });
        waived.forEach(function(property) {
            if (WAIVABLE.indexOf(property) < 0 || properties[property] === undefined) {
                failures.push(run.key + ': stale waiver ' + property + ' (' + known.issue + ')');
            }
        });
    }
    Object.keys(knownIssues).forEach(function(key) {
        if (!runs.some(function(run) { return run.key === key; })) {
            failures.push(key + ': known issue for a missing case');
        }
    });
    if (args.update) {
        if (args.filter === null) {
            walk(casesDir, '.out.txt').forEach(function(file) {
                if (!produced.has(file)) {
                    fs.rmSync(file);
                }
            });
        }
        writeSortedJson(snapshotPath, nextSnapshot);
    } else if (args.filter === null) {
        Object.keys(snapshot).forEach(function(key) {
            if (nextSnapshot[key] === undefined) {
                failures.push(key + ': snapshot entry without a case');
            }
        });
        walk(casesDir, '.out.txt').forEach(function(file) {
            if (!produced.has(file)) {
                failures.push(path.relative(casesDir, file) + ': output without a case');
            }
        });
    }
    return { count: count, failures: failures };
}

// Real SQL files outside the repository: properties only, no snapshot.
async function runPrivate(dir) {
    var failures = [];
    var files = walk(dir, '.sql');
    for (var file of files) {
        var source = fs.readFileSync(file, 'utf8');
        var actual = await execute(source, {});
        var properties = await propertyFailures(source, {}, actual);
        Object.keys(properties).forEach(function(property) {
            failures.push(path.relative(dir, file) + ': ' + property + ' ' + properties[property]);
        });
    }
    return { count: files.length, failures: failures };
}

// Deterministic mutations of formatSql case inputs; checks floor 2 and idempotence only.
async function runFuzz(total) {
    var seed = 0x5eed;
    function random(limit) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        return (seed >>> 8) % limit;
    }
    var pool = [' ', '\n', ',', '(', ')', ';', 'select', 'from', 'case', 'end', '${x}', "'s'",
        '-- c\n', '/* c */', 'a.b', '1', 'and'];
    var inputs = loadRuns().filter(function(run) {
        return resolveEnvironment(run.spec, run.source).op === 'formatSql' && run.source.length <= 2000;
    });
    var failures = [];
    for (var i = 0; i < total && inputs.length > 0; i++) {
        var base = inputs[random(inputs.length)];
        var leaves = lexer.lexSql(base.source, { dialect: 'hive' }).leaves.map(function(leaf) {
            return leaf.raw;
        });
        var at = random(leaves.length + 1);
        var choice = random(3);
        if (choice === 0 && leaves.length > 0) {
            leaves.splice(Math.min(at, leaves.length - 1), 1);
        } else if (choice === 1 && leaves.length > 0) {
            leaves.splice(at, 0, leaves[Math.min(at, leaves.length - 1)]);
        } else {
            leaves.splice(at, 0, pool[random(pool.length)]);
        }
        var source = leaves.join('');
        var actual = await execute(source, base.spec);
        var properties = await propertyFailures(source, base.spec, actual);
        Object.keys(properties).forEach(function(property) {
            failures.push('fuzz ' + i + ' (' + base.key + ') ' + property + ' ' +
                properties[property] + '\n    input: ' + JSON.stringify(source));
        });
    }
    return { count: total, failures: failures };
}

async function main() {
    var args = parseArgs(process.argv.slice(2));
    var started = Date.now();
    selfTest();
    var outcome = args.privateDir !== null
        ? await runPrivate(args.privateDir)
        : args.fuzz > 0 ? await runFuzz(args.fuzz) : await runCases(args);
    outcome.failures.slice(0, 50).forEach(function(line) { console.log('FAIL ' + line); });
    if (outcome.failures.length > 50) {
        console.log('... ' + (outcome.failures.length - 50) + ' more failures');
    }
    console.log('golden: ' + outcome.count + ' runs, ' + outcome.failures.length + ' failures, ' +
        (Date.now() - started) + ' ms' + (args.update ? ' (updated)' : ''));
    process.exitCode = outcome.failures.length === 0 ? 0 : 1;
}

main().catch(function(error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
