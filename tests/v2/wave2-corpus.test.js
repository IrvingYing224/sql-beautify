'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var analysis = require(path.join(root, '.tmp', 'v2-core', 'core', 'analysis', 'index.js'));
var tokenTable = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js'));
var invariants = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js'));
var evaluationCases = require('../fixtures/v2-sql-corpus-cases');

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

function validateResult(label, source, dialect, result) {
    var preservesTarget = result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-target';
    });
    assert.strictEqual(
        result.status,
        preservesTarget ? 'preserved' : 'analyzed',
        label + ' status must match target-level recovery while retaining a trusted index'
    );
    assert.ok(result.index && Object.isFrozen(result.index), label + ' frozen index');
    assert.strictEqual(result.leaves.map(function(leaf) { return leaf.raw; }).join(''),
        source, label + ' source conservation');
    assert.strictEqual(result.root.id, 0, label + ' root id');
    assert.deepStrictEqual(result.root.span, { start: 0, end: source.length },
        label + ' full-source root span');

    var table = tokenTable.buildStructuralTokenTable(result.leaves, source);
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source,
        dialect: dialect,
        tokenTable: table
    });
    assert.strictEqual(checked.ok, true,
        label + ' invariant failures: ' + JSON.stringify(checked.failures, null, 2));

    var nodes = flatten(result.root);
    var ids = nodes.map(function(node) { return node.id; }).sort(function(a, b) { return a - b; });
    assert.deepStrictEqual(ids, Array.from({ length: nodes.length }, function(_, index) {
        return index;
    }), label + ' contiguous deterministic node ids');

    nodes.filter(function(node) { return node.kind === 'opaque'; }).forEach(function(node) {
        assert.ok(result.diagnostics.some(function(diagnostic) {
            return diagnostic.code === node.reasonCode &&
                diagnostic.capabilityId === node.capabilityId &&
                diagnostic.span.start === node.span.start &&
                diagnostic.span.end === node.span.end;
        }), label + ' opaque node requires exact matching diagnostic');
        assert.deepStrictEqual(
            result.index.capabilityForOpaque(node.id),
            node.capabilityId === null ? null : result.index.capability(node.capabilityId),
            label + ' opaque capability index'
        );
    });

    var commentCount = result.leaves.filter(function(leaf) {
        return leaf.kind === 'line-comment' || leaf.kind === 'block-comment';
    }).length;
    assert.strictEqual(result.index.commentBindings().length, commentCount,
        label + ' every comment has one analysis binding');
    result.index.lists().forEach(function(list) {
        list.separatorLeafIds.forEach(function(separatorLeafId) {
            assert.ok(result.index.separatorOwner(separatorLeafId),
                label + ' every list separator has one owner');
        });
    });

    var second = analysis.analyzeSql(source, { dialect: dialect, mode: 'document' });
    assert.strictEqual(second.status, result.status, label + ' deterministic status');
    assert.deepStrictEqual(second.root, result.root, label + ' deterministic CST');
    assert.deepStrictEqual(second.leaves, result.leaves, label + ' deterministic leaves');
    assert.deepStrictEqual(second.diagnostics, result.diagnostics,
        label + ' deterministic diagnostics');
    assert.deepStrictEqual(second.index.snapshot(), result.index.snapshot(),
        label + ' deterministic structural index');
}

assert.strictEqual(evaluationCases.length, 16, 'Wave 0 corpus size is a fixed Wave 2 input');

evaluationCases.forEach(function(testCase) {
    var result = analysis.analyzeSql(testCase.source, {
        dialect: testCase.dialect,
        mode: 'document'
    });
    validateResult(testCase.id, testCase.source, testCase.dialect, result);

    testCase.atomicLexemes.forEach(function(lexeme) {
        assert.ok(result.leaves.some(function(leaf) { return leaf.raw === lexeme; }),
            testCase.id + ' atomic lexeme must remain one leaf: ' + lexeme);
    });

    var statementKinds = result.root.children.map(function(statement) {
        return statement.statementKind;
    });
    var recoveries = result.diagnostics.map(function(diagnostic) {
        return diagnostic.recovery;
    });

    if (testCase.id === 'unterminated-string') {
        assert.ok(statementKinds.every(function(kind) { return kind === 'opaque'; }),
            testCase.id + ' must not expose a partial trusted query tree');
        assert.ok(recoveries.indexOf('preserve-target') >= 0,
            testCase.id + ' must preserve the complete target');
        assert.ok(result.diagnostics.every(function(diagnostic) {
            return diagnostic.capabilityId === null;
        }), testCase.id + ' must not invent a capability identity');
    } else if (testCase.id === 'hive-complex-type-ddl') {
        assert.deepStrictEqual(statementKinds, ['opaque']);
        assert.ok(recoveries.indexOf('verbatim-node') >= 0,
            testCase.id + ' must follow the registry verbatim capability state');
        assert.ok(result.diagnostics.some(function(diagnostic) {
            return diagnostic.capabilityId === 'hive-ddl';
        }), testCase.id + ' must expose hive-ddl identity');
        assert.strictEqual(recoveries.indexOf('preserve-statement'), -1);
    } else if (testCase.id === 'match-recognize-construct') {
        assert.deepStrictEqual(statementKinds, ['opaque']);
        assert.ok(recoveries.indexOf('preserve-statement') >= 0,
            testCase.id + ' remains statement-level opaque in the current parser');
        assert.ok(result.diagnostics.some(function(diagnostic) {
            return diagnostic.capabilityId === 'match-recognize';
        }), testCase.id + ' must expose match-recognize identity');
    } else {
        assert.ok(statementKinds.every(function(kind) {
            return kind === 'query' || kind === 'insert-query';
        }), testCase.id + ' declared query subset must have a structured statement boundary');
        assert.strictEqual(recoveries.indexOf('preserve-statement'), -1,
            testCase.id + ' must not preserve the whole statement');
        assert.strictEqual(recoveries.indexOf('preserve-target'), -1,
            testCase.id + ' must not preserve the whole target');
    }
});

[
    'hive-cte-window-comments.sql',
    'hive-template-variables.sql'
].forEach(function(fileName) {
    var source = fs.readFileSync(path.join(
        root,
        'tests',
        'fixtures',
        'production-corpus',
        'public',
        fileName
    ), 'utf8');
    var result = analysis.analyzeSql(source, { dialect: 'hive', mode: 'document' });
    validateResult('production/' + fileName, source, 'hive', result);
    assert.ok(result.root.children.length > 0, fileName + ' must contain statements');
    assert.ok(result.root.children.every(function(statement) {
        return statement.statementKind === 'query' || statement.statementKind === 'empty';
    }), fileName + ' must structure every non-empty Hive query statement');
    assert.strictEqual(result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' ||
            diagnostic.recovery === 'preserve-target';
    }), false, fileName + ' must stay within proven opaque expression boundaries');
});

console.log('v2 Wave 2 corpus tests passed (16 Wave 0 + 2 production-shaped cases)');
