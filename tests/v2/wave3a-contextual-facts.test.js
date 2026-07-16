'use strict';

var assert = require('assert');
var analysis = require('../../.tmp/v2-core/core/analysis/index.js');

function analyze(source, dialect) {
    var artifact = analysis.analyzeSql(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    assert.strictEqual(
        artifact.status,
        'analyzed',
        source + '\n' + JSON.stringify(artifact.diagnostics, null, 2)
    );
    return artifact;
}

function nodeText(artifact, node) {
    return artifact.source.slice(node.span.start, node.span.end);
}

function nodesOf(artifact, kind, subtypeField, subtype) {
    return artifact.index.nodes().filter(function(node) {
        return node.kind === kind &&
            (subtypeField === undefined || node[subtypeField] === subtype);
    });
}

function markerRows(artifact, node, syntaxId) {
    return node.syntaxMarkers.filter(function(marker) {
        return marker.syntaxId === syntaxId;
    }).map(function(marker) {
        return {
            raw: artifact.leaves[marker.leafId].raw,
            ordinal: marker.partOrdinal,
            marker: marker
        };
    });
}

function assertMarkerSequence(artifact, node, syntaxId, expectedRaw, options) {
    var rows = markerRows(artifact, node, syntaxId);
    assert.deepStrictEqual(rows.map(function(row) {
        return row.raw.toUpperCase();
    }), expectedRaw.map(function(raw) {
        return raw.toUpperCase();
    }), nodeText(artifact, node) + ' ' + syntaxId + ' marker raw');
    assert.deepStrictEqual(rows.map(function(row) {
        return row.ordinal;
    }), expectedRaw.map(function(_raw, ordinal) {
        return ordinal;
    }), nodeText(artifact, node) + ' ' + syntaxId + ' partOrdinal');

    rows.forEach(function(row) {
        var syntax = artifact.index.leafContext(row.marker.leafId).syntax;
        assert.ok(syntax, syntaxId + ' must have contextual syntax facts');
        assert.strictEqual(syntax.directOwnerNodeId, node.id, syntaxId + ' direct owner');
        assert.strictEqual(syntax.syntaxId, syntaxId, syntaxId + ' contextual identity');
        assert.strictEqual(
            syntax.keywordCaseEligible,
            options && options.keywordCaseEligible === false ? false : true,
            syntaxId + ' keyword case proof'
        );
    });
}

function assertOperatorClosure(artifact) {
    nodesOf(artifact, 'expression').forEach(function(node) {
        var occurrenceLeafIds = [];
        node.operatorOccurrences.forEach(function(occurrence) {
            Array.prototype.push.apply(occurrenceLeafIds, occurrence.leafIds);
        });
        occurrenceLeafIds.sort(function(left, right) {
            return left - right;
        });
        assert.deepStrictEqual(
            node.operatorLeafIds,
            occurrenceLeafIds,
            nodeText(artifact, node) + ' operatorLeafIds must equal operatorOccurrences'
        );
    });
}

(function testKeywordShapedNamesRemainNames() {
    var artifact = analyze('SELECT window AS order FROM group');
    var expectedRoles = {
        window: 'identifier-name',
        order: 'alias-name',
        group: 'relation-name'
    };

    Object.keys(expectedRoles).forEach(function(raw) {
        var leaf = artifact.leaves.find(function(candidate) {
            return candidate.raw === raw;
        });
        assert.ok(leaf, raw + ' leaf required');
        var syntax = artifact.index.leafContext(leaf.id).syntax;
        assert.ok(syntax, raw + ' contextual facts required');
        assert.strictEqual(syntax.syntaxRole, expectedRoles[raw]);
        assert.strictEqual(syntax.syntaxId, null);
        assert.strictEqual(syntax.keywordCaseEligible, false);
    });

    var asLeaf = artifact.leaves.find(function(leaf) {
        return leaf.raw.toUpperCase() === 'AS';
    });
    assert.strictEqual(artifact.index.leafContext(asLeaf.id).syntax.syntaxId, 'alias-as');
}());

(function testContainerGrammarMarkerClosure() {
    var aliasArtifact = analyze('SELECT a AS b FROM t AS x;');
    var selectClause = nodesOf(aliasArtifact, 'clause', 'clauseKind', 'select')[0];
    var fromClause = nodesOf(aliasArtifact, 'clause', 'clauseKind', 'from')[0];
    var statement = nodesOf(aliasArtifact, 'statement')[0];
    var selectItem = nodesOf(aliasArtifact, 'list-item').find(function(node) {
        return node.alias !== null && node.alias.keywordLeafId !== null;
    });
    var table = nodesOf(aliasArtifact, 'relation', 'relationKind', 'table').find(function(node) {
        return node.alias !== null && node.alias.keywordLeafId !== null;
    });
    assertMarkerSequence(aliasArtifact, selectClause, 'clause:select', ['SELECT']);
    assertMarkerSequence(aliasArtifact, fromClause, 'clause:from', ['FROM']);
    assertMarkerSequence(aliasArtifact, selectItem, 'alias-as', ['AS']);
    assertMarkerSequence(aliasArtifact, table, 'alias-as', ['AS']);
    assertMarkerSequence(
        aliasArtifact,
        statement,
        'statement-terminator',
        [';'],
        { keywordCaseEligible: false }
    );

    ['ALL', 'DISTINCT'].forEach(function(qualifier) {
        var setArtifact = analyze(
            'WITH q AS (SELECT 1) SELECT 1 UNION ' + qualifier + ' SELECT 2'
        );
        var cte = nodesOf(setArtifact, 'cte')[0];
        var setClause = nodesOf(
            setArtifact,
            'clause',
            'clauseKind',
            'set-operation'
        )[0];
        assertMarkerSequence(setArtifact, cte, 'cte-as', ['AS']);
        assertMarkerSequence(
            setArtifact,
            setClause,
            'set-operator',
            ['UNION', qualifier]
        );
    });

    var joinArtifact = analyze(
        'SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id'
    );
    var join = nodesOf(joinArtifact, 'relation', 'relationKind', 'join')[0];
    assertMarkerSequence(
        joinArtifact,
        join,
        'join-head',
        ['LEFT', 'OUTER', 'JOIN']
    );

    var typeArtifact = analyze(
        'SELECT CAST(x AS STRUCT<a:INT,b:ARRAY<STRING>>)'
    );
    var members = nodesOf(typeArtifact, 'list-item', 'itemRole', 'type-member');
    assert.strictEqual(members.length, 2);
    members.forEach(function(member) {
        assertMarkerSequence(
            typeArtifact,
            member,
            'type:member-colon',
            [':'],
            { keywordCaseEligible: false }
        );
    });
}());

(function testCaseCastAndWordOperatorOwnership() {
    var artifact = analyze(
        'SELECT CASE WHEN a AND b THEN CAST(x AS ARRAY<INT>) ELSE 0 END v'
    );
    var caseExpression = nodesOf(artifact, 'expression', 'expressionKind', 'case')[0];
    var branches = nodesOf(artifact, 'case-branch');
    var whenBranch = branches.find(function(node) {
        return node.branchKind === 'when';
    });
    var elseBranch = branches.find(function(node) {
        return node.branchKind === 'else';
    });
    var castExpression = nodesOf(artifact, 'expression', 'expressionKind', 'cast')[0];

    assertMarkerSequence(artifact, caseExpression, 'case:start', ['CASE']);
    assertMarkerSequence(artifact, caseExpression, 'case:end', ['END']);
    assertMarkerSequence(artifact, whenBranch, 'case:when', ['WHEN']);
    assertMarkerSequence(artifact, whenBranch, 'case:then', ['THEN']);
    assertMarkerSequence(artifact, elseBranch, 'case:else', ['ELSE']);
    assertMarkerSequence(artifact, castExpression, 'type:cast', ['CAST']);
    assertMarkerSequence(artifact, castExpression, 'type:as', ['AS']);
    assertMarkerSequence(
        artifact,
        castExpression,
        'delimiter',
        ['(', ')'],
        { keywordCaseEligible: false }
    );
    assert.deepStrictEqual(caseExpression.operatorLeafIds, []);
    assert.deepStrictEqual(castExpression.operatorLeafIds, []);

    var andLeaf = artifact.leaves.find(function(leaf) {
        return leaf.raw.toUpperCase() === 'AND';
    });
    var andContext = artifact.index.leafContext(andLeaf.id).syntax;
    var andOccurrence = artifact.index.operatorOccurrenceForLeaf(andLeaf.id);
    assert.strictEqual(andContext.syntaxRole, 'word-operator-keyword');
    assert.strictEqual(andContext.syntaxId, 'operator');
    assert.strictEqual(andContext.keywordCaseEligible, true);
    assert.ok(andOccurrence);
    assert.strictEqual(andOccurrence.semantics.key, 'and');
    assert.strictEqual(andOccurrence.ownerNodeId, andContext.directOwnerNodeId);
    assertOperatorClosure(artifact);
}());

(function testQuotedTypeNameUsesRangeOwnershipWithoutProtectedMarker() {
    var artifact = analyze('SELECT CAST(x AS `Order`) FROM t');
    var typeNode = nodesOf(artifact, 'type-expression').find(function(node) {
        return nodeText(artifact, node) === '`Order`';
    });
    assert.ok(typeNode, 'quoted type node required');
    assert.deepStrictEqual(markerRows(artifact, typeNode, 'type:name'), []);
    var leaf = artifact.leaves[typeNode.typeNameLeafRange.start];
    assert.strictEqual(leaf.channel, 'protected');
    var syntax = artifact.index.leafContext(leaf.id).syntax;
    assert.ok(syntax);
    assert.strictEqual(syntax.directOwnerNodeId, typeNode.id);
    assert.strictEqual(syntax.syntaxRole, 'user-type-name');
    assert.strictEqual(syntax.syntaxId, null);
    assert.strictEqual(syntax.keywordCaseEligible, false);
}());

(function testWindowAndFrameMarkerClosure() {
    var artifact = analyze([
        'SELECT sum(x) OVER (',
        'PARTITION BY k ORDER BY ts ',
        'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW',
        '), sum(y) OVER (ORDER BY z RANGE 1 FOLLOWING)',
        ', sum(q) OVER (ORDER BY z GROUPS BETWEEN 2 PRECEDING AND 3 FOLLOWING)',
        ' FROM t'
    ].join(''));
    var windowExpressions = nodesOf(
        artifact,
        'expression',
        'expressionKind',
        'window'
    ).sort(function(left, right) {
        return left.span.start - right.span.start;
    });
    var specs = nodesOf(artifact, 'window-spec').sort(function(left, right) {
        return left.span.start - right.span.start;
    });
    assert.strictEqual(windowExpressions.length, 3);
    assert.strictEqual(specs.length, 3);

    windowExpressions.forEach(function(node) {
        assertMarkerSequence(artifact, node, 'window:over', ['OVER']);
        assert.deepStrictEqual(node.operatorLeafIds, []);
    });
    assertMarkerSequence(artifact, specs[0], 'window:partition-by', ['PARTITION', 'BY']);
    specs.forEach(function(spec) {
        assertMarkerSequence(artifact, spec, 'window:order-by', ['ORDER', 'BY']);
        assertMarkerSequence(
            artifact,
            spec,
            'delimiter',
            ['(', ')'],
            { keywordCaseEligible: false }
        );
    });

    var rowsFrame = artifact.index.nodeById(specs[0].frameChildId);
    var rangeFrame = artifact.index.nodeById(specs[1].frameChildId);
    var groupsFrame = artifact.index.nodeById(specs[2].frameChildId);
    assertMarkerSequence(artifact, rowsFrame, 'window:rows', ['ROWS']);
    assertMarkerSequence(artifact, rowsFrame, 'window:between', ['BETWEEN']);
    assertMarkerSequence(artifact, rowsFrame, 'window:and', ['AND']);
    assertMarkerSequence(artifact, rangeFrame, 'window:range', ['RANGE']);
    assertMarkerSequence(artifact, groupsFrame, 'window:groups', ['GROUPS']);
    assertMarkerSequence(artifact, groupsFrame, 'window:between', ['BETWEEN']);
    assertMarkerSequence(artifact, groupsFrame, 'window:and', ['AND']);

    var rowsLower = rowsFrame.children[0];
    var rowsUpper = rowsFrame.children[1];
    assertMarkerSequence(artifact, rowsLower, 'window:unbounded', ['UNBOUNDED']);
    assertMarkerSequence(artifact, rowsLower, 'window:preceding', ['PRECEDING']);
    assertMarkerSequence(artifact, rowsUpper, 'window:current-row', ['CURRENT', 'ROW']);
    assertMarkerSequence(
        artifact,
        rangeFrame.children[0],
        'window:following',
        ['FOLLOWING']
    );
    assertMarkerSequence(
        artifact,
        groupsFrame.children[0],
        'window:preceding',
        ['PRECEDING']
    );
    assertMarkerSequence(
        artifact,
        groupsFrame.children[1],
        'window:following',
        ['FOLLOWING']
    );
    assertOperatorClosure(artifact);
}());

(function testNamedWindowDeclarationOwnsAsAndPartitionMarkers() {
    var artifact = analyze(
        'SELECT sum(x) OVER w FROM t WINDOW w AS (PARTITION BY k)'
    );
    var declaration = nodesOf(artifact, 'window-spec').find(function(node) {
        return nodeText(artifact, node).indexOf('w AS (') === 0;
    });
    assert.ok(declaration, 'named WINDOW declaration required');
    assertMarkerSequence(artifact, declaration, 'alias-as', ['AS']);
    assertMarkerSequence(
        artifact,
        declaration,
        'window:partition-by',
        ['PARTITION', 'BY']
    );
}());

(function testGrammarMarkersAreNotOperatorLeaves() {
    var artifact = analyze([
        "SELECT f(DISTINCT x), a.b, ARRAY[1, 2], (x), DATE '2020-01-01',",
        ' EXISTS (SELECT 1), y IN (1, 2)',
        ' FROM t'
    ].join(''));
    var distinctCall = nodesOf(artifact, 'expression', 'expressionKind', 'function-call')
        .find(function(node) {
            return nodeText(artifact, node).indexOf('f(DISTINCT') === 0;
        });
    var qualified = nodesOf(
        artifact,
        'expression',
        'expressionKind',
        'qualified-identifier'
    )[0];
    var exists = nodesOf(artifact, 'expression', 'expressionKind', 'exists')[0];
    var inExpression = nodesOf(artifact, 'expression', 'expressionKind', 'in')[0];
    var typedLiteral = nodesOf(
        artifact,
        'expression',
        'expressionKind',
        'typed-literal'
    )[0];
    var parenthesizedQuery = nodesOf(artifact, 'query', 'queryKind', 'parenthesized')[0];

    assertMarkerSequence(artifact, distinctCall, 'operator', ['DISTINCT']);
    assertMarkerSequence(
        artifact,
        distinctCall,
        'delimiter',
        ['(', ')'],
        { keywordCaseEligible: false }
    );
    assertMarkerSequence(
        artifact,
        qualified,
        'delimiter',
        ['.'],
        { keywordCaseEligible: false }
    );
    assertMarkerSequence(artifact, exists, 'operator', ['EXISTS']);
    assertMarkerSequence(artifact, typedLiteral, 'type:name', ['DATE']);
    assertMarkerSequence(
        artifact,
        parenthesizedQuery,
        'delimiter',
        ['(', ')'],
        { keywordCaseEligible: false }
    );
    assertMarkerSequence(
        artifact,
        inExpression,
        'delimiter',
        ['(', ')'],
        { keywordCaseEligible: false }
    );
    assertOperatorClosure(artifact);
}());

(function testGeneralBetweenKeepsOneCompleteOperatorOccurrence() {
    var artifact = analyze('SELECT a NOT BETWEEN b AND c FROM t');
    var between = nodesOf(artifact, 'expression', 'expressionKind', 'between')[0];
    var occurrences = artifact.index.operatorOccurrencesOf(between.id);
    assert.strictEqual(occurrences.length, 1);
    assert.strictEqual(occurrences[0].semantics.key, 'not-between');
    assert.deepStrictEqual(occurrences[0].leafIds.map(function(leafId) {
        return artifact.leaves[leafId].raw.toUpperCase();
    }), ['NOT', 'BETWEEN', 'AND']);
    occurrences[0].leafIds.forEach(function(leafId) {
        var syntax = artifact.index.leafContext(leafId).syntax;
        assert.strictEqual(syntax.syntaxId, 'operator');
        assert.strictEqual(syntax.syntaxRole, 'word-operator-keyword');
        assert.strictEqual(syntax.directOwnerNodeId, between.id);
        assert.strictEqual(syntax.keywordCaseEligible, true);
    });
    assertOperatorClosure(artifact);
}());

console.log('v2 Wave 3A contextual facts tests passed');
