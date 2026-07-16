'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parserPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var analysisPath = path.join(root, '.tmp', 'v2-core', 'core', 'analysis', 'index.js');

assert.ok(fs.existsSync(parserPath), 'Wave 2D parser build is required');
assert.ok(fs.existsSync(invariantsPath), 'Wave 2D invariant build is required');
assert.ok(fs.existsSync(tokenTablePath), 'Wave 2D token table build is required');
assert.ok(fs.existsSync(analysisPath), 'Wave 2E analysis build is required');

var parser = require(parserPath);
var invariants = require(invariantsPath);
var tokenTable = require(tokenTablePath);
var analysis = require(analysisPath);

var DIALECTS = Object.freeze(['hive', 'generic', 'postgresql', 'mysql']);
var FUZZ_SEED = 0x2d202607;
var GENERATED_CASE_COUNT = 64;
var MAX_SOURCE_LENGTH = 4096;
var MAX_TOTAL_MS = 15000;
var NODE_FIXED_OVERHEAD = 8;
var MAX_NODES_PER_SYNTAX_LEAF = 16;
var SEVERITY_RANK = Object.freeze({ error: 0, warning: 1, info: 2 });

function xorshift32(seed) {
    var state = seed >>> 0;
    return function next() {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

function choose(next, values) {
    return values[next() % values.length];
}

function gap(next, index) {
    return choose(next, [
        ' ',
        '\n',
        '\t',
        ' /* fuzz-' + index + ' */ ',
        ' -- fuzz-' + index + '\n'
    ]);
}

function atom(next) {
    return choose(next, [
        'a',
        't.x',
        '17',
        "'FROM, WHERE; () -- literal'",
        "'it''s still a string'",
        '`qualify`',
        'coalesce(x, 0)',
        'CASE WHEN p = 1 THEN q ELSE r END'
    ]);
}

function operator(next) {
    return choose(next, [
        '+', '-', '*', '/', '=', '<>', 'AND', 'OR', '||', '@', '::', '->>'
    ]);
}

function generatedCase(next, index) {
    var left = 'case_' + index + ' + ' + atom(next);
    var right = atom(next);
    var third = atom(next);
    var op = operator(next);
    var join = gap(next, index);
    var table = choose(next, ['fact_' + index, 'src_' + (index % 7), '`odd,table`']);
    var mode = index % 16;

    if (mode === 0) {
        return 'SELECT' + join + left + ',' + join + ',' + right +
            ' FROM ' + table + '; SELECT ' + third;
    }
    if (mode === 1) {
        return 'SELECT (' + left + ' ' + op + ' ' + right + '; SELECT ' + third;
    }
    if (mode === 2) {
        return 'SELECT ' + left + ' ' + op + ' FROM ' + table +
            ' WHERE ' + right + ';';
    }
    if (mode === 3) {
        return 'SELECT ' + left + ', ' + right + ') FROM ' + table + ';';
    }
    if (mode === 4) {
        return 'SELECT ' + left + ' FROM ' + table + ' WHERE' + join + '; SELECT ' + right;
    }
    if (mode === 5) {
        return 'SELECT ' + left + ' FROM ' + table +
            ' QUALIFY row_number() OVER (PARTITION BY ' + right + ') = ;';
    }
    if (mode === 6) {
        return 'SELECT CAST(' + left + ' AS ARRAY<MAP<STRING,>>) FROM ' + table + ';';
    }
    if (mode === 7) {
        return ';' + join + '; SELECT ' + left + ';; SELECT ' + right + op + ';';
    }
    if (mode === 8) {
        return "SELECT 'unterminated " + left + '; SELECT ' + right;
    }
    if (mode === 9) {
        return 'SELECT ' + left + ' FROM ' + table + ' /* unterminated ' + right;
    }
    if (mode === 10) {
        return 'SELECT CASE WHEN ' + left + ' ' + op + ' ' + right + ' THEN ' + third +
            ' FROM ' + table + ';';
    }
    if (mode === 11) {
        return 'SELECT sum(' + left + ') OVER (PARTITION BY , ' + right +
            ' ORDER BY ' + third + ' ROWS BETWEEN AND 1 FOLLOWING) FROM ' + table;
    }
    if (mode === 12) {
        return 'SELECT ' + left + ' FROM ' + table +
            ' LEFT JOIN dim_' + index + ' ON ' + right + ' = ; SELECT ' + third;
    }
    if (mode === 13) {
        return 'SELECT ' + left + ' @ ' + right + ', ' + third +
            ' FROM ' + table + ' -- operator recovery\nWHERE x = 1;';
    }
    if (mode === 14) {
        return 'SELECT * FROM ' + table +
            ' PIVOT (sum(' + left + ') FOR k IN (' + right + ',)); SELECT ' + third;
    }
    return 'MERGE INTO ' + table + ' USING src_' + index +
        ' ON ' + left + ' = ' + right + ' WHEN MATCHED THEN UPDATE SET x = ;' +
        join + 'SELECT ' + third;
}

function buildCorpus() {
    var next = xorshift32(FUZZ_SEED);
    var corpus = [
        '',
        '; ; -- only empty statements\n;',
        'SELECT a,,b; SELECT 2',
        'SELECT (a + b; SELECT 2',
        'SELECT a @ b FROM t WHERE x =; SELECT 3 -- tail\n',
        "SELECT 'FROM,);--' AS s, x FROM t WHERE",
        'SELECT /* before */ a, -- after comma\n, b FROM t;',
        'SELECT * FROM t MATCH_RECOGNIZE (PARTITION BY k',
        'SELECT * FROM t UNPIVOT (v FOR k IN (a, b)); SELECT ok FROM u',
        "SELECT 'unterminated; ) , FROM WHERE -- still literal",
        '/* unterminated comment SELECT (x,,y);',
        'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x ='
    ];
    for (var index = 0; index < GENERATED_CASE_COUNT; index++) {
        corpus.push(generatedCase(next, index));
    }
    corpus.forEach(function(source, index) {
        assert.ok(source.length <= MAX_SOURCE_LENGTH, 'fuzz case ' + index + ' is bounded');
    });
    assert.strictEqual(new Set(corpus).size, corpus.length, 'fuzz corpus cases must be unique');
    var combined = corpus.join('\n');
    [
        ['semicolon', /;/],
        ['parenthesis', /[()]/],
        ['comma', /,/],
        ['operator', /@|<>|\|\||::|->>/],
        ['clause', /\b(?:FROM|WHERE|QUALIFY|PIVOT|UNPIVOT|MATCH_RECOGNIZE|MERGE)\b/],
        ['line comment', /--/],
        ['block comment', /\/\*/],
        ['string', /'/]
    ].forEach(function(requirement) {
        assert.ok(requirement[1].test(combined),
            'fuzz corpus must cover ' + requirement[0] + ' combinations');
    });
    return Object.freeze(corpus);
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(left, right) {
    if (left.span.start !== right.span.start) {
        return left.span.start - right.span.start;
    }
    if (left.span.end !== right.span.end) {
        return left.span.end - right.span.end;
    }
    if (SEVERITY_RANK[left.severity] !== SEVERITY_RANK[right.severity]) {
        return SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    }
    var capabilityOrder = left.capabilityId === right.capabilityId
        ? 0
        : left.capabilityId === null
            ? -1
            : right.capabilityId === null
                ? 1
                : compareText(left.capabilityId, right.capabilityId);
    return compareText(left.code, right.code) ||
        compareText(left.message, right.message) ||
        compareText(left.recovery, right.recovery) ||
        capabilityOrder;
}

function diagnosticKey(diagnostic) {
    return JSON.stringify([
        diagnostic.span.start,
        diagnostic.span.end,
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
        diagnostic.recovery,
        diagnostic.capabilityId
    ]);
}

function assertDiagnostics(label, source, diagnostics) {
    var keys = [];
    diagnostics.forEach(function(diagnostic, index) {
        assert.ok(Number.isInteger(diagnostic.span.start), label + ' diagnostic start integer');
        assert.ok(Number.isInteger(diagnostic.span.end), label + ' diagnostic end integer');
        assert.ok(diagnostic.span.start >= 0, label + ' diagnostic starts in source');
        assert.ok(diagnostic.span.end >= diagnostic.span.start,
            label + ' diagnostic span is ordered');
        assert.ok(diagnostic.span.end <= source.length, label + ' diagnostic ends in source');
        assert.ok(Object.prototype.hasOwnProperty.call(SEVERITY_RANK, diagnostic.severity),
            label + ' diagnostic severity is known');
        assert.strictEqual(typeof diagnostic.code, 'string', label + ' diagnostic code type');
        assert.ok(diagnostic.code.length > 0, label + ' diagnostic code is non-empty');
        assert.strictEqual(typeof diagnostic.message, 'string', label + ' diagnostic message type');
        assert.ok(diagnostic.message.length > 0, label + ' diagnostic message is non-empty');
        assert.ok(diagnostic.capabilityId === null ||
            (typeof diagnostic.capabilityId === 'string' &&
                /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(diagnostic.capabilityId)),
        label + ' diagnostic capability identity is canonical');
        assert.ok([
            'none', 'verbatim-node', 'preserve-statement', 'preserve-target'
        ].indexOf(diagnostic.recovery) >= 0, label + ' diagnostic recovery is known');
        if (index > 0) {
            assert.ok(compareDiagnostics(diagnostics[index - 1], diagnostic) <= 0,
                label + ' diagnostics must follow the complete canonical total order');
        }
        keys.push(diagnosticKey(diagnostic));
    });
    assert.strictEqual(new Set(keys).size, keys.length,
        label + ' diagnostics must be exactly deduplicated across every field');
}

function flattenChecked(label, rootNode, hardLimit) {
    var nodes = [];
    var stack = [rootNode];
    var seen = new Set();
    while (stack.length > 0) {
        var node = stack.pop();
        assert.ok(node && typeof node === 'object', label + ' node must be an object');
        assert.strictEqual(seen.has(node), false, label + ' CST must not cycle or share nodes');
        seen.add(node);
        nodes.push(node);
        assert.ok(nodes.length <= hardLimit, label + ' CST exceeded its linear node bound');
        if (Array.isArray(node.children)) {
            for (var index = node.children.length - 1; index >= 0; index--) {
                stack.push(node.children[index]);
            }
        }
    }
    return nodes;
}

function assertOpaqueReconstruction(label, source, result, nodes) {
    nodes.filter(function(node) {
        return node.kind === 'opaque';
    }).forEach(function(node) {
        assert.ok(node.leafRange.start < node.leafRange.end,
            label + ' opaque node must own at least one leaf');
        var fromLeaves = result.leaves.slice(node.leafRange.start, node.leafRange.end)
            .map(function(leaf) { return leaf.raw; }).join('');
        assert.strictEqual(fromLeaves, source.slice(node.span.start, node.span.end),
            label + ' opaque node must reconstruct exactly from its leaves');
        assert.ok(result.diagnostics.some(function(diagnostic) {
            return diagnostic.code === node.reasonCode &&
                diagnostic.capabilityId === node.capabilityId &&
                diagnostic.span.start === node.span.start &&
                diagnostic.span.end === node.span.end;
        }), label + ' opaque node must have a matching diagnostic');
    });
}

function verifyCase(source, dialect, caseIndex) {
    var label = dialect + '/case-' + caseIndex;
    var options = { dialect: dialect, mode: 'document' };
    var result;
    assert.doesNotThrow(function() {
        result = parser.parseSql(source, options);
    }, label + ' parse must not throw');

    assert.strictEqual(result.leaves.map(function(leaf) {
        return leaf.raw;
    }).join(''), source, label + ' source conservation');
    assert.deepStrictEqual(parser.parseSql(source, options), result,
        label + ' repeated parse must be deeply deterministic');

    var table = tokenTable.buildStructuralTokenTable(result.leaves, source);
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(checked.ok, true,
        label + ' invariant failures: ' + JSON.stringify(checked.failures, null, 2));

    assertDiagnostics(label, source, result.diagnostics);
    var codeLeafCount = result.leaves.filter(function(leaf) {
        return leaf.channel === 'code';
    }).length;
    var nodeLimit = NODE_FIXED_OVERHEAD +
        MAX_NODES_PER_SYNTAX_LEAF * Math.max(1, codeLeafCount);
    var nodes = flattenChecked(label, result.root, nodeLimit);
    assert.ok(nodes.length <= nodeLimit,
        label + ' node count must be O(code leaves): ' +
        nodes.length + ' > ' + nodeLimit);
    assertOpaqueReconstruction(label, source, result, nodes);

    var analyzed = analysis.analyzeSql(source, options);
    var analyzedAgain = analysis.analyzeSql(source, options);
    assert.strictEqual(analyzed.status, 'analyzed', label + ' analysis status');
    assert.deepStrictEqual(analyzed.root, result.root, label + ' analysis/parser CST agreement');
    assert.deepStrictEqual(analyzed.leaves, result.leaves,
        label + ' analysis/parser leaf agreement');
    assert.deepStrictEqual(analyzed.diagnostics, result.diagnostics,
        label + ' analysis/parser diagnostic agreement');
    assert.deepStrictEqual(analyzedAgain.index.snapshot(), analyzed.index.snapshot(),
        label + ' repeated analysis index determinism');
    assert.strictEqual(analyzed.leaves.map(function(leaf) { return leaf.raw; }).join(''),
        source, label + ' analysis source conservation');
}

var corpus = buildCorpus();
var started = process.hrtime.bigint();
var parseCount = 0;

DIALECTS.forEach(function(dialect) {
    corpus.forEach(function(source, index) {
        verifyCase(source, dialect, index);
        parseCount += 4;
    });
});

var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
assert.ok(elapsedMs <= MAX_TOTAL_MS,
    'deterministic recovery fuzz exceeded ' + MAX_TOTAL_MS + 'ms: ' + elapsedMs.toFixed(2));

console.log('v2 Wave 2D deterministic recovery fuzz passed ' + JSON.stringify({
    seed: '0x' + FUZZ_SEED.toString(16),
    dialects: DIALECTS.length,
    casesPerDialect: corpus.length,
    parses: parseCount,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    maxTotalMs: MAX_TOTAL_MS
}));
