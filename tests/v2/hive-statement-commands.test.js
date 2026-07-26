'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var invariants = require('../../.tmp/v2-core/core/syntax/invariants.js');
var parser = require('../../.tmp/v2-core/core/syntax/parser.js');

function flatten(root) {
    var nodes = [];
    var work = [root];
    while (work.length > 0) {
        var node = work.pop();
        nodes.push(node);
        if (Array.isArray(node.children)) {
            for (var index = node.children.length - 1; index >= 0; index--) {
                work.push(node.children[index]);
            }
        }
    }
    return nodes;
}

function sourceSlice(source, leaves, range) {
    if (range.start === range.end) {
        var boundary = leaves[range.start];
        return boundary ? source.slice(boundary.span.start, boundary.span.start) : '';
    }
    return source.slice(
        leaves[range.start].span.start,
        leaves[range.end - 1].span.end
    );
}

function parseHive(source, mode) {
    var result = parser.parseSql(source, {
        dialect: 'hive',
        mode: mode || 'document'
    });
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source
    });
    assert.strictEqual(checked.ok, true,
        source + ' invariant failures: ' + JSON.stringify(checked.failures));
    return result;
}

function assertFullyStructured(result, source) {
    assert.strictEqual(flatten(result.root).some(function(node) {
        return node.kind === 'opaque';
    }), false, source + ' must not contain an opaque recovery node');
    assert.deepStrictEqual(result.diagnostics, [], source + ' diagnostics');
}

(function testInsertIntoStructuredVariants() {
    [
        'INSERT INTO dst SELECT id FROM src',
        'INSERT INTO TABLE dst PARTITION (ds=1) WITH q AS (SELECT id FROM src) SELECT id FROM q',
        'WITH q AS (SELECT id FROM src) INSERT INTO dst SELECT id FROM q',
        'INSERT INTO dst WITH q AS (SELECT id FROM src) SELECT id FROM q'
    ].forEach(function(source) {
        var result = parseHive(source);
        assertFullyStructured(result, source);
        assert.strictEqual(result.root.children[0].statementKind, 'insert-query');
        var insertNodes = flatten(result.root).filter(function(node) {
            return node.capabilityId === 'insert-into-partition-select';
        });
        assert.ok(insertNodes.some(function(node) { return node.kind === 'query'; }),
            source + ' query capability');
        assert.ok(insertNodes.some(function(node) {
            return node.kind === 'clause' && node.clauseKind === 'insert';
        }), source + ' insert clause capability');
        insertNodes.filter(function(node) {
            return node.kind === 'clause' && node.clauseKind === 'partition';
        }).forEach(function(node) {
            assert.strictEqual(node.capabilityId, 'insert-into-partition-select');
        });
    });
}());

(function testSetBoundedNodesAndVerbatimPayload() {
    [
        { source: 'SET', key: null, assignment: false },
        { source: 'SET hive.exec.dynamic.partition', key: 'hive.exec.dynamic.partition', assignment: false },
        { source: 'set hivevar:day=2026-07-26', key: 'hivevar:day', assignment: true }
    ].forEach(function(testCase) {
        var result = parseHive(testCase.source);
        assertFullyStructured(result, testCase.source);
        var statement = result.root.children[0];
        assert.strictEqual(statement.statementKind, 'set');
        var nodes = flatten(result.root);
        var command = nodes.filter(function(node) {
            return node.kind === 'set-statement';
        })[0];
        assert.ok(command, testCase.source + ' set-statement node');
        assert.strictEqual(command.capabilityId, 'set-command');
        var payload = nodes.filter(function(node) {
            return node.kind === 'set-payload';
        })[0] || null;
        if (testCase.key === null) {
            assert.strictEqual(payload, null);
            assert.strictEqual(command.payloadChildId, null);
        } else {
            assert.ok(payload);
            assert.strictEqual(
                sourceSlice(testCase.source, result.leaves, payload.keyLeafRange),
                testCase.key
            );
            assert.strictEqual(payload.assignmentLeafId !== null, testCase.assignment);
        }
    });

    var source = "set  hiveconf:path =  'MiXeD select' = C:/Tmp/X /*keep*/";
    var first = formatApi.formatSql(source, {
        dialect: 'hive',
        keywordCase: 'upper'
    });
    assert.strictEqual(first.status, 'formatted');
    assert.strictEqual(
        first.text,
        "SET hiveconf:path =  'MiXeD select' = C:/Tmp/X /*keep*/",
        'SET must normalize only the head gap and preserve every payload byte'
    );
    var second = formatApi.formatSql(first.text, {
        dialect: 'hive',
        keywordCase: 'upper'
    });
    assert.strictEqual(second.status, 'unchanged');
    assert.strictEqual(second.text, first.text);

    var fragment = parseHive('set hive.exec.flag=true', 'fragment');
    assert.strictEqual(fragment.root.children[0].statementKind, 'set');
    assertFullyStructured(fragment, 'SET fragment');
}());

(function testMalformedCommandsFailClosed() {
    [
        'INSERT INTO',
        'INSERT INTO TABLE',
        'INSERT INTO dst',
        'INSERT INTO dst VALUES (1)',
        'INSERT INTO dst PARTITION () SELECT 1',
        'INSERT INTO dst PARTITION (ds=1) junk SELECT 1',
        'INSERT INTO dst AS target SELECT 1',
        'INSERT INTO dst WITH q AS (SELECT 1) INSERT INTO nested SELECT 1',
        'SET =x',
        'SET key=',
        'SET a b',
        'SET a+b=value',
        'SET a::b=value',
        'SET `quoted`=value',
        'SET a.=value'
    ].forEach(function(source) {
        var result = parseHive(source);
        assert.strictEqual(result.root.children[0].statementKind, 'opaque', source);
        assert.ok(result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement';
        }), source + ' must preserve the whole statement');
        assert.strictEqual(formatApi.formatSql(source, { dialect: 'hive' }).text, source);
    });
}());

(function testHiveCommandDialectIsolation() {
    ['generic', 'postgresql', 'mysql'].forEach(function(dialect) {
        [
            'INSERT INTO dst SELECT id FROM src',
            'SET hive.exec.dynamic.partition=true'
        ].forEach(function(source) {
            var result = parser.parseSql(source, { dialect: dialect, mode: 'document' });
            assert.strictEqual(result.root.children[0].statementKind, 'opaque',
                dialect + ': ' + source);
            assert.strictEqual(flatten(result.root).some(function(node) {
                return node.kind === 'set-statement' ||
                    node.capabilityId === 'insert-into-partition-select' ||
                    node.capabilityId === 'set-command';
            }), false, dialect + ' must not inherit Hive command capabilities');
        });
    });
}());

function replaceNode(node, nodeId, mutate) {
    var changed = {};
    Object.keys(node).forEach(function(key) {
        changed[key] = node[key];
    });
    if (node.id === nodeId) {
        mutate(changed, node);
    }
    if (Array.isArray(node.children)) {
        changed.children = Object.freeze(node.children.map(function(child) {
            return replaceNode(child, nodeId, mutate);
        }));
    }
    return Object.freeze(changed);
}

function assertHostileRejected(source, selectNode, mutate, label) {
    var artifact = parser.parseSqlArtifact(source, {
        dialect: 'hive',
        mode: 'document'
    });
    var target = flatten(artifact.output.root).filter(selectNode)[0];
    assert.ok(target, label + ' target');
    var hostileRoot = replaceNode(artifact.output.root, target.id, mutate);
    var result = invariants.validateSyntaxInvariants({
        root: hostileRoot,
        leaves: artifact.output.leaves,
        source: source,
        tokenTable: artifact.tokenTable
    });
    assert.strictEqual(result.ok, false, label);
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'INV_RELATIONSHIP' ||
            failure.code === 'INV_OWNER_REFERENCE';
    }), label + ': ' + JSON.stringify(result.failures));
}

(function testCapabilityAndSetBoundsFailClosedUnderHostileClones() {
    var insertSource = 'INSERT INTO dst PARTITION (ds=1) SELECT id FROM src';
    assertHostileRejected(
        insertSource,
        function(node) {
            return node.kind === 'query' &&
                node.capabilityId === 'insert-into-partition-select';
        },
        function(node) {
            node.capabilityId = 'insert-overwrite-partition-select';
        },
        'INSERT INTO query cannot claim overwrite capability'
    );
    assertHostileRejected(
        insertSource,
        function(node) {
            return node.kind === 'clause' && node.clauseKind === 'partition';
        },
        function(node) {
            node.capabilityId = 'insert-overwrite-partition-select';
        },
        'INSERT INTO partition capability must match its query'
    );
    assertHostileRejected(
        insertSource,
        function(node) {
            return node.kind === 'clause' && node.clauseKind === 'insert';
        },
        function(node) {
            node.headLeafRange = Object.freeze({
                start: node.headLeafRange.start,
                end: node.leafRange.end
            });
        },
        'INSERT head rejects unclaimed syntax tokens'
    );
    assertHostileRejected(
        insertSource,
        function(node) {
            return node.kind === 'relation' && node.relationKind === 'table';
        },
        function(node) { node.alias = 'target'; },
        'INSERT target cannot carry an alias'
    );
    assertHostileRejected(
        insertSource,
        function(node) {
            return node.kind === 'relation' && node.relationKind === 'table';
        },
        function(node) { node.relationKind = 'subquery'; },
        'INSERT target must remain a plain table relation'
    );

    var setSource = 'SET hive.exec.flag=true';
    assertHostileRejected(
        setSource,
        function(node) { return node.kind === 'set-payload'; },
        function(node) { node.assignmentLeafId = node.keyLeafRange.start; },
        'SET assignment must be the exact equals leaf'
    );
    assertHostileRejected(
        setSource,
        function(node) { return node.kind === 'set-payload'; },
        function(node) {
            node.keyLeafRange = Object.freeze({
                start: node.keyLeafRange.start,
                end: node.keyLeafRange.end - 2
            });
        },
        'SET key and assignment cannot hide unclaimed syntax'
    );
    assertHostileRejected(
        setSource,
        function(node) { return node.kind === 'set-payload'; },
        function(node) {
            node.leafRange = Object.freeze({ start: 0, end: 1 });
            node.keyLeafRange = Object.freeze({ start: 0, end: 1 });
            node.assignmentLeafId = null;
            node.valueLeafRange = null;
        },
        'SET payload cannot precede and swallow the command head'
    );
    assertHostileRejected(
        setSource,
        function(node) { return node.kind === 'set-statement'; },
        function(node) { node.capabilityId = 'set-operations'; },
        'SET command capability allowlist'
    );
}());

(function testSetAnalysisOwnsExplicitBoundedPayloadClaim() {
    var source = 'SET hive.exec.flag=select MiXeD';
    var analysis = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(analysis.status, 'analyzed');
    var payload = analysis.index.nodes().filter(function(node) {
        return node.kind === 'set-payload';
    })[0];
    assert.ok(payload);
    var claims = require('../../.tmp/v2-core/core/layout/verbatim-claims.js')
        .dominatingVerbatimClaims(analysis);
    var claim = claims.claimForOwner(payload.id);
    assert.ok(claim);
    assert.strictEqual(claim.trigger.kind, 'bounded-payload');
    assert.strictEqual(claim.trigger.capabilityId, 'set-command');
}());

console.log('v2 Hive INSERT INTO and SET command tests passed');
