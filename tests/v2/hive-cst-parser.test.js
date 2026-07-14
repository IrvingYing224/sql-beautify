'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parserPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js');
var factoryPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'node-factory.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');

assert.ok(fs.existsSync(parserPath), 'Wave 2C parser build is required');
assert.ok(fs.existsSync(factoryPath), 'Wave 2C node factory build is required');

var parser = require(parserPath);
var factoryModule = require(factoryPath);
var tokenTableModule = require(tokenTablePath);
var invariants = require(invariantsPath);
var core = require(corePath);
var cases = require('../fixtures/v2-cst-cases');

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

function uniqueValues(nodes, kind, field) {
    var seen = Object.create(null);
    var values = [];
    nodes.forEach(function(node) {
        if (node.kind !== kind) return;
        var value = node[field];
        if (!seen[value]) {
            seen[value] = true;
            values.push(value);
        }
    });
    return values;
}

function assertIncludesAll(label, actual, expected) {
    expected.forEach(function(value) {
        assert.ok(actual.indexOf(value) >= 0,
            label + ' expected ' + value + ', got ' + JSON.stringify(actual));
    });
}

function assertRequiredSlices(testCase, result, nodes) {
    var slices = nodes.map(function(node) {
        return testCase.source.slice(node.span.start, node.span.end);
    });
    testCase.expected.requiredSlices.forEach(function(slice) {
        assert.ok(slices.indexOf(slice) >= 0,
            testCase.id + ' missing exact node slice ' + JSON.stringify(slice) +
            '\nactual=' + JSON.stringify(slices));
    });
    assert.strictEqual(result.root.span.start, 0, testCase.id + ' root span start');
    assert.strictEqual(result.root.span.end, testCase.source.length, testCase.id + ' root span end');
}

function assertOpaqueDiagnostics(testCase, result, nodes) {
    var opaque = nodes.filter(function(node) { return node.kind === 'opaque'; });
    assert.deepStrictEqual(opaque.map(function(node) {
        return testCase.source.slice(node.span.start, node.span.end);
    }), testCase.expected.opaqueSlices, testCase.id + ' exact opaque slices');
    assert.deepStrictEqual(result.diagnostics.map(function(diagnostic) {
        return diagnostic.code;
    }), testCase.expected.diagnosticCodes, testCase.id + ' exact diagnostic codes');
    opaque.forEach(function(node) {
        var matched = result.diagnostics.some(function(diagnostic) {
            return diagnostic.code === node.reasonCode &&
                diagnostic.span.start === node.span.start &&
                diagnostic.span.end === node.span.end;
        });
        assert.strictEqual(matched, true,
            testCase.id + ' opaque node must have matching diagnostic: ' + JSON.stringify(node));
    });

    if (testCase.expected.outcome === 'fully-structured') {
        assert.strictEqual(opaque.length, 0, testCase.id + ' expected no opaque nodes');
    } else {
        assert.ok(opaque.length > 0, testCase.id + ' expected opaque containment');
    }

    var recoveries = result.diagnostics.map(function(diagnostic) {
        return diagnostic.recovery;
    });
    if (testCase.expected.outcome === 'statement-preserved') {
        assert.ok(recoveries.indexOf('preserve-statement') >= 0,
            testCase.id + ' expected preserve-statement diagnostic');
    }
    if (testCase.expected.outcome === 'target-preserved') {
        assert.ok(recoveries.indexOf('preserve-target') >= 0,
            testCase.id + ' expected preserve-target diagnostic');
    }
    if (testCase.expected.outcome === 'partially-opaque') {
        assert.strictEqual(recoveries.indexOf('preserve-statement'), -1,
            testCase.id + ' must not preserve whole statement');
        assert.strictEqual(recoveries.indexOf('preserve-target'), -1,
            testCase.id + ' must not preserve whole target');
    }
}

function assertParserResult(testCase) {
    var result = parser.parseSql(testCase.source, {
        dialect: testCase.dialect,
        mode: testCase.mode
    });
    assert.ok(Object.isFrozen(result), testCase.id + ' ParseOutput frozen');
    assert.ok(Array.isArray(result.leaves), testCase.id + ' leaves real array');
    assert.ok(Object.isFrozen(result.leaves), testCase.id + ' leaves frozen');
    assert.ok(Array.isArray(result.diagnostics), testCase.id + ' diagnostics real array');
    assert.ok(Object.isFrozen(result.diagnostics), testCase.id + ' diagnostics frozen');
    assert.strictEqual(result.leaves.map(function(leaf) { return leaf.raw; }).join(''),
        testCase.source, testCase.id + ' source conservation');

    var table = tokenTableModule.buildStructuralTokenTable(result.leaves, testCase.source);
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: testCase.source,
        tokenTable: table
    });
    assert.strictEqual(checked.ok, true,
        testCase.id + ' invariant failures: ' + JSON.stringify(checked.failures, null, 2));

    var nodes = flatten(result.root);
    assert.deepStrictEqual(
        result.root.children.map(function(node) { return node.statementKind; }),
        testCase.expected.statementKinds,
        testCase.id + ' statement kinds'
    );
    assertIncludesAll(testCase.id + ' query kinds',
        uniqueValues(nodes, 'query', 'queryKind'), testCase.expected.queryKinds);
    assertIncludesAll(testCase.id + ' clause kinds',
        uniqueValues(nodes, 'clause', 'clauseKind'), testCase.expected.clauseKinds);
    assertIncludesAll(testCase.id + ' relation kinds',
        uniqueValues(nodes, 'relation', 'relationKind'), testCase.expected.relationKinds);
    assertIncludesAll(testCase.id + ' list roles',
        uniqueValues(nodes, 'list', 'listRole'), testCase.expected.listRoles);

    var comments = result.leaves.filter(function(leaf) {
        return leaf.kind === 'line-comment' || leaf.kind === 'block-comment';
    }).map(function(leaf) { return leaf.raw; });
    assert.deepStrictEqual(comments, testCase.expected.commentLeaves,
        testCase.id + ' comment leaves');

    assertRequiredSlices(testCase, result, nodes);
    assertOpaqueDiagnostics(testCase, result, nodes);

    var second = parser.parseSql(testCase.source, {
        dialect: testCase.dialect,
        mode: testCase.mode
    });
    assert.deepStrictEqual(second, result, testCase.id + ' deterministic parse');
}

cases.forEach(assertParserResult);

(function testInternalParserBackendDelegatesToCanonicalParser() {
    var input = { source: 'SELECT 1', dialect: 'hive', mode: 'document' };
    assert.strictEqual(parser.parserBackend.id, 'sql-beautify-v2');
    assert.strictEqual(parser.parserBackend.version, '2c');
    assert.ok(Object.isFrozen(parser.parserBackend));
    assert.deepStrictEqual(
        parser.parserBackend.parse(input),
        parser.parseSql(input.source, { dialect: input.dialect, mode: input.mode })
    );
}());

(function testNodeFactoryOwnsIdsAndSpans() {
    var source = 'SELECT 1';
    var lexed = core.lexSql(source, { dialect: 'hive' });
    var table = tokenTableModule.buildStructuralTokenTable(lexed.leaves, source);
    var factory = factoryModule.createNodeFactory(table);
    var opaque = factory.createOpaque({ start: 2, end: 3 },
        'SYN_UNMODELED_CONSTRUCT', 'expression');
    var item = factory.createListItem({ start: 2, end: 3 }, 'select-item', null, [], opaque);
    var list = factory.createList({ start: 2, end: 3 }, 'select-items', [], [item]);
    var clause = factory.createClause({ start: 0, end: 3 }, 'select',
        { start: 0, end: 1 }, { start: 1, end: 3 }, [list]);
    var query = factory.createQuery({ start: 0, end: 3 }, 'select', [], [clause]);
    var statement = factory.createStatement({ start: 0, end: 3 }, 'query', query);
    var program = factory.createProgram({ start: 0, end: 3 }, [statement]);

    assert.deepStrictEqual(flatten(program).map(function(node) { return node.id; }).sort(function(a, b) {
        return a - b;
    }), [0, 1, 2, 3, 4, 5, 6]);
    assert.strictEqual(program.id, 0);
    assert.deepStrictEqual(opaque.span, { start: 7, end: 8 });
    flatten(program).forEach(function(node) {
        assert.ok(Object.isFrozen(node), 'factory node frozen: ' + node.kind);
        if (Array.isArray(node.children)) {
            assert.ok(Object.isFrozen(node.children), 'factory children frozen: ' + node.kind);
        }
    });
    assert.throws(function() {
        factory.createOpaque({ start: -1, end: 1 }, 'X', 'expression');
    }, /range/i);
    assert.throws(function() {
        factory.createProgram({ start: 0, end: 3 }, []);
    }, /program/i);
}());

(function testWave2BRelationContractsFailClosed() {
    function validateForgedRelation(buildRelation) {
        var source = 't';
        var lexed = core.lexSql(source, { dialect: 'hive' });
        var table = tokenTableModule.buildStructuralTokenTable(lexed.leaves, source);
        var factory = factoryModule.createNodeFactory(table);
        var range = { start: 0, end: 1 };
        var relation = buildRelation(factory, range);
        var query = factory.createQuery(range, 'select', [], [relation]);
        var statement = factory.createStatement(range, 'query', query);
        var program = factory.createProgram(range, [statement]);
        return invariants.validateSyntaxInvariants({
            root: program,
            leaves: lexed.leaves,
            source: source,
            tokenTable: table
        });
    }

    var tableWithExtraChild = validateForgedRelation(function(factory, range) {
        var opaque = factory.createOpaque(range, 'SYN_UNMODELED_CONSTRUCT', 'relation');
        return factory.createRelation(range, 'table', null, null, [opaque]);
    });
    assert.strictEqual(tableWithExtraChild.ok, false,
        'table relation must not carry unreferenced children');
    assert.ok(tableWithExtraChild.failures.some(function(failure) {
        return failure.code === 'INV_EXTRA_CHILD' || failure.code === 'INV_RELATIONSHIP';
    }));

    var joinWithoutBody = validateForgedRelation(function(factory, range) {
        return factory.createRelation(range, 'join', null, null, []);
    });
    assert.strictEqual(joinWithoutBody.ok, false, 'join relation requires its right relation body');
    assert.ok(joinWithoutBody.failures.some(function(failure) {
        return failure.code === 'INV_RELATIONSHIP';
    }));

    var source = 'a b';
    var lexed = core.lexSql(source, { dialect: 'hive' });
    var table = tokenTableModule.buildStructuralTokenTable(lexed.leaves, source);
    var factory = factoryModule.createNodeFactory(table);
    var right = factory.createRelation({ start: 0, end: 1 }, 'table', null, null, []);
    var unreferenced = factory.createRelation({ start: 2, end: 3 }, 'table', null, null, []);
    var join = factory.createRelation(
        { start: 0, end: 3 }, 'join', null, right, [right, unreferenced]);
    var query = factory.createQuery({ start: 0, end: 3 }, 'select', [], [join]);
    var statement = factory.createStatement({ start: 0, end: 3 }, 'query', query);
    var program = factory.createProgram({ start: 0, end: 3 }, [statement]);
    var joinWithExtraChild = invariants.validateSyntaxInvariants({
        root: program,
        leaves: lexed.leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(joinWithExtraChild.ok, false,
        'join relation must reject an unreferenced extra relation');
    assert.ok(joinWithExtraChild.failures.some(function(failure) {
        return failure.code === 'INV_EXTRA_CHILD' ||
            (failure.code === 'INV_RELATIONSHIP' && /join/i.test(failure.message));
    }), 'join relation failure must identify its child contract');
}());

(function testWave2BQueryContractsFailClosed() {
    var source = 't';
    var lexed = core.lexSql(source, { dialect: 'hive' });
    var table = tokenTableModule.buildStructuralTokenTable(lexed.leaves, source);
    var factory = factoryModule.createNodeFactory(table);
    var relation = factory.createRelation({ start: 0, end: 1 }, 'table', null, null, []);
    var query = factory.createQuery({ start: 0, end: 1 }, 'select', [], [relation]);
    var statement = factory.createStatement({ start: 0, end: 1 }, 'query', query);
    var program = factory.createProgram({ start: 0, end: 1 }, [statement]);
    var result = invariants.validateSyntaxInvariants({
        root: program,
        leaves: lexed.leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(result.ok, false,
        'select query must not accept a relation in place of a SELECT/ WITH/INSERT structure');
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'INV_RELATIONSHIP';
    }), 'invalid select query shape must report a relationship failure');

    source = 'SELECT x';
    lexed = core.lexSql(source, { dialect: 'hive' });
    table = tokenTableModule.buildStructuralTokenTable(lexed.leaves, source);
    factory = factoryModule.createNodeFactory(table);
    var opaque = factory.createOpaque(
        { start: 2, end: 3 }, 'SYN_UNMODELED_CONSTRUCT', 'expression');
    var clause = factory.createClause(
        { start: 0, end: 3 }, 'select',
        { start: 0, end: 1 }, { start: 1, end: 3 }, [opaque]);
    query = factory.createQuery({ start: 0, end: 3 }, 'select', [], [clause]);
    statement = factory.createStatement({ start: 0, end: 3 }, 'query', query);
    program = factory.createProgram({ start: 0, end: 3 }, [statement]);
    result = invariants.validateSyntaxInvariants({
        root: program,
        leaves: lexed.leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(result.ok, false,
        'SELECT clause must contain a select-items list, not a direct opaque expression');
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'INV_RELATIONSHIP';
    }), 'invalid SELECT clause child must report a relationship failure');

    source = 'SELECT x y';
    lexed = core.lexSql(source, { dialect: 'hive' });
    table = tokenTableModule.buildStructuralTokenTable(lexed.leaves, source);
    factory = factoryModule.createNodeFactory(table);
    var xValue = factory.createOpaque(
        { start: 2, end: 3 }, 'SYN_UNMODELED_CONSTRUCT', 'expression');
    var xItem = factory.createListItem(
        { start: 2, end: 3 }, 'select-item', null, [], xValue);
    var yValue = factory.createOpaque(
        { start: 4, end: 5 }, 'SYN_UNMODELED_CONSTRUCT', 'expression');
    var yItem = factory.createListItem(
        { start: 4, end: 5 }, 'select-item', null, [], yValue);
    var list = factory.createList(
        { start: 2, end: 5 }, 'select-items', [], [xItem, yItem]);
    clause = factory.createClause(
        { start: 0, end: 5 }, 'select',
        { start: 0, end: 1 }, { start: 1, end: 5 }, [list]);
    query = factory.createQuery({ start: 0, end: 5 }, 'select', [], [clause]);
    statement = factory.createStatement({ start: 0, end: 5 }, 'query', query);
    program = factory.createProgram({ start: 0, end: 5 }, [statement]);
    result = invariants.validateSyntaxInvariants({
        root: program,
        leaves: lexed.leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(result.ok, false,
        'two list items must not be accepted without an owned comma separator');
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'INV_RELATIONSHIP';
    }), 'invalid list separator contract must report a relationship failure');
}());

(function testParenthesizedLeftSetOperand() {
    var source = '(SELECT 1) UNION SELECT 2';
    var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    assert.strictEqual(result.root.children[0].statementKind, 'query',
        'parenthesized left set operand must remain a structured query statement');
    assert.ok(flatten(result.root).some(function(node) {
        return node.kind === 'query' && node.queryKind === 'set';
    }), 'parenthesized left set operand must produce a set QueryNode');
    assert.strictEqual(result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' ||
            diagnostic.recovery === 'preserve-target';
    }), false, 'valid parenthesized set query must not preserve a wider boundary');
}());

(function testDeclaredSetAndJoinVariants() {
    ['UNION', 'UNION ALL', 'UNION DISTINCT', 'INTERSECT', 'EXCEPT'].forEach(
        function(operator) {
            var source = 'SELECT 1 ' + operator + ' SELECT 2';
            var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
            assert.strictEqual(result.root.children[0].statementKind, 'query', source);
            assert.ok(flatten(result.root).some(function(node) {
                return node.kind === 'query' && node.queryKind === 'set';
            }), 'declared set operator must produce a set query: ' + operator);
        }
    );

    [
        'JOIN',
        'CROSS JOIN',
        'FULL JOIN',
        'FULL OUTER JOIN',
        'INNER JOIN',
        'LEFT JOIN',
        'LEFT OUTER JOIN',
        'LEFT SEMI JOIN',
        'RIGHT JOIN',
        'RIGHT OUTER JOIN'
    ].forEach(function(head) {
        var condition = head === 'CROSS JOIN' ? '' : ' ON a.id = b.id';
        var source = 'SELECT a.id FROM a ' + head + ' b' + condition;
        var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
        assert.strictEqual(result.root.children[0].statementKind, 'query', source);
        assert.strictEqual(flatten(result.root).filter(function(node) {
            return node.kind === 'relation' && node.relationKind === 'join';
        }).length, 1, 'declared join head must produce one join relation: ' + head);
    });
}());

(function testCteColumnListAndDepthBudget() {
    var cte = parser.parseSql(
        'WITH c(id, `group`) AS (SELECT 1) SELECT id FROM c',
        { dialect: 'hive', mode: 'document' }
    );
    assert.strictEqual(cte.root.children[0].statementKind, 'query');
    assert.ok(flatten(cte.root).some(function(node) {
        return node.kind === 'list' && node.listRole === 'cte-columns' &&
            node.children.length === 2;
    }), 'non-empty CTE column list must retain both name boundaries');

    var depth = 300;
    var deepSource = new Array(depth + 1).join('(') + 'SELECT 1' +
        new Array(depth + 1).join(')');
    var deep = parser.parseSql(deepSource, { dialect: 'hive', mode: 'document' });
    assert.strictEqual(deep.root.children[0].statementKind, 'opaque');
    assert.ok(deep.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED' &&
            diagnostic.recovery === 'preserve-statement';
    }), 'balanced input beyond the 256-level budget must fail closed without stack overflow');
}());

(function testModesAndProtectedFalsePositives() {
    var multi = parser.parseSql('SELECT 1; SELECT 2', { dialect: 'hive', mode: 'statement' });
    assert.ok(multi.diagnostics.some(function(d) { return d.recovery === 'preserve-target'; }),
        'statement mode must preserve multi-statement target');
    assert.ok(multi.root.children.every(function(statement) {
        return statement.statementKind === 'opaque';
    }), 'statement mode multi-target must not return partial trusted query trees');

    var fragment = parser.parseSql('SELECT 1', { dialect: 'hive', mode: 'fragment' });
    assert.strictEqual(fragment.root.children[0].statementKind, 'query');

    ['x + 1', 'SELECT x AS'].forEach(function(source) {
        var preserved = parser.parseSql(source, { dialect: 'hive', mode: 'fragment' });
        assert.strictEqual(preserved.root.children[0].statementKind, 'opaque');
        assert.ok(preserved.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-target';
        }), 'unstructured fragment must preserve its complete target: ' + source);
        assert.strictEqual(preserved.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement';
        }), false, 'fragment recovery must not claim a statement boundary: ' + source);
    });

    var emptyMulti = parser.parseSql(';;', { dialect: 'hive', mode: 'statement' });
    assert.ok(emptyMulti.diagnostics.some(function(d) {
        return d.recovery === 'preserve-target';
    }), 'multiple empty statements still violate statement-mode target cardinality');

    var unbalanced = parser.parseSql('SELECT (1', { dialect: 'hive', mode: 'fragment' });
    assert.ok(unbalanced.diagnostics.some(function(d) { return d.recovery === 'preserve-target'; }),
        'unbalanced fragment must preserve target');

    var source = [
        "SELECT 'FROM WHERE GROUP BY', qualify AS c, match_recognize(a) AS v",
        'FROM t -- ORDER BY fake',
        'WHERE qualify = 1'
    ].join('\n');
    var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    var clauses = uniqueValues(flatten(result.root), 'clause', 'clauseKind');
    assert.deepStrictEqual(clauses, ['select', 'from', 'where']);
    assert.strictEqual(result.diagnostics.some(function(d) {
        return /MATCH_RECOGNIZE|QUALIFY/.test(d.message) && d.recovery !== 'verbatim-node';
    }), false, 'keyword-shaped identifiers/functions must not become unsupported constructs');
}());

(function testClauseAliasAndRelationBoundaries() {
    function parse(source) {
        return parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    }

    var qualified = parse('SELECT payload.from AS from_value FROM src');
    assert.deepStrictEqual(
        uniqueValues(flatten(qualified.root), 'clause', 'clauseKind'),
        ['select', 'from'],
        'qualified clause-shaped field must not split SELECT early'
    );
    assert.deepStrictEqual(
        flatten(qualified.root).filter(function(node) {
            return node.kind === 'clause';
        }).map(function(node) {
            return qualified.leaves.slice(node.leafRange.start, node.leafRange.end)
                .map(function(leaf) { return leaf.raw; }).join('');
        }),
        ['SELECT payload.from AS from_value', 'FROM src'],
        'qualified clause-shaped field must stay inside the SELECT body'
    );
    assert.strictEqual(qualified.root.children[0].statementKind, 'query');

    var caseSource = 'SELECT CASE WHEN x THEN y END FROM src';
    var caseResult = parse(caseSource);
    var caseItem = flatten(caseResult.root).filter(function(node) {
        return node.kind === 'list-item' && node.itemRole === 'select-item';
    })[0];
    var caseValue = flatten(caseResult.root).filter(function(node) {
        return node.id === caseItem.valueChildId;
    })[0];
    assert.strictEqual(caseItem.alias, null, 'CASE END must not be inferred as an alias');
    assert.strictEqual(
        caseSource.slice(caseValue.span.start, caseValue.span.end),
        'CASE WHEN x THEN y END',
        'opaque CASE value must retain END'
    );

    var functionSource = 'SELECT count(*) c FROM src';
    var functionResult = parse(functionSource);
    var functionItem = flatten(functionResult.root).filter(function(node) {
        return node.kind === 'list-item' && node.itemRole === 'select-item';
    })[0];
    assert.ok(functionItem.alias, 'implicit alias after a closed call must be recorded');
    assert.strictEqual(
        functionSource.slice(
            functionResult.leaves[functionItem.alias.nameLeafRange.start].span.start,
            functionResult.leaves[functionItem.alias.nameLeafRange.end - 1].span.end
        ),
        'c'
    );

    [
        'SELECT 1 FROM ,src',
        'SELECT 1 FROM src,',
        'SELECT 1 FROM src,,other',
        'SELECT x AS',
        'SELECT x AS FROM src',
        'SELECT DISTINCT ALL x FROM src',
        'SELECT ALL DISTINCT x FROM src',
        'SELECT 1 FROM src OUTER JOIN other ON src.id = other.id',
        'SELECT 1 FROM src JOIN other USING (id)',
        'SELECT id, FROM src',
        'SELECT id FROM src UNION',
        'SELECT id ORDER BY id FROM src',
        'SELECT id FROM src ORDER BY id DESC ASC',
        'SELECT id FROM src SORT BY id ASC DESC',
        'WITH c() AS (SELECT 1) SELECT 1',
        'WITH c(a b) AS (SELECT 1) SELECT 1',
        'INSERT OVERWRITE TABLE dst PARTITION (ds=1) junk SELECT id FROM src',
        'INSERT OVERWRITE DIRECTORY \'/tmp/out\' SELECT id FROM src',
        'SELECT id FROM src LATERAL VIEW EXPLODE(items)',
        'SELECT id FROM src LATERAL VIEW EXPLODE(items) e AS item extra',
        'WITH 1 AS (SELECT 1) SELECT 1'
    ].forEach(function(source) {
        var result = parse(source);
        assert.strictEqual(
            result.root.children[0].statementKind,
            'opaque',
            'unconsumed or malformed structure must preserve statement: ' + source
        );
        assert.ok(result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement';
        }), 'statement-preserving diagnostic required: ' + source);
    });

    var qualifiedFunction = parse('SELECT 1 FROM catalog.fn(1) f');
    assert.ok(
        uniqueValues(flatten(qualifiedFunction.root), 'relation', 'relationKind')
            .indexOf('table-function') >= 0,
        'qualified table function must not be mislabeled as a table'
    );

    var qualifiedJoinName = parse('SELECT 1 FROM catalog.join');
    assert.strictEqual(qualifiedJoinName.root.children[0].statementKind, 'query',
        'qualified keyword-shaped table name must remain a structured query');
    assert.deepStrictEqual(
        uniqueValues(flatten(qualifiedJoinName.root), 'relation', 'relationKind'),
        ['table'],
        'catalog.join must be one qualified table relation'
    );

    var qualifiedJoinField = parse('SELECT a.id FROM a JOIN b ON b.join = a.id');
    assert.strictEqual(qualifiedJoinField.root.children[0].statementKind, 'query');
    assert.deepStrictEqual(
        flatten(qualifiedJoinField.root).filter(function(node) {
            return node.kind === 'relation' && node.relationKind === 'join';
        }).length,
        1,
        'qualified join field inside ON must not create a second JOIN relation'
    );
    assert.strictEqual(flatten(qualifiedJoinField.root).some(function(node) {
        return node.kind === 'relation' && node.relationKind === 'opaque';
    }), false, 'qualified join field must stay inside the proven ON expression boundary');

    [
        'SELECT from.id FROM src WHERE from.id > 0',
        'SELECT id FROM src WHERE x = 1 AND window.id > 0',
        'SELECT id FROM src WHERE x = 1 AND union.id > 0'
    ].forEach(function(source) {
        var result = parse(source);
        assert.strictEqual(result.root.children[0].statementKind, 'query',
            'dotted keyword-shaped expression component must remain structured: ' + source);
        assert.deepStrictEqual(
            uniqueValues(flatten(result.root), 'clause', 'clauseKind'),
            ['select', 'from', 'where'],
            'dotted keyword-shaped component must not create a clause or set marker: ' + source
        );
    });

    var keywordJoinAlias = parse(
        'SELECT a.id FROM a JOIN b AS join ON join.id = a.id');
    assert.strictEqual(keywordJoinAlias.root.children[0].statementKind, 'query');
    assert.strictEqual(flatten(keywordJoinAlias.root).filter(function(node) {
        return node.kind === 'relation' && node.relationKind === 'join';
    }).length, 1, 'AS join and join.id must not create extra JOIN markers');

    var leadingKeywordTable = parse('SELECT 1 FROM join.schema');
    assert.strictEqual(leadingKeywordTable.root.children[0].statementKind, 'query');
    assert.deepStrictEqual(
        uniqueValues(flatten(leadingKeywordTable.root), 'relation', 'relationKind'),
        ['table'],
        'join.schema must remain one qualified table relation'
    );

    ['all', 'distinct'].forEach(function(name) {
        var source = 'SELECT ' + name + '.value FROM src';
        var result = parse(source);
        var selectClause = flatten(result.root).filter(function(node) {
            return node.kind === 'clause' && node.clauseKind === 'select';
        })[0];
        assert.strictEqual(
            result.leaves.slice(selectClause.headLeafRange.start, selectClause.headLeafRange.end)
                .map(function(leaf) { return leaf.raw; }).join(''),
            'SELECT',
            name + '.value must not be consumed as a SELECT head modifier'
        );
    });

    [
        'SELECT id FROM src ORDER BY sort.desc',
        'SELECT id FROM src SORT BY sort.asc'
    ].forEach(function(source) {
        var result = parse(source);
        var item = flatten(result.root).filter(function(node) {
            return node.kind === 'list-item' &&
                (node.itemRole === 'order-by-item' || node.itemRole === 'sort-by-item');
        })[0];
        assert.deepStrictEqual(item.modifierLeafIds, [],
            'dotted asc/desc name must not become a sort modifier: ' + source);
    });
}());

console.log('v2 Hive CST parser tests passed (' + cases.length + ' fixture cases)');
