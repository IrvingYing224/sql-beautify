'use strict';

var assert = require('assert');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parser = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js'));

function parse(source, mode) {
    return parser.parseSql(source, { dialect: 'hive', mode: mode || 'document' });
}

function flatten(rootNode) {
    var nodes = [];
    var stack = [rootNode];
    while (stack.length > 0) {
        var node = stack.pop();
        nodes.push(node);
        if (Array.isArray(node.children)) {
            for (var i = node.children.length - 1; i >= 0; i--) {
                stack.push(node.children[i]);
            }
        }
    }
    return nodes;
}

function slice(source, node) {
    return source.slice(node.span.start, node.span.end);
}

(function testClauseMarkersRespectExpressionContextAndMissingBodies() {
    var source = 'SELECT 1 FROM t WHERE ok AND window(x)';
    var result = parse(source);
    assert.strictEqual(result.root.children[0].statementKind, 'query');
    var clauses = flatten(result.root).filter(function(node) {
        return node.kind === 'clause';
    });
    assert.deepStrictEqual(clauses.map(function(node) { return node.clauseKind; }),
        ['select', 'from', 'where']);
    var where = clauses.filter(function(node) { return node.clauseKind === 'where'; })[0];
    assert.strictEqual(
        result.leaves.slice(where.bodyLeafRange.start, where.bodyLeafRange.end)
            .map(function(leaf) { return leaf.raw; }).join('').trim(),
        'ok AND window(x)'
    );

    var incomplete = parse('SELECT FROM t');
    assert.strictEqual(incomplete.root.children[0].statementKind, 'opaque');
    assert.ok(incomplete.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_INCOMPLETE_CLAUSE' &&
            diagnostic.recovery === 'preserve-statement';
    }), 'missing SELECT body must fail closed');
}());

(function testKeywordShapedNamesDoNotBecomeClauseOrSetMarkers() {
    var cases = [
        {
            source: 'SELECT id FROM t WHERE union = 1',
            clauses: ['select', 'from', 'where']
        },
        {
            source: 'SELECT union(x) AS c',
            clauses: ['select']
        },
        {
            source: 'SELECT DISTINCT union',
            clauses: ['select']
        },
        {
            source: 'SELECT x FROM union',
            clauses: ['select', 'from']
        },
        {
            source: 'SELECT id FROM t ORDER BY union',
            clauses: ['select', 'from', 'order-by']
        },
        {
            source: 'SELECT id FROM t WHERE x = union(y)',
            clauses: ['select', 'from', 'where']
        },
        {
            source: 'SELECT x FROM t WHERE where = 1',
            clauses: ['select', 'from', 'where']
        },
        {
            source: 'SELECT x FROM t GROUP BY x HAVING having = 1',
            clauses: ['select', 'from', 'group-by', 'having']
        },
        {
            source: 'SELECT from',
            clauses: ['select']
        }
    ];

    cases.forEach(function(testCase) {
        var result = parse(testCase.source);
        assert.strictEqual(
            result.root.children[0].statementKind,
            'query',
            'keyword-shaped name must remain in its expression context: ' + testCase.source
        );
        assert.deepStrictEqual(
            flatten(result.root).filter(function(node) {
                return node.kind === 'clause';
            }).map(function(node) {
                return node.clauseKind;
            }),
            testCase.clauses,
            'keyword-shaped name must not create a structural marker: ' + testCase.source
        );
    });
}());

(function testJoinMarkersStopInsideOnExpressions() {
    var source = 'SELECT 1 FROM a JOIN b ON ok AND join(b.x)';
    var result = parse(source);
    assert.strictEqual(result.root.children[0].statementKind, 'query');
    var nodes = flatten(result.root);
    assert.strictEqual(nodes.filter(function(node) {
        return node.kind === 'relation' && node.relationKind === 'join';
    }).length, 1, 'join(...) in ON expression must not create a second JOIN relation');
    var on = nodes.filter(function(node) {
        return node.kind === 'clause' && node.clauseKind === 'join-on';
    })[0];
    assert.strictEqual(
        result.leaves.slice(on.bodyLeafRange.start, on.bodyLeafRange.end)
            .map(function(leaf) { return leaf.raw; }).join('').trim(),
        'ok AND join(b.x)'
    );

    [
        'SELECT 1 FROM a JOIN b ON join((b.x)) = 1',
        'SELECT 1 FROM a JOIN b ON x AND join IS NULL'
    ].forEach(function(onSource) {
        var onResult = parse(onSource);
        var onNodes = flatten(onResult.root);
        assert.strictEqual(
            onResult.root.children[0].statementKind,
            'query',
            'JOIN-shaped ON operand must remain inside the ON expression: ' + onSource
        );
        assert.strictEqual(onNodes.filter(function(node) {
            return node.kind === 'relation' && node.relationKind === 'join';
        }).length, 1, 'ON expression must not create another JOIN relation: ' + onSource);
    });

    var tableFunctionSource = 'SELECT 1 FROM join((x)) f';
    var tableFunctionResult = parse(tableFunctionSource);
    var tableFunctionNodes = flatten(tableFunctionResult.root);
    assert.strictEqual(
        tableFunctionResult.root.children[0].statementKind,
        'query',
        'keyword-shaped table function must not become a JOIN marker'
    );
    assert.strictEqual(tableFunctionNodes.filter(function(node) {
        return node.kind === 'relation' && node.relationKind === 'table-function';
    }).length, 1, 'join((x)) must remain one table-function relation');
}());

(function testLeftAntiJoinIsAFirstClassJoinHead() {
    var source = [
        'SELECT a.id FROM a',
        'LEFT SEMI JOIN b ON a.id=b.id',
        'LEFT ANTI JOIN c ON a.id=c.id',
        'FULL OUTER JOIN d ON a.id=d.id'
    ].join(' ');
    var result = parse(source);
    assert.strictEqual(result.root.children[0].statementKind, 'query');
    var nodes = flatten(result.root);
    var joins = nodes.filter(function(node) {
        return node.kind === 'relation' && node.relationKind === 'join';
    });
    assert.strictEqual(joins.length, 3);
    assert.ok(joins.some(function(node) {
        return /^LEFT ANTI JOIN\b/i.test(slice(source, node));
    }), 'LEFT ANTI JOIN must own an independent relation range');
    assert.deepStrictEqual(nodes.filter(function(node) {
        return node.kind === 'clause' && node.clauseKind === 'join-on';
    }).map(function(node) {
        return result.leaves.slice(node.bodyLeafRange.start, node.bodyLeafRange.end)
            .map(function(leaf) { return leaf.raw; }).join('').trim();
    }), ['a.id=b.id', 'a.id=c.id', 'a.id=d.id']);
}());

(function testSetTailClausesBelongToSetQuery() {
    var source = [
        'SELECT a FROM t',
        'UNION ALL',
        'SELECT b FROM u',
        'ORDER BY b',
        'LIMIT 5'
    ].join('\n');
    var result = parse(source);
    assert.strictEqual(result.root.children[0].statementKind, 'query');
    var setQuery = flatten(result.root).filter(function(node) {
        return node.kind === 'query' && node.queryKind === 'set';
    })[0];
    assert.ok(setQuery, 'set query is required');
    assert.deepStrictEqual(setQuery.children.slice(-2).map(function(node) {
        return node.kind === 'clause' ? node.clauseKind : node.kind;
    }), ['order-by', 'limit'], 'ORDER BY/LIMIT must be direct set-query tail clauses');
    var operands = setQuery.children.filter(function(node) { return node.kind === 'query'; });
    assert.strictEqual(operands.length, 2);
    assert.strictEqual(operands[1].children.some(function(node) {
        return node.kind === 'clause' &&
            (node.clauseKind === 'order-by' || node.clauseKind === 'limit');
    }), false, 'right SELECT operand must not own set-level tail clauses');

    var missingLeft = parse('SELECT UNION SELECT 1');
    assert.strictEqual(missingLeft.root.children[0].statementKind, 'opaque');
    assert.ok(missingLeft.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_INCOMPLETE_CLAUSE';
    }), 'set operator with a missing left operand must fail closed');

    var malformedParenthesizedRight = parse('SELECT 1 UNION (x)');
    assert.strictEqual(
        malformedParenthesizedRight.root.children[0].statementKind,
        'opaque',
        'set operator followed by a non-query parenthesized value must fail closed'
    );
}());

(function testWindowOperandIsNotASelectAlias() {
    var source = 'SELECT sum(x) OVER w FROM t WINDOW w AS (PARTITION BY k)';
    var result = parse(source);
    assert.strictEqual(result.root.children[0].statementKind, 'query');
    var selectItem = flatten(result.root).filter(function(node) {
        return node.kind === 'list-item' && node.itemRole === 'select-item';
    })[0];
    assert.ok(selectItem, 'SELECT item is required');
    assert.strictEqual(selectItem.alias, null, 'OVER window name must not become item alias');
    assert.strictEqual(
        slice(source, selectItem),
        'sum(x) OVER w',
        'SELECT item must retain the complete named-window expression range'
    );
}());

(function testProtectedImplicitAliasRemainsAtomic() {
    var quotedAlias = '`' + new Array(32769).join('A') + '`';
    var source = "SELECT 'FROM UNION JOIN WHERE' " + quotedAlias + ' FROM t';
    var result = parse(source);
    assert.strictEqual(result.root.children[0].statementKind, 'query');
    var selectItem = flatten(result.root).filter(function(node) {
        return node.kind === 'list-item' && node.itemRole === 'select-item';
    })[0];
    assert.ok(selectItem && selectItem.alias, 'quoted identifier must remain an implicit alias');
    assert.strictEqual(
        result.leaves.slice(
            selectItem.alias.nameLeafRange.start,
            selectItem.alias.nameLeafRange.end
        ).map(function(leaf) { return leaf.raw; }).join(''),
        quotedAlias,
        'protected alias bytes must remain atomic and unchanged'
    );
}());

(function testWithInsertOverwriteCombination() {
    var source = [
        'WITH s AS (SELECT a,b FROM source)',
        'INSERT OVERWRITE TABLE target',
        'SELECT a AS user_id, b AS amount FROM s'
    ].join('\n');
    var result = parse(source);
    assert.strictEqual(result.root.children[0].statementKind, 'insert-query');
    var clauseKinds = flatten(result.root).filter(function(node) {
        return node.kind === 'clause';
    }).map(function(node) { return node.clauseKind; });
    ['with', 'insert', 'select', 'from'].forEach(function(kind) {
        assert.ok(clauseKinds.indexOf(kind) >= 0, 'missing structured clause ' + kind);
    });
    assert.strictEqual(result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' ||
            diagnostic.recovery === 'preserve-target';
    }), false, 'WITH + INSERT must not preserve a wider boundary');
}());

console.log('v2 Wave 2B final hardening tests passed');
