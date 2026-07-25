'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var core = require('../../.tmp/v2-core/core');
var ddl = require('../../.tmp/v2-core/experimental/ddl');
var fixtures = require('../fixtures/v2-wave4-ddl');
var transaction = require('../../.tmp/v2-core/adapters/transaction/prepare');
var directModule = require('../../.tmp/v2-core/adapters/executor/direct');
var persistentModule = require('../../.tmp/v2-core/adapters/executor/persistent-worker');
var connectionModule = require('../../.tmp/v2-core/adapters/executor/worker-connection');

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function syntaxSignature(source, dialect, typeContext) {
    return core.lexSql(source, { dialect: dialect }).leaves.filter(function(leaf) {
        return leaf.channel === 'code' || leaf.channel === 'protected';
    }).flatMap(function(leaf) {
        var raw = leaf.kind === 'keyword' ? leaf.raw.toLowerCase() : leaf.raw;
        if (typeContext && leaf.kind === 'operator' && /^>+$/.test(raw)) {
            return raw.split('').map(function() { return 'operator:>'; });
        }
        return leaf.kind + ':' + raw;
    });
}

function protectedSignature(source, dialect) {
    return core.lexSql(source, { dialect: dialect }).leaves.filter(function(leaf) {
        return leaf.channel === 'protected' ||
            leaf.kind === 'line-comment' || leaf.kind === 'block-comment';
    }).map(function(leaf) {
        return leaf.kind + ':' + leaf.raw;
    });
}

function assertEquivalent(source, output, dialect, label, typeContext) {
    assert.deepStrictEqual(
        syntaxSignature(output, dialect, typeContext),
        syntaxSignature(source, dialect, typeContext),
        label + ': syntax token equivalence'
    );
    assert.deepStrictEqual(
        protectedSignature(output, dialect),
        protectedSignature(source, dialect),
        label + ': protected/comment byte preservation'
    );
}

function assertSafeFormatResult(result, source, label) {
    assert.strictEqual(Object.isFrozen(result), true, label + ': frozen result');
    assert.strictEqual(Object.isFrozen(result.diagnostics), true,
        label + ': frozen diagnostics');
    assert.strictEqual(typeof result.text, 'string', label + ': text');
    if (result.status === 'formatted' || result.status === 'unchanged') {
        assert.ok(result.sourceMap, label + ': safe result source map');
        assert.strictEqual(Object.isFrozen(result.sourceMap), true,
            label + ': frozen source map');
    } else {
        assert.strictEqual(result.text, source, label + ': failed/preserved source identity');
        assert.strictEqual(result.sourceMap, undefined, label + ': no partial source map');
    }
}

function assertSuccessfulFormatResult(result, source, label) {
    assertSafeFormatResult(result, source, label);
    assert.ok(result.status === 'formatted' || result.status === 'unchanged',
        label + ': known-positive format status');
}

function assertSafeDdlResult(result, source, label) {
    assert.strictEqual(Object.isFrozen(result), true, label + ': frozen result');
    assert.strictEqual(Object.isFrozen(result.diagnostics), true,
        label + ': frozen diagnostics');
    assert.strictEqual(typeof result.text, 'string', label + ': text');
    if (result.status === 'formatted' || result.status === 'unchanged') {
        assert.strictEqual(result.diagnostics.length, 0,
            label + ': editable result is diagnostic-free');
        assertEquivalent(source, result.text, 'hive', label, true);
    } else {
        assert.strictEqual(result.text, source, label + ': preserved source identity');
        assert.ok(result.diagnostics.length > 0, label + ': preserved diagnostic');
    }
}

function identitySourceMap(length) {
    return {
        entries: length === 0 ? [] : [{
            source: { start: 0, end: length },
            output: { start: 0, end: length }
        }]
    };
}

async function assertTransactionAllOrNothing() {
    var lines = [];
    var targets = [];
    var offset = 0;
    for (var index = 0; index < 24; index++) {
        var line = 'select c' + index + ';\n';
        lines.push(line);
        targets.push({
            id: 'line:' + index,
            start: offset,
            end: offset + line.length,
            mode: 'fragment'
        });
        offset += line.length;
    }
    var source = lines.join('');
    var calls = 0;
    var executor = {
        format: async function(request) {
            calls += 1;
            if (request.targetId === 'line:17') {
                return {
                    status: 'preserved',
                    text: request.source,
                    diagnostics: [{
                        code: 'TEST_PROPERTY_PRESERVED',
                        severity: 'warning',
                        message: 'preserved target',
                        capabilityId: null,
                        span: { start: 0, end: request.source.length },
                        recovery: 'preserve-target'
                    }]
                };
            }
            return {
                status: 'formatted',
                text: request.source.toUpperCase(),
                diagnostics: [],
                sourceMap: identitySourceMap(request.source.length)
            };
        },
        dispose: async function() {}
    };
    var result = await transaction.prepareFormatTransaction({
        source: source,
        documentVersion: 11,
        targets: targets,
        options: { dialect: 'hive' }
    }, executor);
    assert.strictEqual(result.status, 'rejected');
    assert.strictEqual(result.edits, undefined, 'rejected property transaction has no edits');
    assert.strictEqual(calls, targets.length,
        'all computations complete before the atomic rejection decision');
}

function nextRandom(state) {
    state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
    return state.value;
}

function pick(state, values) {
    return values[nextRandom(state) % values.length];
}

function fuzzQuery(state, index) {
    var itemCount = 1 + nextRandom(state) % 5;
    var items = [];
    for (var itemIndex = 0; itemIndex < itemCount; itemIndex++) {
        var suffix = index + '_' + itemIndex;
        items.push(pick(state, [
            't.c' + itemIndex + ' AS c' + suffix,
            '(' + itemIndex + ' + ' + (index % 17) + ') AS n' + suffix,
            "'FROM," + suffix + "' AS text_" + suffix,
            'count(*) AS count_' + suffix,
            'CASE WHEN t.c' + itemIndex + ' = ' + (index % 7) +
                ' THEN t.c' + itemIndex + ' ELSE 0 END AS case_' + suffix,
            '`quoted,' + suffix + '` AS quoted_' + suffix
        ]));
    }
    var separator = pick(state, [', ', ',\n', ', /* between */ ']);
    var source = 'SELECT ' + items.join(separator) + ' FROM t' + index + ' t';
    if (nextRandom(state) % 2 === 0) {
        source += ' WHERE (t.c0 >= ' + (index % 11) + ' AND t.c0 IS NOT NULL)';
    }
    if (nextRandom(state) % 3 === 0) {
        source += ' ORDER BY t.c0 DESC LIMIT ' + (1 + index % 25);
    }
    if (nextRandom(state) % 4 === 0) {
        source = 'WITH c' + index + ' AS (' + source + ') SELECT * FROM c' + index;
    } else if (nextRandom(state) % 4 === 0) {
        source = 'SELECT q.c0 FROM (' + source + ') q';
    }
    if (nextRandom(state) % 5 === 0) {
        source += ' -- tail ' + index + '\n';
    }
    var malformed = nextRandom(state) % 13;
    if (malformed === 0) {
        source += ')';
    } else if (malformed === 1) {
        source += ' /* unterminated ' + index;
    } else if (malformed === 2) {
        source = 'SELECT count(DISTINCT *) AS invalid_' + index + ' FROM t' + index;
    }
    return source;
}

function fuzzDdl(state, index) {
    var columnCount = 1 + nextRandom(state) % 5;
    var columns = [];
    for (var columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        var name = nextRandom(state) % 3 === 0
            ? '`c,' + index + '_' + columnIndex + '`'
            : 'c' + index + '_' + columnIndex;
        var type = pick(state, [
            'STRING',
            'DECIMAL(' + (10 + index % 9) + ',' + index % 4 + ')',
            'ARRAY<STRUCT<x:STRING,n:INT>>',
            'MAP<STRING,ARRAY<INT>>',
            'STRUCT<a:STRING,b:ARRAY<BIGINT>>'
        ]);
        var comment = nextRandom(state) % 4 === 0
            ? " COMMENT 'FROM," + index + " (" + columnIndex + ")'"
            : '';
        columns.push(name + ' ' + type + comment);
    }
    var source = 'CREATE ' + (nextRandom(state) % 3 === 0 ? 'EXTERNAL ' : '') +
        'TABLE ' + (nextRandom(state) % 2 === 0 ? 'IF NOT EXISTS ' : '') +
        'db' + index + '.`t(' + index + '` (\n' + columns.join(',\n') + '\n);';
    var malformed = nextRandom(state) % 17;
    if (malformed === 0) {
        source = source.slice(0, -2) + ';';
    } else if (malformed === 1) {
        source = source.replace(/>\s*(,|\n|\))/, '$1');
    } else if (malformed === 2) {
        source = source.replace(/\);$/, ', CONSTRAINT x PRIMARY KEY (c0));');
    } else if (malformed === 3) {
        source = '-- unsupported SQL comment\n' + source;
    }
    return source;
}

function assertNoThrowProperties() {
    var state = { value: 0x4e202607 };
    for (var index = 0; index < 160; index++) {
        var query = fuzzQuery(state, index);
        var formatResult;
        assert.doesNotThrow(function() {
            formatResult = core.formatSql(query, { dialect: 'hive' });
        }, 'query fuzz must not throw: ' + index);
        assertSafeFormatResult(formatResult, query, 'query fuzz ' + index);
        if (formatResult.status === 'formatted' || formatResult.status === 'unchanged') {
            assertEquivalent(query, formatResult.text, 'hive', 'query fuzz ' + index);
        }

        var ddlSource = fuzzDdl(state, index);
        var ddlResult;
        assert.doesNotThrow(function() {
            ddlResult = ddl.formatHiveDdl(ddlSource);
        }, 'DDL fuzz must not throw: ' + index);
        assertSafeDdlResult(ddlResult, ddlSource, 'DDL fuzz ' + index);

        var extractResult;
        assert.doesNotThrow(function() {
            extractResult = ddl.extractDdl(query);
        }, 'Extract DDL fuzz must not throw: ' + index);
        if (extractResult.status === 'extracted') {
            assert.ok(extractResult.text.length > 0, 'Extract DDL fuzz non-empty: ' + index);
            assert.deepStrictEqual(extractResult.diagnostics, [],
                'Extract DDL success is diagnostic-free: ' + index);
        } else {
            assert.strictEqual(extractResult.text, query,
                'Extract DDL fuzz source identity: ' + index);
            assert.ok(extractResult.diagnostics.length > 0,
                'Extract DDL fuzz diagnostic: ' + index);
        }
    }
}

async function assertDirectWorkerParity() {
    var runtimePath = path.join(root, 'dist', 'runtime.cjs');
    var workerPath = path.join(root, 'dist', 'formatter-worker.cjs');
    var targetCore = require('../../.tmp/v2-core/core/api/format');
    var direct = new directModule.DirectFormatterExecutor(targetCore.formatSql);
    var worker = new persistentModule.PersistentWorkerExecutor({
        workerFactory: connectionModule.createNodeWorkerFactory(workerPath, runtimePath),
        runtimeDigest: digest(runtimePath)
    });
    try {
        for (var index = 0; index < 16; index++) {
            var source = index % 4 === 0
                ? 'select a' + index + ', count(*) as n from t group by a' + index
                : index % 4 === 1
                    ? "select 'FROM," + index + "' as text_value from t -- tail\n"
                    : index % 4 === 2
                        ? 'with c as (select ' + index + ' as n) select n from c'
                        : 'select case when a = ' + index + ' then b else c end as value from t';
            var request = {
                source: source,
                options: { dialect: 'hive', unsupportedSyntaxPolicy: 'preserve' },
                mode: 'document',
                documentVersion: index,
                targetId: 'property:' + index
            };
            var directResult = await direct.format(request);
            var workerResult = await worker.format(request);
            assertSuccessfulFormatResult(directResult, source,
                'direct property result ' + index);
            assertSuccessfulFormatResult(workerResult, source,
                'worker property result ' + index);
            assert.deepStrictEqual(workerResult, directResult,
                'direct/worker artifact parity: ' + index);
        }
        assert.strictEqual(worker.statistics().staleResponses, 0,
            'property corpus must not produce stale worker responses');
    } finally {
        await worker.dispose();
        await direct.dispose();
    }
}

async function main() {
    var queryCases = [
        { dialect: 'hive', source: "select 'FROM,  x' as text_value, `Case` from t -- tail\nwhere a = 1" },
        { dialect: 'hive', source: 'with c as (select 1 as n) select n, count(*) as total from c group by n' },
        { dialect: 'postgresql', source: "select $$FROM, x$$ as body, \"Case\" from t /* keep */" },
        { dialect: 'mysql', source: "select `Case`, 'a,b' as text_value from t # keep\nwhere a <=> 1" }
    ];
    queryCases.forEach(function(fixture, index) {
        var result = core.formatSql(fixture.source, {
            dialect: fixture.dialect,
            unsupportedSyntaxPolicy: 'preserve'
        });
        assertSuccessfulFormatResult(result, fixture.source, 'query equivalence ' + index);
        assertEquivalent(fixture.source, result.text, fixture.dialect,
            'query equivalence ' + index);
    });

    assert.notDeepStrictEqual(
        syntaxSignature('SELECT a >> b FROM t', 'hive', false),
        syntaxSignature('SELECT a > > b FROM t', 'hive', false),
        'query shift operator must not use DDL angle normalization'
    );
    assert.deepStrictEqual(
        syntaxSignature('CREATE TABLE t (a ARRAY<ARRAY<INT>>)', 'hive', true),
        syntaxSignature('CREATE TABLE t (a ARRAY<ARRAY<INT> >)', 'hive', true),
        'DDL type closing angles normalize lexical maximal-munch only'
    );
    assert.notDeepStrictEqual(
        syntaxSignature('CREATE TABLE t (a ARRAY<ARRAY<INT>>)', 'hive', true),
        syntaxSignature('CREATE TABLE t (a ARRAY<ARRAY<INT>)', 'hive', true),
        'DDL type closing-angle count remains significant'
    );

    fixtures.ddl.filter(function(fixture) {
        return fixture.status === 'formatted';
    }).forEach(function(fixture) {
        var result = ddl.formatHiveDdl(fixture.source);
        assert.strictEqual(result.status, 'formatted', fixture.id + ': property status');
        assertEquivalent(fixture.source, result.text, 'hive', fixture.id, true);
    });

    assertNoThrowProperties();
    await assertTransactionAllOrNothing();
    await assertDirectWorkerParity();
    console.log('v2 Wave 4 aggregate properties passed');
}

main().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
