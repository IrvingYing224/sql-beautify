'use strict';

var assert = require('assert');
var parser = require('../../.tmp/v2-core/core/syntax/parser');
var tokenTable = require('../../.tmp/v2-core/core/syntax/token-table');
var analysis = require('../../.tmp/v2-core/core/analysis');

function buildIndex(source, result, dialect) {
    return analysis.buildStructuralIndex({
        root: result.root,
        leaves: result.leaves,
        tokenTable: tokenTable.buildStructuralTokenTable(result.leaves, source),
        dialect: dialect || 'hive',
        diagnostics: result.diagnostics
    });
}

function isComment(leaf) {
    return leaf.kind === 'line-comment' || leaf.kind === 'block-comment';
}

function ownerLabel(node) {
    return [
        node.kind,
        node.statementKind,
        node.queryKind,
        node.clauseKind,
        node.listRole,
        node.itemRole,
        node.expressionKind,
        node.boundary
    ].filter(Boolean).join(':');
}

function inspect(source, dialect) {
    var result = parser.parseSql(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    var beforeRaw = result.leaves.map(function(leaf) { return leaf.raw; });
    var index = buildIndex(source, result, dialect);
    var bindings = index.commentBindings();
    var nodesById = new Map(index.nodes().map(function(node) {
        return [node.id, node];
    }));
    var leavesById = new Map(result.leaves.map(function(leaf) {
        return [leaf.id, leaf];
    }));
    var commentIds = result.leaves.filter(isComment).map(function(leaf) {
        return leaf.id;
    });

    assert.ok(Array.isArray(bindings), 'bindings must be a real Array');
    assert.ok(Object.isFrozen(bindings), 'bindings array must be frozen');
    bindings.forEach(function(binding) {
        assert.ok(Object.isFrozen(binding), 'each binding must be frozen');
        assert.ok(leavesById.has(binding.commentLeafId), 'binding leaf id must exist');
        assert.ok(isComment(leavesById.get(binding.commentLeafId)),
            'only comment leaves may produce bindings');
        assert.ok(nodesById.has(binding.ownerNodeId), 'binding owner id must exist');
        assert.ok(['leading', 'trailing', 'dangling'].indexOf(binding.placement) >= 0,
            'binding placement must be canonical');
    });

    var boundCommentIds = bindings.map(function(binding) {
        return binding.commentLeafId;
    });
    assert.deepStrictEqual(boundCommentIds, commentIds,
        'bindings must contain every comment exactly once in source order');
    assert.strictEqual(new Set(boundCommentIds).size, boundCommentIds.length,
        'comment binding ids must be unique');
    assert.deepStrictEqual(result.leaves.map(function(leaf) { return leaf.raw; }), beforeRaw,
        'binding must not change comment or source raw');
    assert.strictEqual(beforeRaw.join(''), source, 'canonical leaves must reconstruct source');

    return {
        result: result,
        bindings: bindings,
        nodesById: nodesById,
        leavesById: leavesById
    };
}

function assertExpectedBindings(source, expected, dialect) {
    var inspected = inspect(source, dialect);
    assert.strictEqual(inspected.bindings.length, expected.length, source + ' binding count');
    var actual = inspected.bindings.map(function(binding, index) {
        var leaf = inspected.leavesById.get(binding.commentLeafId);
        var owner = inspected.nodesById.get(binding.ownerNodeId);
        if (expected[index].ownerSlice !== undefined) {
            assert.strictEqual(
                source.slice(owner.span.start, owner.span.end),
                expected[index].ownerSlice,
                leaf.raw + ' exact owner slice'
            );
        }
        return {
            raw: leaf.raw,
            placement: binding.placement,
            owner: ownerLabel(owner)
        };
    });
    assert.deepStrictEqual(actual, expected.map(function(binding) {
        return {
            raw: binding.raw,
            placement: binding.placement,
            owner: binding.owner
        };
    }), source);
}

assertExpectedBindings(
    '-- lead\nSELECT a -- item\n, b, -- comma\n c; -- semi',
    [
        { raw: '-- lead', placement: 'leading', owner: 'statement:query' },
        {
            raw: '-- item',
            placement: 'trailing',
            owner: 'list-item:select-item',
            ownerSlice: 'a'
        },
        {
            raw: '-- comma',
            placement: 'trailing',
            owner: 'list-item:select-item',
            ownerSlice: 'b'
        },
        { raw: '-- semi', placement: 'trailing', owner: 'statement:query' }
    ]
);

assertExpectedBindings(
    '-- detached\n\n-- lead one\n-- lead two\nSELECT\n-- item lead\na;',
    [
        { raw: '-- detached', placement: 'dangling', owner: 'statement:query' },
        { raw: '-- lead one', placement: 'leading', owner: 'statement:query' },
        { raw: '-- lead two', placement: 'leading', owner: 'statement:query' },
        { raw: '-- item lead', placement: 'leading', owner: 'list-item:select-item' }
    ]
);

assertExpectedBindings(
    'WITH x AS (\n-- cte container\nSELECT a\n) SELECT * FROM x;',
    [
        {
            raw: '-- cte container',
            placement: 'dangling',
            owner: 'query:parenthesized'
        }
    ]
);

assertExpectedBindings(
    'WITH a AS (SELECT 1) , -- cte separator\nb AS (SELECT 2) SELECT * FROM a;',
    [
        {
            raw: '-- cte separator',
            placement: 'trailing',
            owner: 'cte',
            ownerSlice: 'a AS (SELECT 1)'
        }
    ]
);

assertExpectedBindings(
    'WITH q AS (SELECT x, /* inner comma */ y) ' +
        'SELECT z, /* outer comma */ w FROM q;',
    [
        {
            raw: '/* inner comma */',
            placement: 'trailing',
            owner: 'list-item:select-item',
            ownerSlice: 'x'
        },
        {
            raw: '/* outer comma */',
            placement: 'trailing',
            owner: 'list-item:select-item',
            ownerSlice: 'z'
        }
    ]
);

assertExpectedBindings(
    'SELECT f(a, /* arg comma */ b), ' +
        'sum(x) OVER (ORDER BY c, /* window comma */ d), ' +
        'CAST(x AS DECIMAL(10, /* type comma */ 2));',
    [
        {
            raw: '/* arg comma */',
            placement: 'trailing',
            owner: 'list-item:function-arg',
            ownerSlice: 'a'
        },
        {
            raw: '/* window comma */',
            placement: 'trailing',
            owner: 'list-item:window-order-item',
            ownerSlice: 'c'
        },
        {
            raw: '/* type comma */',
            placement: 'trailing',
            owner: 'list-item:type-arg',
            ownerSlice: '10'
        }
    ]
);

assertExpectedBindings(
    'SELECT CAST(x AS STRUCT</* type container */a:INT>);',
    [
        {
            raw: '/* type container */',
            placement: 'dangling',
            owner: 'type-expression',
            ownerSlice: 'STRUCT</* type container */a:INT>'
        }
    ]
);

assertExpectedBindings(
    'SELECT f(\n a\n -- before close\n);',
    [
        {
            raw: '-- before close',
            placement: 'dangling',
            owner: 'expression:function-call'
        }
    ]
);

assertExpectedBindings(
    'SELECT a /* multi\nline */\n, b;',
    [
        {
            raw: '/* multi\nline */',
            placement: 'trailing',
            owner: 'list-item:select-item'
        }
    ]
);

assertExpectedBindings(
    'SELECT a /* outer\r\n /* inner */ emoji: 😀 */\r\n, b;',
    [
        {
            raw: '/* outer\r\n /* inner */ emoji: 😀 */',
            placement: 'trailing',
            owner: 'list-item:select-item',
            ownerSlice: 'a'
        }
    ],
    'postgresql'
);

assertExpectedBindings(
    'SELECT\r/* multi\nline */ a;',
    [
        {
            raw: '/* multi\nline */',
            placement: 'leading',
            owner: 'list-item:select-item',
            ownerSlice: 'a'
        }
    ]
);

assertExpectedBindings(
    'SELECT\n/* blank separated */\r\n\r\n a;',
    [
        {
            raw: '/* blank separated */',
            placement: 'dangling',
            owner: 'clause:select'
        }
    ]
);

assertExpectedBindings(
    'SELECT CASE\n-- branch\nWHEN a THEN b END, sum(a) OVER (\n-- window container\nPARTITION BY b\n);',
    [
        { raw: '-- branch', placement: 'leading', owner: 'case-branch' },
        {
            raw: '-- window container',
            placement: 'dangling',
            owner: 'window-spec'
        }
    ]
);

assertExpectedBindings(
    'SELECT a @ /* opaque comment */ b;',
    [
        {
            raw: '/* opaque comment */',
            placement: 'dangling',
            owner: 'opaque:expression'
        }
    ]
);

assertExpectedBindings(
    '\r\n-- comment-only source\r\n',
    [
        {
            raw: '-- comment-only source',
            placement: 'dangling',
            owner: 'program'
        }
    ]
);

(function testWhitespaceAndNewlineTriviaDoNotProduceBindings() {
    var inspected = inspect('SELECT \n\t 1;');
    assert.deepStrictEqual(inspected.bindings, []);
}());

(function testBindingsAreDeterministicAndRejectMutation() {
    var source = 'SELECT a, /* first */ b; -- second';
    var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    var table = tokenTable.buildStructuralTokenTable(result.leaves, source);
    var first = analysis.buildStructuralIndex({
        root: result.root,
        leaves: result.leaves,
        tokenTable: table,
        dialect: 'hive',
        diagnostics: result.diagnostics
    }).commentBindings();
    var second = analysis.buildStructuralIndex({
        root: result.root,
        leaves: result.leaves,
        tokenTable: table,
        dialect: 'hive',
        diagnostics: result.diagnostics
    }).commentBindings();
    assert.deepStrictEqual(second, first);
    assert.throws(function() {
        first.push({ commentLeafId: -1, ownerNodeId: -1, placement: 'dangling' });
    }, TypeError);
    assert.throws(function() {
        first[0].placement = 'dangling';
    }, TypeError);
}());

(function testDenseCommentsUnderNestedContainersRemainBounded() {
    var depth = 48;
    var commentCount = 20000;
    var source = 'SELECT ' + '('.repeat(depth) +
        '/* dense */'.repeat(commentCount) + '1' + ')'.repeat(depth) + ';';
    var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    var table = tokenTable.buildStructuralTokenTable(result.leaves, source);
    var started = process.hrtime.bigint();
    var bindings = analysis.buildStructuralIndex({
        root: result.root,
        leaves: result.leaves,
        tokenTable: table,
        dialect: 'hive',
        diagnostics: result.diagnostics
    }).commentBindings();
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(bindings.length, commentCount);
    assert.ok(elapsedMs < 1500,
        'dense nested trivia binding must stay linear/bounded, elapsed=' + elapsedMs + 'ms');
}());

(function testConsecutiveCommentOnlyLinesRemainLinear() {
    var commentCount = 20000;
    var source = '-- dense line\n'.repeat(commentCount) + 'SELECT 1;';
    var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    var table = tokenTable.buildStructuralTokenTable(result.leaves, source);
    var started = process.hrtime.bigint();
    var bindings = analysis.buildStructuralIndex({
        root: result.root,
        leaves: result.leaves,
        tokenTable: table,
        dialect: 'hive',
        diagnostics: result.diagnostics
    }).commentBindings();
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(bindings.length, commentCount);
    assert.ok(bindings.every(function(binding) {
        return binding.placement === 'leading' &&
            binding.ownerNodeId === result.root.children[0].id;
    }), 'consecutive comment-only lines must lead the following statement');
    assert.ok(elapsedMs < 1500,
        'comment-only line binding must stay linear/bounded, elapsed=' + elapsedMs + 'ms');
}());

console.log('Wave 2D trivia binding tests passed.');
