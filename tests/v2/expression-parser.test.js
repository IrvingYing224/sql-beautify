'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parserPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js');
var expressionParserPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'expression-parser.js'
);
var typeParserPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'type-parser.js'
);
var dialectsPath = path.join(root, '.tmp', 'v2-core', 'core', 'dialects', 'index.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');

assert.ok(fs.existsSync(expressionParserPath), 'Wave 2C expression parser build is required');
assert.ok(fs.existsSync(typeParserPath), 'Wave 2C type parser build is required');

var parser = require(parserPath);
var dialects = require(dialectsPath);
var invariants = require(invariantsPath);
var tokenTableModule = require(tokenTablePath);

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

function parse(source, dialect) {
    var result = parser.parseSql(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    var table = tokenTableModule.buildStructuralTokenTable(result.leaves, source);
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(
        checked.ok,
        true,
        source + ' invariant failures: ' + JSON.stringify(checked.failures, null, 2)
    );
    return {
        result: result,
        nodes: flatten(result.root)
    };
}

function slice(source, node) {
    return source.slice(node.span.start, node.span.end);
}

function nodesOf(parsed, kind, subtypeField, subtype) {
    return parsed.nodes.filter(function(node) {
        return node.kind === kind &&
            (subtypeField === undefined || node[subtypeField] === subtype);
    });
}

function assertNoOpaque(parsed, label) {
    assert.deepStrictEqual(
        nodesOf(parsed, 'opaque').map(function(node) {
            return slice(label, node);
        }),
        [],
        label + ' must be fully structured'
    );
    assert.deepStrictEqual(parsed.result.diagnostics, [], label + ' diagnostics');
}

(function testOperatorRegistryIsCompleteAndDialectOwned() {
    ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialectId) {
        var view = dialects.getDialect(dialectId);
        var seen = Object.create(null);
        view.listOperatorSemantics().forEach(function(operator) {
            var identity = operator.key + '\0' + operator.fixity;
            assert.ok(!seen[identity], dialectId + ' duplicate operator semantics ' + identity);
            seen[identity] = true;
            assert.ok(Number.isInteger(operator.precedence) && operator.precedence > 0,
                dialectId + ' operator precedence must be final: ' + identity);
            assert.ok(
                operator.associativity === 'left' ||
                operator.associativity === 'right' ||
                operator.associativity === 'none',
                dialectId + ' associativity must be final: ' + identity
            );
        });
        assert.ok(view.listOperatorSemantics().some(function(operator) {
            return operator.fixity === 'prefix';
        }), dialectId + ' must declare prefix semantics');
        assert.ok(view.listOperatorSemantics().some(function(operator) {
            return operator.fixity === 'infix';
        }), dialectId + ' must declare infix semantics');
        assert.ok(view.listOperatorSemantics().some(function(operator) {
            return operator.fixity === 'postfix';
        }), dialectId + ' must declare postfix semantics');
    });

    assert.ok(dialects.getDialect('postgresql').getOperatorSemantics('@>', 'infix'));
    assert.ok(dialects.getDialect('postgresql').getOperatorSemantics('::', 'postfix'));
    assert.ok(dialects.getDialect('postgresql').getOperatorSemantics('->', 'infix'));
    assert.ok(dialects.getDialect('mysql').getOperatorSemantics('->', 'infix'));
    assert.strictEqual(dialects.getDialect('hive').getOperatorSemantics('@>', 'infix'), null);
    assert.strictEqual(dialects.getDialect('hive').getOperatorSemantics('->', 'infix'), null);
    assert.strictEqual(dialects.getDialect('generic').getOperatorSemantics('->', 'infix'), null);
    assert.ok(dialects.getDialect('hive').getOperatorSemantics('<=>', 'infix'));
    assert.strictEqual(dialects.getDialect('postgresql').getOperatorSemantics('<=>', 'infix'), null);

    var source = fs.readFileSync(
        path.join(root, 'src', 'core', 'syntax', 'expression-parser.ts'),
        'utf8'
    );
    assert.ok(/getOperatorSemantics|listOperatorSemantics/.test(source),
        'Pratt parser must consume dialect operator registry');
    assert.strictEqual(/(?:PRECEDENCE|OPERATOR_PRECEDENCE)\s*=/.test(source), false,
        'Pratt parser must not maintain a second precedence table');
}());

(function testPrecedenceAssociativityAndPredicates() {
    var source = [
        'SELECT a + b * c AS total, a - b - c AS delta',
        'FROM t',
        'WHERE NOT a = 1 OR b BETWEEN 2 AND 3 AND c IS NOT NULL'
    ].join(' ');
    var parsed = parse(source);
    assertNoOpaque(parsed, source);

    var binarySlices = nodesOf(parsed, 'expression', 'expressionKind', 'binary').map(function(node) {
        return slice(source, node);
    });
    assert.ok(binarySlices.indexOf('b * c') >= 0, 'multiplication must bind before addition');
    assert.ok(binarySlices.indexOf('a + b * c') >= 0, 'addition must own multiplication');
    assert.ok(binarySlices.indexOf('a - b') >= 0, 'subtraction must associate left');
    assert.ok(binarySlices.indexOf('a - b - c') >= 0, 'outer subtraction must consume full range');
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'between').length, 1);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'is').length, 1);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'unary').length, 1);
}());

(function testCompoundNegativePredicates() {
    var source = "SELECT id FROM t WHERE name NOT LIKE 'x%' AND id NOT IN (1, 2) AND score NOT BETWEEN 3 AND 5";
    var parsed = parse(source);
    assertNoOpaque(parsed, source);
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'binary').some(function(node) {
        return slice(source, node) === "name NOT LIKE 'x%'";
    }));
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'in').length, 1);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'between').length, 1);
}());

(function testNonAssociativePredicatesRequireExplicitGrouping() {
    var source = [
        'SELECT a = b = c AS chained',
        ', a IS NULL IS NULL AS repeated',
        ', (a = b) = c AS grouped'
    ].join('');
    var parsed = parse(source);
    assert.deepStrictEqual(nodesOf(parsed, 'opaque').map(function(node) {
        return slice(source, node);
    }), ['a = b = c', 'a IS NULL IS NULL']);
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'binary').some(function(node) {
        return slice(source, node) === '(a = b) = c';
    }), 'explicit grouping must permit a new outer predicate');
}());

(function testCallsCollectionsQualifiedNamesAndDistinctArguments() {
    var source = "SELECT concat(DISTINCT t.a, upper(t.b)), ARRAY[1, 2], map('x', 1), t.* FROM db.t t";
    var parsed = parse(source);
    assertNoOpaque(parsed, source);

    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'function-call').length >= 2);
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'collection').length >= 2);
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'qualified-identifier').some(function(node) {
        return slice(source, node) === 't.a';
    }));
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'wildcard').some(function(node) {
        return slice(source, node) === '*';
    }));
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'qualified-identifier').some(function(node) {
        return slice(source, node) === 't.*';
    }));
    var concat = nodesOf(parsed, 'expression', 'expressionKind', 'function-call').find(function(node) {
        return slice(source, node).indexOf('concat(') === 0;
    });
    assert.ok(concat, 'concat call required');
    assert.ok(concat.operatorLeafIds.some(function(leafId) {
        return parsed.result.leaves[leafId].raw.toLowerCase() === 'distinct';
    }), 'DISTINCT must be retained as a call operator fact');
}());

(function testEmptyCollectionFormsRemainStructured() {
    var source = 'SELECT ARRAY[], array(), map()';
    var parsed = parse(source);
    assertNoOpaque(parsed, source);
    assert.strictEqual(
        nodesOf(parsed, 'expression', 'expressionKind', 'collection').length,
        3
    );
}());

(function testCaseCastAndNestedTypes() {
    var source = [
        'SELECT CASE status',
        'WHEN 1 THEN CAST(value AS ARRAY<MAP<STRING, DECIMAL(18, 2)>>)',
        'ELSE CAST(0 AS BIGINT) END AS amount',
        'FROM t'
    ].join(' ');
    var parsed = parse(source);
    assertNoOpaque(parsed, source);

    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'case').length, 1);
    assert.strictEqual(nodesOf(parsed, 'case-branch', 'branchKind', 'when').length, 1);
    assert.strictEqual(nodesOf(parsed, 'case-branch', 'branchKind', 'else').length, 1);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'cast').length, 2);
    var typeSlices = nodesOf(parsed, 'type-expression').map(function(node) {
        return slice(source, node);
    });
    ['ARRAY<MAP<STRING, DECIMAL(18, 2)>>', 'DECIMAL(18, 2)', 'BIGINT'].forEach(function(expected) {
        assert.ok(typeSlices.indexOf(expected) >= 0, 'missing type node ' + expected);
    });
    assert.ok(nodesOf(parsed, 'type-expression').some(function(node) {
        return parsed.result.leaves[node.typeNameLeafRange.start].raw.toLowerCase() === 'map';
    }), 'nested MAP type node required even when the canonical >> leaf is shared');
}());

(function testCompactHiveStructMembersUseTypeContextNotParameters() {
    var source = 'SELECT CAST(payload AS STRUCT<a:INT,b:ARRAY<STRING>>) FROM t';
    var parsed = parse(source);
    assertNoOpaque(parsed, source);
    var members = nodesOf(parsed, 'list', 'listRole', 'type-members');
    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].children.length, 2);
    assert.deepStrictEqual(members[0].children.map(function(item) {
        return source.slice(
            parsed.result.leaves[item.alias.nameLeafRange.start].span.start,
            parsed.result.leaves[item.alias.nameLeafRange.end - 1].span.end
        );
    }), ['a', 'b']);
}());

(function testProtectedParameterIsOnlyATypeInProvenStructMemberContext() {
    var source = [
        'SELECT CAST(x AS :type)',
        ', CAST(x AS ARRAY<:type>)',
        ', CAST(x AS STRUCT<a:INT>)'
    ].join('');
    var parsed = parse(source);
    assert.deepStrictEqual(nodesOf(parsed, 'opaque').map(function(node) {
        return [node.boundary, slice(source, node)];
    }), [['type', ':type'], ['type', 'ARRAY<:type>']]);
    assert.ok(nodesOf(parsed, 'type-expression').some(function(node) {
        return slice(source, node) === 'STRUCT<a:INT>';
    }), 'compact Hive STRUCT member type must remain structured');
}());

(function testSubqueryExistsAndIn() {
    var source = [
        'SELECT id FROM t',
        'WHERE id IN (SELECT id FROM u WHERE u.k = t.k)',
        'AND EXISTS (SELECT 1 FROM v WHERE v.id = t.id)'
    ].join(' ');
    var parsed = parse(source);
    assertNoOpaque(parsed, source);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'in').length, 1);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'exists').length, 1);
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'subquery').length >= 2);
}());

(function testWindowSpecificationAndNamedWindow() {
    var source = [
        'SELECT sum(amount) OVER (',
        'PARTITION BY dept ORDER BY ts DESC',
        'ROWS BETWEEN 2 PRECEDING AND CURRENT ROW',
        ') AS running, count(*) OVER w AS named',
        'FROM t WINDOW w AS (PARTITION BY dept)'
    ].join(' ');
    var parsed = parse(source);
    assertNoOpaque(parsed, source);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'window').length, 2);
    var specs = nodesOf(parsed, 'window-spec');
    assert.strictEqual(specs.length, 3, 'two OVER specs plus WINDOW clause declaration');
    assert.ok(nodesOf(parsed, 'list', 'listRole', 'window-partition').length >= 2);
    assert.ok(nodesOf(parsed, 'list', 'listRole', 'window-order').length >= 1);
    assert.ok(specs.some(function(node) {
        return node.frameChildId !== null;
    }), 'window frame must be structured');
}());

(function testNestedKeywordsDoNotSplitCaseOrWindowMarkers() {
    var source = [
        "SELECT CASE WHEN f(then) = 1 THEN 'ok' ELSE 'no' END",
        ', sum(x) OVER (ORDER BY y ROWS BETWEEN f(a AND b) PRECEDING AND CURRENT ROW)',
        ' FROM t'
    ].join('');
    var parsed = parse(source);
    assertNoOpaque(parsed, source);
    assert.strictEqual(nodesOf(parsed, 'expression', 'expressionKind', 'case').length, 1);
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'window').some(function(node) {
        return slice(source, node).indexOf('sum(x) OVER') === 0;
    }), 'nested AND must not become the window frame separator');
}());

(function testDialectSpecificOperatorsLiteralsAndParameters() {
    var postgresSource = "SELECT payload->>'name', payload @> '{\"a\":1}'::jsonb, '1'::int + 2, name ILIKE 'a%', name NOT ILIKE 'b%', ARRAY[1, 2], $1";
    var postgres = parse(postgresSource, 'postgresql');
    assertNoOpaque(postgres, postgresSource);
    ['payload->>\'name\'', 'payload @> \'{"a":1}\'::jsonb'].forEach(function(expected) {
        assert.ok(nodesOf(postgres, 'expression', 'expressionKind', 'binary').some(function(node) {
            return slice(postgresSource, node) === expected;
        }), 'PostgreSQL operator must be structured: ' + expected);
    });
    assert.ok(nodesOf(postgres, 'expression', 'expressionKind', 'cast').some(function(node) {
        return slice(postgresSource, node).indexOf('::jsonb') >= 0;
    }));
    assert.ok(nodesOf(postgres, 'expression', 'expressionKind', 'collection').some(function(node) {
        return slice(postgresSource, node) === 'ARRAY[1, 2]';
    }), 'PostgreSQL ARRAY subset must be structured');

    var mysqlSource = "SELECT @name, _utf8mb4'abc', json_col->>'$.x', map('x', 1)";
    var mysql = parse(mysqlSource, 'mysql');
    assertNoOpaque(mysql, mysqlSource);
    assert.ok(nodesOf(mysql, 'expression', 'expressionKind', 'parameter').some(function(node) {
        return slice(mysqlSource, node) === '@name';
    }), 'MySQL variable must be structured as one parameter');
    assert.ok(nodesOf(mysql, 'expression', 'expressionKind', 'literal').some(function(node) {
        return slice(mysqlSource, node) === "_utf8mb4'abc'";
    }), 'MySQL prefixed literal must remain one structured literal');
    assert.ok(nodesOf(mysql, 'expression', 'expressionKind', 'binary').some(function(node) {
        return slice(mysqlSource, node) === "json_col->>'$.x'";
    }), 'MySQL JSON operator must be structured');
    assert.ok(nodesOf(mysql, 'expression', 'expressionKind', 'function-call').some(function(node) {
        return slice(mysqlSource, node) === "map('x', 1)";
    }), 'MySQL must not inherit Hive MAP collection semantics');

    var mysqlCollectionSource = 'SELECT [1, 2], value[1]';
    var mysqlCollection = parse(mysqlCollectionSource, 'mysql');
    assert.deepStrictEqual(nodesOf(mysqlCollection, 'opaque').map(function(node) {
        return slice(mysqlCollectionSource, node);
    }), ['[1, 2]', 'value[1]'], 'MySQL must not inherit undeclared collection syntax');

    var genericSource = 'SELECT ARRAY[1, 2], ?';
    var generic = parse(genericSource, 'generic');
    assertNoOpaque(generic, genericSource);
    assert.ok(nodesOf(generic, 'expression', 'expressionKind', 'collection').some(function(node) {
        return slice(genericSource, node) === 'ARRAY[1, 2]';
    }), 'generic ARRAY subset must be structured');
}());

(function testTableFunctionCapabilityMatchesAllDialectParsers() {
    ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialectId) {
        var source = 'SELECT * FROM generate_series(1, 3) g';
        var parsed = parse(source, dialectId);
        assertNoOpaque(parsed, source);
        assert.ok(nodesOf(parsed, 'relation', 'relationKind', 'table-function').some(function(node) {
            return slice(source, node) === 'generate_series(1, 3) g';
        }), dialectId + ' table function relation must be structured');
        assert.strictEqual(
            dialects.getDialect(dialectId).getCapability('table-function').state,
            'structured',
            dialectId + ' table-function capability'
        );
    });
}());

(function testNonHiveDialectsDoNotInheritHiveOnlyGrammar() {
    var insertSource = 'INSERT OVERWRITE TABLE dst SELECT id FROM src';
    var insert = parse(insertSource, 'generic');
    assert.deepStrictEqual(
        insert.result.root.children.map(function(statement) {
            return statement.statementKind;
        }),
        ['opaque']
    );
    assert.ok(insert.result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_UNSUPPORTED_STATEMENT';
    }));

    var lateralSource = 'SELECT * FROM t LATERAL VIEW EXPLODE(items) e AS item';
    var lateral = parse(lateralSource, 'generic');
    assert.strictEqual(
        nodesOf(lateral, 'relation', 'relationKind', 'lateral-view').length,
        0,
        'generic must not inherit Hive LATERAL VIEW grammar'
    );
    assert.ok(nodesOf(lateral, 'opaque').some(function(node) {
        return node.boundary === 'relation';
    }), 'unknown generic relation tail must be preserved as one relation boundary');

    ['hive', 'generic'].forEach(function(dialectId) {
        var jsonSource = "SELECT payload->'x'";
        var json = parse(jsonSource, dialectId);
        assert.deepStrictEqual(nodesOf(json, 'opaque').map(function(node) {
            return slice(jsonSource, node);
        }), ["payload->'x'"], dialectId + ' must not inherit JSON arrow operators');
    });
}());

(function testKeywordShapedIdentifiersAndProtectedLeavesStayAtomic() {
    var source = [
        "SELECT qualify, match_recognize(a), pivot, 'CASE x WHEN 1 THEN FROM END'",
        'FROM t WHERE window = 1'
    ].join(' ');
    var parsed = parse(source);
    assertNoOpaque(parsed, source);
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'function-call').some(function(node) {
        return slice(source, node) === 'match_recognize(a)';
    }));
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'literal').some(function(node) {
        return slice(source, node) === "'CASE x WHEN 1 THEN FROM END'";
    }));
}());

(function testBoundedFailureFallsBackOnlyCurrentExpression() {
    var source = 'SELECT a @ b AS preserved, good + 1 AS structured FROM t';
    var parsed = parse(source);
    var opaque = nodesOf(parsed, 'opaque');
    assert.deepStrictEqual(opaque.map(function(node) {
        return slice(source, node);
    }), ['a @ b']);
    assert.strictEqual(opaque[0].boundary, 'expression');
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'binary').some(function(node) {
        return slice(source, node) === 'good + 1';
    }), 'later list item must still be structured');
    assert.deepStrictEqual(parsed.result.diagnostics.map(function(diagnostic) {
        return diagnostic.recovery;
    }), ['verbatim-node']);
}());

(function testMalformedWindowFallsBackAtWindowBoundary() {
    var source = 'SELECT 1 WINDOW w AS (PARTITION BY)';
    var parsed = parse(source);
    var opaque = nodesOf(parsed, 'opaque');
    assert.deepStrictEqual(opaque.map(function(node) {
        return slice(source, node);
    }), ['w AS (PARTITION BY)']);
    assert.strictEqual(opaque[0].boundary, 'window');
    assert.strictEqual(parsed.result.root.children[0].statementKind, 'query');
    assert.strictEqual(parsed.result.diagnostics[0].recovery, 'verbatim-node');
}());

(function testMalformedCastFallsBackAtTypeBoundary() {
    var source = 'SELECT CAST(x AS mystery @ value), y + 1 FROM t';
    var parsed = parse(source);
    var opaque = nodesOf(parsed, 'opaque');
    assert.deepStrictEqual(opaque.map(function(node) {
        return slice(source, node);
    }), ['mystery @ value']);
    assert.strictEqual(opaque[0].boundary, 'type');
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'cast').some(function(node) {
        return slice(source, node) === 'CAST(x AS mystery @ value)';
    }));
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'binary').some(function(node) {
        return slice(source, node) === 'y + 1';
    }));
}());

(function testExpressionRecursionBudgetFailsClosedLocally() {
    var source = 'SELECT ' + new Array(301).join('NOT ') + 'x, y + 1';
    var parsed = parse(source);
    var opaque = nodesOf(parsed, 'opaque');
    assert.strictEqual(opaque.length, 1);
    assert.strictEqual(opaque[0].boundary, 'expression');
    assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED' &&
            diagnostic.recovery === 'verbatim-node';
    }));
    assert.strictEqual(parsed.result.root.children[0].statementKind, 'query');
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'binary').some(function(node) {
        return slice(source, node) === 'y + 1';
    }));
}());

(function testTypeRecursionBudgetFailsClosedLocally() {
    var nestedType = new Array(301).join('ARRAY<') + 'INT' + new Array(301).join('>');
    var source = 'SELECT CAST(x AS ' + nestedType + '), y + 1';
    var parsed = parse(source);
    var opaque = nodesOf(parsed, 'opaque');
    assert.strictEqual(opaque.length, 1);
    assert.strictEqual(opaque[0].boundary, 'type');
    assert.strictEqual(slice(source, opaque[0]), nestedType);
    assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED' &&
            diagnostic.recovery === 'verbatim-node';
    }));
    assert.ok(nodesOf(parsed, 'expression', 'expressionKind', 'binary').some(function(node) {
        return slice(source, node) === 'y + 1';
    }), 'later expression must survive type depth fallback');
}());

(function testExpressionShapeInvariantsFailClosed() {
    var source = 'SELECT 1';
    var parsed = parse(source);
    var forgedRoot = JSON.parse(JSON.stringify(parsed.result.root));
    var stack = [forgedRoot];
    var forgedExpression = null;
    while (stack.length > 0) {
        var node = stack.pop();
        if (node.kind === 'expression') {
            forgedExpression = node;
            break;
        }
        if (Array.isArray(node.children)) {
            Array.prototype.push.apply(stack, node.children);
        }
    }
    assert.ok(forgedExpression, 'fixture expression required');
    forgedExpression.expressionKind = 'binary';
    var table = tokenTableModule.buildStructuralTokenTable(parsed.result.leaves, source);
    var checked = invariants.validateSyntaxInvariants({
        root: forgedRoot,
        leaves: parsed.result.leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(checked.ok, false,
        'binary expression without operands/operators must fail closed');
    assert.ok(checked.failures.some(function(failure) {
        return failure.code === 'INV_RELATIONSHIP';
    }), JSON.stringify(checked.failures));
}());

(function testExpressionOperatorReferencesFailClosed() {
    var source = "SELECT f(DISTINCT a + 'x')";
    var parsed = parse(source);
    var leaves = parsed.result.leaves;
    var call = nodesOf(parsed, 'expression', 'expressionKind', 'function-call')[0];
    var binary = nodesOf(parsed, 'expression', 'expressionKind', 'binary')[0];
    assert.ok(call && binary, 'operator invariant fixtures required');

    var open = leaves.findIndex(function(leaf) { return leaf.raw === '('; });
    var distinct = leaves.findIndex(function(leaf) {
        return leaf.raw.toLowerCase() === 'distinct';
    });
    var close = leaves.findIndex(function(leaf) { return leaf.raw === ')'; });
    var trivia = leaves.findIndex(function(leaf) { return leaf.channel === 'trivia'; });
    var protectedLeaf = leaves.findIndex(function(leaf) { return leaf.channel === 'protected'; });
    var operand = leaves.findIndex(function(leaf) { return leaf.raw === 'a'; });

    function assertRejected(nodeId, operatorLeafIds, label, expectedCode) {
        var forgedRoot = JSON.parse(JSON.stringify(parsed.result.root));
        var stack = [forgedRoot];
        var target = null;
        while (stack.length > 0) {
            var node = stack.pop();
            if (node.id === nodeId) {
                target = node;
                break;
            }
            if (Array.isArray(node.children)) {
                Array.prototype.push.apply(stack, node.children);
            }
        }
        assert.ok(target, label + ' target node required');
        target.operatorLeafIds = operatorLeafIds;
        var table = tokenTableModule.buildStructuralTokenTable(leaves, source);
        var checked = invariants.validateSyntaxInvariants({
            root: forgedRoot,
            leaves: leaves,
            source: source,
            tokenTable: table
        });
        assert.strictEqual(checked.ok, false, label + ' must fail closed');
        assert.ok(checked.failures.some(function(failure) {
            return failure.code === expectedCode;
        }), label + ': ' + JSON.stringify(checked.failures));
    }

    assertRejected(call.id, [close, distinct, open], 'reverse operator ids', 'INV_OWNER_REFERENCE');
    assertRejected(call.id, [open, open, close], 'duplicate operator ids', 'INV_OWNER_REFERENCE');
    assertRejected(binary.id, [trivia], 'trivia operator reference', 'INV_OWNER_REFERENCE');
    assertRejected(binary.id, [protectedLeaf], 'protected operator reference', 'INV_OWNER_REFERENCE');
    assertRejected(binary.id, [operand], 'operand operator reference', 'INV_RELATIONSHIP');
}());

(function testWindowAndTypeSemanticInvariantsFailClosed() {
    var source = [
        'SELECT sum(x) OVER (PARTITION BY y ORDER BY z ROWS 1 PRECEDING)',
        ', CAST(x AS DECIMAL(18, 2))'
    ].join('');
    var parsed = parse(source);
    var windowSpec = nodesOf(parsed, 'window-spec').find(function(node) {
        return node.partitionChildId !== null;
    });
    var decimalType = nodesOf(parsed, 'type-expression').find(function(node) {
        return slice(source, node) === 'DECIMAL(18, 2)';
    });
    assert.ok(windowSpec && decimalType, 'window/type invariant fixtures required');

    function findNode(rootNode, nodeId) {
        var stack = [rootNode];
        while (stack.length > 0) {
            var node = stack.pop();
            if (node.id === nodeId) {
                return node;
            }
            if (Array.isArray(node.children)) {
                Array.prototype.push.apply(stack, node.children);
            }
        }
        return null;
    }

    function assertMutationRejected(label, mutate) {
        var forgedRoot = JSON.parse(JSON.stringify(parsed.result.root));
        mutate(forgedRoot);
        var checked = invariants.validateSyntaxInvariants({
            root: forgedRoot,
            leaves: parsed.result.leaves,
            source: source,
            tokenTable: tokenTableModule.buildStructuralTokenTable(parsed.result.leaves, source)
        });
        assert.strictEqual(checked.ok, false, label + ' must fail closed');
        assert.ok(checked.failures.some(function(failure) {
            return failure.code === 'INV_RELATIONSHIP';
        }), label + ': ' + JSON.stringify(checked.failures));
    }

    assertMutationRejected('empty window name range', function(rootNode) {
        var target = findNode(rootNode, windowSpec.id);
        target.nameLeafRange = {
            start: target.leafRange.start,
            end: target.leafRange.start
        };
    });
    assertMutationRejected('wrong window partition role', function(rootNode) {
        var target = findNode(rootNode, windowSpec.partitionChildId);
        target.listRole = 'values';
    });
    assertMutationRejected('empty type name range', function(rootNode) {
        var target = findNode(rootNode, decimalType.id);
        target.typeNameLeafRange = {
            start: target.leafRange.start,
            end: target.leafRange.start
        };
    });
    assertMutationRejected('wrong type argument role', function(rootNode) {
        var target = findNode(rootNode, decimalType.argumentListChildId);
        target.listRole = 'values';
    });
}());

(function testCapabilitiesReflectOnlyImplementedExpressionSupport() {
    var hive = dialects.getDialect('hive');
    [
        'case-expression',
        'function-call',
        'collection-expression',
        'cast-type',
        'subquery-expression',
        'window-expression',
        'template-parameter'
    ].forEach(function(id) {
        assert.strictEqual(hive.getCapability(id).state, 'structured', id);
    });
    assert.strictEqual(
        dialects.getDialect('postgresql').getCapability('postgres-json-operators').state,
        'structured'
    );
    assert.strictEqual(
        dialects.getDialect('postgresql').getCapability('postgres-type-cast').state,
        'structured'
    );
    assert.strictEqual(
        dialects.getDialect('postgresql').getCapability('postgres-array-subset').state,
        'structured'
    );
    assert.strictEqual(
        dialects.getDialect('mysql').getCapability('mysql-variables').state,
        'structured'
    );
    assert.strictEqual(
        dialects.getDialect('mysql').getCapability('mysql-prefixed-literals').state,
        'structured'
    );
    assert.strictEqual(
        dialects.getDialect('mysql').getCapability('mysql-json-operators').state,
        'structured'
    );
    assert.strictEqual(
        dialects.getDialect('generic').getCapability('generic-array-subset').state,
        'structured'
    );
}());

console.log('v2 Wave 2C expression parser tests passed');
