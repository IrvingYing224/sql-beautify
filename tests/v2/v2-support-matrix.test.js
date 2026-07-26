'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var generatorPath = path.join(root, 'scripts', 'generate-v2-support-matrix.js');
var documentPath = path.join(root, 'docs', 'technical', 'sql-support-matrix.md');
var registryPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'dialects',
    'registry.js'
);

assert.ok(fs.existsSync(generatorPath), 'Wave 2E support-matrix generator is required');
assert.ok(fs.existsSync(documentPath), 'Wave 2E generated support matrix is required');
assert.ok(fs.existsSync(registryPath), 'compiled v2 dialect registry is required');

var generator = require(generatorPath);
var registryModule = require(registryPath);
var registry = registryModule.getDialectCapabilityRegistry();

function cells(line) {
    return line.split('|').slice(1, -1).map(function(value) {
        return value.trim();
    });
}

function unquoteCode(value) {
    var match = /^`([^`]*)`$/.exec(value);
    return match === null ? value : match[1];
}

function parseCapabilityMatrix(markdown) {
    var lines = markdown.split('\n');
    var headerIndex = lines.findIndex(function(line) {
        return /^\| Capability \|/.test(line);
    });
    assert.ok(headerIndex >= 0, 'generated document must contain a capability matrix');
    assert.ok(/^\|(?: --- \|)+$/.test(lines[headerIndex + 1]),
        'capability matrix must contain a deterministic Markdown separator');

    var header = cells(lines[headerIndex]);
    var rows = [];
    for (var index = headerIndex + 2; index < lines.length && lines[index] !== ''; index++) {
        var row = cells(lines[index]);
        assert.strictEqual(row.length, header.length, 'matrix row width must match its header');
        rows.push({
            capability: unquoteCode(row[0]),
            states: row.slice(1).map(unquoteCode)
        });
    }
    return {
        dialects: header.slice(1).map(unquoteCode),
        rows: rows
    };
}

function expectedFacts() {
    var dialects = registry.listDialects().slice().sort();
    var capabilities = new Set();
    var states = new Map();
    var formattedPairs = [];
    dialects.forEach(function(dialect) {
        registry.getDialect(dialect).listCapabilities().forEach(function(capability) {
            if (capability.state === 'formatted') {
                formattedPairs.push(dialect + '/' + capability.id);
            }
            capabilities.add(capability.id);
            states.set(dialect + '\0' + capability.id, capability.state);
        });
    });
    return {
        dialects: dialects,
        capabilities: Array.from(capabilities).sort(),
        states: states,
        formattedPairs: formattedPairs.sort()
    };
}

(function testRenderedMatrixIsDeterministicAndRegistryOwned() {
    var first = generator.renderMatrix();
    var second = generator.renderMatrix();
    var document = fs.readFileSync(documentPath, 'utf8');
    var facts = expectedFacts();
    var parsed = parseCapabilityMatrix(document);

    assert.strictEqual(first, second, 'matrix rendering must be deterministic');
    assert.strictEqual(document, first, 'generated document must byte-match renderer output');
    assert.match(
        document,
        /covers the main `formatSql` pipeline only/,
        'matrix must distinguish the main formatter from experimental DDL APIs'
    );
    assert.deepStrictEqual(parsed.dialects, facts.dialects,
        'matrix dialect columns must come from the compiled v2 registry');
    assert.deepStrictEqual(parsed.rows.map(function(row) {
        return row.capability;
    }), facts.capabilities, 'matrix capability rows must be the sorted registry union');
    assert.deepStrictEqual(
        facts.formattedPairs,
        ['generic', 'mysql', 'postgresql'].reduce(function(values, dialect) {
            return values.concat([
                'case-expression',
                'cast-type',
                'from',
                'function-call',
                'group-by',
                'having',
                'join',
                'limit',
                'multi-statement',
                'order-by',
                'select-without-from',
                'set-operations',
                'subquery',
                'subquery-expression',
                'table-function',
                'where',
                'window',
                'window-expression',
                'with-cte'
            ].map(function(id) { return dialect + '/' + id; }));
        }, []).concat([
            'case-expression',
            'cast-type',
            'cluster-by',
            'collection-expression',
            'distribute-by',
            'from',
            'function-call',
            'group-by',
            'having',
            'insert-into-partition-select',
            'insert-overwrite-partition-select',
            'join',
            'lateral-view',
            'limit',
            'multi-statement',
            'order-by',
            'select-without-from',
            'set-operations',
            'set-command',
            'sort-by',
            'subquery',
            'subquery-expression',
            'table-function',
            'where',
            'window',
            'window-expression',
            'with-cte'
        ].map(function(id) { return 'hive/' + id; })).sort(),
        'Wave 3E matrix must expose the exact proven dialect manifests'
    );

    parsed.rows.forEach(function(row) {
        row.states.forEach(function(state, dialectIndex) {
            var dialect = parsed.dialects[dialectIndex];
            var expected = facts.states.get(dialect + '\0' + row.capability) || '—';
            assert.strictEqual(
                state,
                expected,
                'matrix state must match registry for ' + dialect + '/' + row.capability
            );
        });
    });
    assert.strictEqual(parsed.rows.filter(function(row) {
        return row.states.some(function(state) { return state === 'formatted'; });
    }).length, 27, 'matrix must contain twenty-seven distinct formatted capability rows');
}());

function createIsolatedGeneratorRoot() {
    var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-v2-matrix-'));
    fs.mkdirSync(path.join(temporaryRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'docs', 'technical'), { recursive: true });
    fs.copyFileSync(generatorPath, path.join(
        temporaryRoot,
        'scripts',
        'generate-v2-support-matrix.js'
    ));
    fs.symlinkSync(path.join(root, '.tmp'), path.join(temporaryRoot, '.tmp'), 'dir');
    return temporaryRoot;
}

function runGenerator(generatorRoot, args) {
    return childProcess.spawnSync(
        process.execPath,
        [path.join(generatorRoot, 'scripts', 'generate-v2-support-matrix.js')].concat(args),
        { encoding: 'utf8' }
    );
}

(function testCliCheckWriteAndArgumentContract() {
    var temporaryRoot = createIsolatedGeneratorRoot();
    var temporaryDocument = path.join(
        temporaryRoot,
        'docs',
        'technical',
        'sql-support-matrix.md'
    );
    try {
        var drift = generator.renderMatrix() + '\n';
        fs.writeFileSync(temporaryDocument, drift, 'utf8');

        var explicitCheck = runGenerator(temporaryRoot, ['--check']);
        assert.notStrictEqual(explicitCheck.status, 0, '--check must reject byte drift');
        assert.strictEqual(fs.readFileSync(temporaryDocument, 'utf8'), drift,
            '--check must never rewrite a mismatched document');

        var defaultCheck = runGenerator(temporaryRoot, []);
        assert.notStrictEqual(defaultCheck.status, 0,
            'no arguments must be equivalent to --check');
        assert.strictEqual(fs.readFileSync(temporaryDocument, 'utf8'), drift,
            'default check must never rewrite a mismatched document');

        var unknown = runGenerator(temporaryRoot, ['--unknown']);
        assert.notStrictEqual(unknown.status, 0, 'unknown arguments must be rejected');
        assert.match(unknown.stderr, /Unknown argument/);
        assert.strictEqual(fs.readFileSync(temporaryDocument, 'utf8'), drift,
            'unknown arguments must not rewrite the document');

        var write = runGenerator(temporaryRoot, ['--write']);
        assert.strictEqual(write.status, 0, write.stderr);
        assert.strictEqual(
            fs.readFileSync(temporaryDocument, 'utf8'),
            generator.renderMatrix(),
            'only explicit --write may update the generated artifact'
        );
        assert.strictEqual(runGenerator(temporaryRoot, ['--check']).status, 0,
            '--check must pass after explicit generation');
        assert.strictEqual(runGenerator(temporaryRoot, []).status, 0,
            'default check must pass after explicit generation');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}());

(function testV2MatrixStaysOutsideTheVsixAllowlist() {
    var packageJson = JSON.parse(fs.readFileSync(
        path.join(root, 'package.json'), 'utf8'
    ));
    assert.ok(Array.isArray(packageJson.files),
        'VSIX packaging must use an explicit files allowlist');
    ['docs', 'scripts', 'tests', '.tmp'].forEach(function(directory) {
        assert.strictEqual(packageJson.files.some(function(pattern) {
            return pattern === directory || pattern.indexOf(directory + '/') === 0;
        }), false, 'package files allowlist must exclude ' + directory);
    });
    assert.strictEqual(path.basename(documentPath), 'sql-support-matrix.md',
        '3.x must own the single canonical support matrix');
    assert.strictEqual(
        fs.existsSync(path.join(root, 'docs', 'technical', 'sql-formatter-v2-support-matrix.md')),
        false,
        'the development-stage v2 matrix alias must be removed after cutover'
    );
}());

console.log('v2 generated support matrix tests passed');
