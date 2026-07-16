'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parserPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js');
var depthPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser-depth.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var lexerPath = path.join(root, '.tmp', 'v2-core', 'core', 'lexer', 'lossless-lexer.js');
var factoryPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'node-factory.js');
var windowPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'window-parser.js');

assert.ok(fs.existsSync(parserPath), 'Wave 2D parser build is required');
assert.ok(fs.existsSync(depthPath), 'Wave 2D shared parser depth contract is required');

var parser = require(parserPath);
var parserDepth = require(depthPath);
var invariants = require(invariantsPath);
var tokenTableModule = require(tokenTablePath);
var lexer = require(lexerPath);
var nodeFactory = require(factoryPath);
var windowParser = require(windowPath);

function repeat(value, count) {
    return new Array(count + 1).join(value);
}

function nodesOf(rootNode, kind) {
    var matches = [];
    var stack = [rootNode];
    while (stack.length > 0) {
        var node = stack.pop();
        if (node.kind === kind) {
            matches.push(node);
        }
        if (Array.isArray(node.children)) {
            for (var i = node.children.length - 1; i >= 0; i--) {
                stack.push(node.children[i]);
            }
        }
    }
    return matches;
}

function parseChecked(source, dialect) {
    var options = { dialect: dialect || 'hive', mode: 'document' };
    var result = parser.parseSql(source, options);
    assert.strictEqual(result.leaves.map(function(leaf) {
        return leaf.raw;
    }).join(''), source, 'depth recovery must conserve source');

    var table = tokenTableModule.buildStructuralTokenTable(result.leaves, source);
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source,
        dialect: options.dialect,
        tokenTable: table
    });
    assert.strictEqual(
        checked.ok,
        true,
        'depth result invariants: ' + JSON.stringify(checked.failures, null, 2)
    );
    assert.deepStrictEqual(
        parser.parseSql(source, options),
        result,
        'depth parse must be deterministic'
    );
    assert.strictEqual(result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_INTERNAL_INVARIANT';
    }), false, 'depth recovery must not become an internal invariant failure');
    return result;
}

function assertPass(label, source, dialect) {
    var result = parseChecked(source, dialect);
    assert.strictEqual(result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED';
    }), false, label + ' must stay within the shared budget');
    assert.deepStrictEqual(nodesOf(result.root, 'opaque'), [], label + ' must stay structured');
}

function assertRecovered(label, source, expectedRecovery, expectedBoundary, dialect) {
    var result = parseChecked(source, dialect);
    var depthDiagnostics = result.diagnostics.filter(function(diagnostic) {
        return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED';
    });
    assert.ok(depthDiagnostics.length > 0, label + ' must report SYN_MAX_DEPTH_EXCEEDED');
    assert.ok(depthDiagnostics.some(function(diagnostic) {
        return diagnostic.recovery === expectedRecovery;
    }), label + ' recovery must include ' + expectedRecovery);
    var opaque = nodesOf(result.root, 'opaque');
    assert.ok(opaque.length > 0, label + ' must recover as opaque');
    assert.ok(opaque.some(function(node) {
        return node.boundary === expectedBoundary;
    }), label + ' must recover at the ' + expectedBoundary + ' boundary');
}

function querySource(depth) {
    return repeat('(', depth) + 'SELECT 1' + repeat(')', depth);
}

function parenthesizedExpressionSource(depth) {
    return 'SELECT ' + repeat('(', depth) + 'x' + repeat(')', depth);
}

function prefixExpressionSource(depth) {
    return 'SELECT ' + repeat('NOT ', depth) + 'x';
}

function castTypeSource(totalDepth) {
    var typeDepth = totalDepth - 1;
    return 'SELECT CAST(x AS ' +
        repeat('ARRAY<', typeDepth) + 'INT' + repeat('>', typeDepth) + ')';
}

function windowSource(prefixDepth) {
    return 'SELECT ' + repeat('NOT ', prefixDepth) + 'x OVER (PARTITION BY y)';
}

function mixedSource(queryDepth, expressionDepth, typeDepth) {
    return repeat('(', queryDepth) +
        'SELECT ' + repeat('(', expressionDepth) +
        'CAST(x AS ' + repeat('ARRAY<', typeDepth) + 'INT' +
        repeat('>', typeDepth) + ')' +
        repeat(')', expressionDepth) + repeat(')', queryDepth);
}

(function testSharedDepthContractHasOneExactBoundary() {
    assert.strictEqual(parserDepth.PARSER_NESTING_BUDGET, 256);
    assert.doesNotThrow(function() {
        parserDepth.assertParserDepth({ start: 0, end: 1 }, 255);
    });
    assert.throws(function() {
        parserDepth.assertParserDepth({ start: 0, end: 1 }, 256);
    }, function(error) {
        return error && error.code === 'SYN_MAX_DEPTH_EXCEEDED';
    });
    assert.throws(function() {
        parserDepth.assertParserDepth({ start: 0, end: 1 }, 257);
    }, function(error) {
        return error && error.code === 'SYN_MAX_DEPTH_EXCEEDED';
    });
}());

(function testQueryDepth255PassesAnd256PlusRecoversAtStatement() {
    assertPass('query depth 255', querySource(255));
    assertRecovered(
        'query depth 256', querySource(256), 'preserve-statement', 'statement'
    );
    assertRecovered(
        'query depth 257', querySource(257), 'preserve-statement', 'statement'
    );
}());

(function testExpressionDepth255PassesAnd256PlusRecoversLocally() {
    assertPass('parenthesized expression depth 255', parenthesizedExpressionSource(255));
    assertRecovered(
        'parenthesized expression depth 256',
        parenthesizedExpressionSource(256),
        'verbatim-node',
        'expression'
    );
    assertRecovered(
        'parenthesized expression depth 257',
        parenthesizedExpressionSource(257),
        'verbatim-node',
        'expression'
    );

    assertPass('prefix expression depth 255', prefixExpressionSource(255));
    assertRecovered(
        'prefix expression depth 256',
        prefixExpressionSource(256),
        'verbatim-node',
        'expression'
    );
    assertRecovered(
        'prefix expression depth 257',
        prefixExpressionSource(257),
        'verbatim-node',
        'expression'
    );
}());

(function testTypeParserSharesTheSameAbsoluteDepth() {
    assertPass('type depth 255', castTypeSource(255));
    assertRecovered(
        'type depth 256', castTypeSource(256), 'verbatim-node', 'type'
    );
    assertRecovered(
        'type depth 257', castTypeSource(257), 'verbatim-node', 'type'
    );
}());

(function testWindowBodyCannotResetAnOuterExpressionDepth() {
    assertPass('window body at total depth 255', windowSource(254));
    assertRecovered(
        'window body at total depth 256',
        windowSource(255),
        'verbatim-node',
        'expression'
    );
    assertRecovered(
        'window expression at total depth 257',
        windowSource(256),
        'verbatim-node',
        'expression'
    );
}());

(function testDirectWindowParserNeverPassesDepth256ToItsCallback() {
    var source = '(PARTITION BY y)';
    var lexed = lexer.lexSql(source, { dialect: 'hive' });
    var table = tokenTableModule.buildStructuralTokenTable(lexed.leaves, source);
    var context = Object.freeze({
        dialect: 'hive',
        mode: 'document',
        leaves: lexed.leaves,
        table: table,
        factory: nodeFactory.createNodeFactory(table),
        diagnostics: []
    });
    var callbackCalls = 0;
    var spec = windowParser.parseWindowSpecRange(
        context,
        { start: 0, end: lexed.leaves.length },
        255,
        function() {
            callbackCalls += 1;
            throw new Error('depth-256 callback must not run');
        }
    );
    assert.strictEqual(callbackCalls, 0);
    assert.ok(nodesOf(spec, 'opaque').some(function(node) {
        return node.boundary === 'expression';
    }));
    assert.ok(context.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED' &&
            diagnostic.recovery === 'verbatim-node';
    }));
}());

(function testMixedQueryExpressionAndTypeDepthCannotBypassTheBudget() {
    assertPass('mixed total depth 255', mixedSource(80, 80, 94));
    assertRecovered(
        'mixed total depth 256',
        mixedSource(80, 80, 95),
        'verbatim-node',
        'type'
    );
    assertRecovered(
        'mixed total depth 257',
        mixedSource(80, 80, 96),
        'verbatim-node',
        'type'
    );
}());

console.log('parser depth tests passed');
