'use strict';

var assert = require('assert');
var lexer = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
var parser = require('../../.tmp/v2-core/core/syntax/parser.js');
var tokenTable = require('../../.tmp/v2-core/core/syntax/token-table.js');
var analysis = require('../../.tmp/v2-core/core/analysis/index.js');
var analyzer = require('../../.tmp/v2-core/core/analysis/analyze.js');
var dialectRegistry = require('../../.tmp/v2-core/core/dialects/registry.js');

function build(source, dialect) {
    var artifact = parser.parseSqlArtifact(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    var result = artifact.output;
    var table = artifact.tokenTable;
    var index = analysis.buildStructuralIndex({
        root: result.root,
        leaves: result.leaves,
        tokenTable: table,
        dialect: dialect || 'hive',
        diagnostics: result.diagnostics
    });
    return { artifact: artifact, result: result, table: table, index: index };
}

function nodesOfKind(index, kind) {
    return index.nodes().filter(function(node) {
        return node.kind === kind;
    });
}

function replaceNode(root, targetId, replace) {
    if (root.id === targetId) {
        return Object.freeze(replace(root));
    }
    if (!Array.isArray(root.children)) {
        return root;
    }
    var changed = false;
    var children = root.children.map(function(child) {
        var next = replaceNode(child, targetId, replace);
        changed = changed || next !== child;
        return next;
    });
    return changed
        ? Object.freeze(Object.assign({}, root, { children: Object.freeze(children) }))
        : root;
}

function directBuild(built, root) {
    return analysis.buildStructuralIndex({
        root: root,
        leaves: built.result.leaves,
        tokenTable: built.table,
        dialect: built.artifact.dialect,
        diagnostics: built.result.diagnostics
    });
}

(function testAnalyzeSqlConsumesRetainedParseArtifact() {
    var source = 'SELECT a, b FROM t WHERE a > 0';
    var output = analysis.analyzeSql(source, { dialect: 'hive', mode: 'document' });
    var parsed = parser.parseSql(source, { dialect: 'hive', mode: 'document' });

    assert.strictEqual(output.status, 'analyzed');
    assert.ok(Object.isFrozen(output));
    assert.ok(output.index && Object.isFrozen(output.index));
    assert.deepStrictEqual(output.root, parsed.root);
    assert.deepStrictEqual(output.leaves, parsed.leaves);
    assert.deepStrictEqual(output.diagnostics, parsed.diagnostics);
    assert.strictEqual(output.index.nodeById(0), output.root);
}());

(function testAnalysisInvariantFailurePreservesTargetWithoutPartialIndex() {
    var built = build('SELECT 1; SELECT 2');
    var firstStatement = built.result.root.children[0];
    var forgedRoot = Object.freeze(Object.assign({}, built.result.root, {
        children: Object.freeze([firstStatement, firstStatement])
    }));
    var forgedArtifact = Object.freeze(Object.assign({}, built.artifact, {
        output: Object.freeze(Object.assign({}, built.result, { root: forgedRoot }))
    }));
    assert.strictEqual(parser.isCanonicalParseArtifact(forgedArtifact), false);
    assert.strictEqual(
        parser.isCanonicalParseArtifact(parser.preserveParseArtifactTarget(
            forgedArtifact,
            'forged artifact fallback'
        )),
        false,
        'fallback must not grant canonical trust to a forged artifact'
    );
    var output = analyzer.analyzeParseArtifact(forgedArtifact);

    assert.strictEqual(output.status, 'preserved');
    assert.ok(output.index && Object.isFrozen(output.index));
    assert.strictEqual(output.root.children.length, 1);
    assert.strictEqual(output.root.children[0].statementKind, 'opaque');
    assert.strictEqual(output.root.children[0].children[0].boundary, 'target');
    assert.strictEqual(output.root.children[0].children[0].capabilityId, null);
    assert.ok(output.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_INTERNAL_INVARIANT' &&
            diagnostic.recovery === 'preserve-target' &&
            diagnostic.capabilityId === null;
    }));
    assert.strictEqual(output.leaves.map(function(leaf) { return leaf.raw; }).join(''),
        forgedArtifact.source);
}());

(function testAnalysisFallbackContainsBrokenTokenTable() {
    var built = build('SELECT 1');
    var brokenTable = Object.freeze(Object.assign({}, built.table, {
        leafCount: function() {
            throw new Error('leafCount boom');
        }
    }));
    var forgedArtifact = Object.freeze(Object.assign({}, built.artifact, {
        tokenTable: brokenTable
    }));
    var output;
    assert.doesNotThrow(function() {
        output = analyzer.analyzeParseArtifact(forgedArtifact);
    });
    assert.strictEqual(output.status, 'failed');
    assert.strictEqual(output.index, null);
    assert.strictEqual(output.leaves.map(function(leaf) { return leaf.raw; }).join(''),
        forgedArtifact.source);
}());

(function testAnalysisRejectsSourceAndDialectProvenanceDrift() {
    var hiveArtifact = parser.parseSqlArtifact('SELECT 1', {
        dialect: 'hive',
        mode: 'document'
    });
    var wrongSourceArtifact = Object.freeze(Object.assign({}, hiveArtifact, {
        source: 'SELECT 2'
    }));
    assert.strictEqual(parser.isCanonicalParseArtifact(wrongSourceArtifact), false);
    var wrongSource = analyzer.analyzeParseArtifact(wrongSourceArtifact);
    assert.strictEqual(wrongSource.status, 'failed',
        'analysis must not index leaves under a different source identity');
    assert.strictEqual(wrongSource.index, null);
    assert.strictEqual(wrongSource.leaves.map(function(leaf) { return leaf.raw; }).join(''),
        'SELECT 1', 'failed output must retain the canonical leaf partition');

    var mysqlArtifact = parser.parseSqlArtifact('SELECT @name', {
        dialect: 'mysql',
        mode: 'document'
    });
    var mysqlIndex = analysis.buildStructuralIndex({
        root: mysqlArtifact.output.root,
        leaves: mysqlArtifact.output.leaves,
        tokenTable: mysqlArtifact.tokenTable,
        dialect: 'mysql',
        diagnostics: mysqlArtifact.output.diagnostics
    });
    var mysqlVariableNode = mysqlIndex.nodes().filter(function(node) {
        return node.kind === 'expression' && node.expressionKind === 'parameter';
    })[0];
    assert.ok(mysqlVariableNode);
    assert.strictEqual(
        mysqlIndex.capabilityForNode(mysqlVariableNode.id).id,
        'mysql-variables',
        'dialect-specific primitive capability must reach StructuralIndex'
    );
    assert.strictEqual(
        mysqlIndex.leafContext(mysqlVariableNode.leafRange.start)
            .syntax.capabilityId,
        'mysql-variables',
        'primitive capability must reach its contextual leaf occurrence'
    );
    var wrongDialectArtifact = Object.freeze(Object.assign({}, mysqlArtifact, {
        dialect: 'postgresql'
    }));
    assert.strictEqual(parser.isCanonicalParseArtifact(wrongDialectArtifact), false);
    var wrongDialect = analyzer.analyzeParseArtifact(wrongDialectArtifact);
    assert.strictEqual(wrongDialect.status, 'failed',
        'analysis must not reinterpret a MySQL leaf partition as PostgreSQL');
    assert.strictEqual(wrongDialect.index, null);

    var wrongModeArtifact = Object.freeze(Object.assign({}, hiveArtifact, {
        mode: 'fragment'
    }));
    assert.strictEqual(parser.isCanonicalParseArtifact(wrongModeArtifact), false);
    var wrongMode = analyzer.analyzeParseArtifact(wrongModeArtifact);
    assert.strictEqual(wrongMode.status, 'failed',
        'analysis must not relabel a document CST as a fragment artifact');
    assert.strictEqual(wrongMode.index, null);

    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: mysqlArtifact.output.root,
            leaves: mysqlArtifact.output.leaves,
            tokenTable: mysqlArtifact.tokenTable,
            dialect: 'postgresql',
            diagnostics: mysqlArtifact.output.diagnostics
        });
    }, /canonical.*dialect|dialect.*partition/i,
    'direct index construction must reject a dialect different from lexer provenance');
}());

(function testTreeStatementQueryAndClauseIndexes() {
    var source = [
        'WITH q AS (',
        '  SELECT CASE WHEN a > 0 THEN a ELSE 0 END AS value,',
        '         row_number() OVER (PARTITION BY k ORDER BY ts) AS rn',
        '  FROM src WHERE flag = 1',
        ')',
        'SELECT value, rn FROM q WHERE rn = 1;',
        'SELECT 2'
    ].join('\n');
    var built = build(source);
    var index = built.index;

    assert.ok(Object.isFrozen(index), 'query surface must be frozen');
    assert.strictEqual(index.nodeById(0), built.result.root);
    assert.strictEqual(index.parentOf(0), null);
    assert.deepStrictEqual(index.childrenOf(0), built.result.root.children);
    assert.ok(Object.isFrozen(index.nodes()));
    assert.ok(Object.isFrozen(index.childrenOf(0)));

    var statements = index.statements();
    assert.strictEqual(statements.length, 2);
    assert.ok(Object.isFrozen(statements));
    index.nodes().forEach(function(node) {
        var statement = index.statementOfNode(node.id);
        if (node.kind === 'program') {
            assert.strictEqual(statement, null);
        } else {
            assert.ok(statement && statement.kind === 'statement');
        }
    });

    var queries = index.queries();
    assert.ok(queries.length >= 3, 'outer, CTE, and second-statement queries');
    assert.ok(Object.isFrozen(queries));
    nodesOfKind(index, 'clause').forEach(function(clause) {
        var owner = index.queryOfClause(clause.id);
        assert.ok(owner && owner.kind === 'query');
        assert.ok(index.clausesOfQuery(owner.id).some(function(value) {
            return value.id === clause.id;
        }));
        assert.strictEqual(index.nearestAncestor(clause.id, 'query'), owner);
    });

    var caseBranch = nodesOfKind(index, 'case-branch')[0];
    assert.ok(caseBranch, 'CASE branch must be indexed');
    assert.ok(index.nearestAncestor(caseBranch.id, 'expression'));
    assert.deepStrictEqual(index.spanOf(caseBranch.id), caseBranch.span);
    assert.deepStrictEqual(index.leafRangeOf(caseBranch.id), caseBranch.leafRange);
    assert.ok(Object.isFrozen(index.spanOf(caseBranch.id)));
    assert.ok(Object.isFrozen(index.leafRangeOf(caseBranch.id)));
}());

(function testListMemberAndSeparatorOwnership() {
    var built = build('SELECT a, b, c FROM t GROUP BY a, b, c');
    var index = built.index;
    var lists = index.lists();
    assert.ok(Object.isFrozen(lists));
    assert.ok(lists.length >= 2);

    lists.forEach(function(list) {
        var members = index.membersOfList(list.id);
        assert.ok(Object.isFrozen(members));
        members.forEach(function(member) {
            assert.strictEqual(index.listOfMember(member.id), list);
        });
        list.separatorLeafIds.forEach(function(separatorLeafId, ordinal) {
            var owner = index.separatorOwner(separatorLeafId);
            assert.ok(Object.isFrozen(owner));
            assert.strictEqual(owner.listNodeId, list.id);
            assert.strictEqual(owner.ordinal, ordinal);
            assert.strictEqual(owner.leftMemberNodeId, members[ordinal].id);
            assert.strictEqual(owner.rightMemberNodeId, members[ordinal + 1].id);
        });
    });
}());

(function testDelimiterLineColumnOffsetAndEofContracts() {
    var source = "SELECT '\ud83d\ude00' AS x,\r\n  y FROM t";
    var built = build(source);
    var index = built.index;
    var emojiOffset = source.indexOf('\ud83d\ude00');
    var emojiLocation = index.offsetToLeaf(emojiOffset);
    var secondSurrogateLocation = index.offsetToLeaf(emojiOffset + 1);
    assert.ok(emojiLocation);
    assert.strictEqual(emojiLocation.leafId, secondSurrogateLocation.leafId);
    assert.strictEqual(secondSurrogateLocation.relativeOffset,
        emojiLocation.relativeOffset + 1, 'columns and relative offsets use UTF-16 code units');

    var stringLeaf = built.result.leaves[emojiLocation.leafId];
    var stringPosition = index.leafPosition(stringLeaf.id);
    assert.deepStrictEqual(stringPosition, { line: 0, column: 7 });
    assert.deepStrictEqual(index.lineStarts(), [0, source.indexOf('\n') + 1]);
    assert.ok(Object.isFrozen(index.lineStarts()));
    assert.ok(Object.isFrozen(stringPosition));
    var lineBreakLeaf = built.result.leaves.find(function(leaf) {
        return leaf.raw.indexOf('\r') !== -1 || leaf.raw.indexOf('\n') !== -1;
    });
    assert.ok(lineBreakLeaf, 'CRLF source must expose one line-break leaf');
    assert.strictEqual(index.leafContainsLineBreak(lineBreakLeaf.id), true);
    assert.strictEqual(index.leafStartsWithLineBreak(lineBreakLeaf.id), true);
    assert.strictEqual(index.leafEndsWithLineBreak(lineBreakLeaf.id), true);
    assert.strictEqual(index.leafContainsLineBreak(stringLeaf.id), false);
    assert.strictEqual(index.leafStartsWithLineBreak(stringLeaf.id), false);
    assert.strictEqual(index.leafEndsWithLineBreak(stringLeaf.id), false);
    assert.strictEqual(index.rangeContainsLineBreak({
        start: lineBreakLeaf.id,
        end: lineBreakLeaf.id + 1
    }), true);
    assert.strictEqual(index.rangeStartsWithLineBreak({
        start: lineBreakLeaf.id,
        end: lineBreakLeaf.id + 1
    }), true);
    assert.strictEqual(index.rangeEndsWithLineBreak({
        start: lineBreakLeaf.id,
        end: lineBreakLeaf.id + 1
    }), true);
    assert.strictEqual(index.rangeContainsLineBreak({
        start: stringLeaf.id,
        end: stringLeaf.id + 1
    }), false);
    assert.strictEqual(index.rangeStartsWithLineBreak({
        start: stringLeaf.id,
        end: stringLeaf.id + 1
    }), false);
    assert.strictEqual(index.rangeEndsWithLineBreak({
        start: stringLeaf.id,
        end: stringLeaf.id + 1
    }), false);
    assert.strictEqual(index.rangeContainsLineBreak({ start: 0, end: 0 }), false);
    assert.strictEqual(index.rangeStartsWithLineBreak({ start: 0, end: 0 }), false);
    assert.strictEqual(index.rangeEndsWithLineBreak({ start: 0, end: 0 }), false);

    var eof = index.offsetToLeaf(source.length);
    var lastLeaf = built.result.leaves[built.result.leaves.length - 1];
    assert.deepStrictEqual(eof, {
        leafId: lastLeaf.id,
        relativeOffset: lastLeaf.raw.length,
        atEnd: true
    });

    built.result.leaves.forEach(function(leaf) {
        assert.strictEqual(index.depthBefore(leaf.id),
            built.table.depthBefore(leaf.id));
        var mate = index.matchingDelimiter(leaf.id);
        if (mate !== null) {
            assert.strictEqual(index.matchingDelimiter(mate), leaf.id);
        }
    });

    assert.throws(function() { index.offsetToLeaf(-1); }, /offset/i);
    assert.throws(function() { index.offsetToLeaf(source.length + 1); }, /offset/i);
    assert.throws(function() { index.offsetToLeaf(1.5); }, /offset/i);
    assert.throws(function() {
        index.rangeContainsLineBreak({ start: -1, end: 0 });
    }, /range/i);
}());

(function testBlankLineFactsExcludeCommentRawAndWorkWithoutComments() {
    var plain = build('SELECT a\n\n\nFROM t');
    var plainA = plain.result.leaves.find(function(leaf) {
        return leaf.raw === 'a';
    });
    var plainFrom = plain.result.leaves.find(function(leaf) {
        return leaf.raw.toLowerCase() === 'from';
    });
    assert.ok(plainA && plainFrom);
    assert.strictEqual(
        plain.index.blankLineCountBetween(plainA.id + 1, plainFrom.id),
        2,
        'line facts must exist even when the source has no comments'
    );

    var withComment = build('SELECT a /* x\n\n y */\n\nFROM t');
    var commentA = withComment.result.leaves.find(function(leaf) {
        return leaf.raw === 'a';
    });
    var commentFrom = withComment.result.leaves.find(function(leaf) {
        return leaf.raw.toLowerCase() === 'from';
    });
    assert.ok(commentA && commentFrom);
    assert.strictEqual(
        withComment.index.blankLineCountBetween(
            commentA.id + 1,
            commentFrom.id
        ),
        1,
        'line breaks inside comment raw must not invent source blank lines'
    );
    assert.throws(function() {
        plain.index.blankLineCountBetween(-1, 0);
    }, /boundary range/i);
    assert.throws(function() {
        plain.index.blankLineCountBetween(plain.result.leaves.length + 1,
            plain.result.leaves.length + 1);
    }, /boundary range/i);
}());

(function testEmptySourceContract() {
    var built = build('');
    assert.deepStrictEqual(built.index.nodes(), [built.result.root]);
    assert.deepStrictEqual(built.index.statements(), []);
    assert.deepStrictEqual(built.index.lineStarts(), [0]);
    assert.strictEqual(built.index.offsetToLeaf(0), null);
    assert.throws(function() { built.index.offsetToLeaf(1); }, /offset/i);
}());

(function testCommentBindingAndOwnerReverseLookup() {
    var source = 'CREATE TABLE t (a STRING /* keep */)';
    var built = build(source);
    var index = built.index;
    var comments = built.result.leaves.filter(function(leaf) {
        return leaf.kind === 'line-comment' || leaf.kind === 'block-comment';
    });
    assert.strictEqual(comments.length, 1);
    var binding = index.commentBinding(comments[0].id);
    assert.ok(binding);
    assert.strictEqual(binding.placement, 'dangling');
    assert.strictEqual(index.nodeById(binding.ownerNodeId).kind, 'opaque');
    assert.deepStrictEqual(index.commentsForOwner(binding.ownerNodeId), [binding]);
    assert.ok(Object.isFrozen(index.commentBindings()));
    assert.ok(Object.isFrozen(index.commentsForOwner(binding.ownerNodeId)));
}());

(function testCapabilityLookupAndFutureStructuredIdentity() {
    var source = 'SELECT a FROM t QUALIFY row_number() OVER() = 1';
    var built = build(source);
    assert.deepStrictEqual(built.index.capability('qualify'), {
        id: 'qualify',
        state: 'diagnostic'
    });
    assert.strictEqual(built.index.capability('does-not-exist'), null);

    built.result.diagnostics.forEach(function(diagnostic, diagnosticIndex) {
        if (typeof diagnostic.capabilityId === 'string') {
            assert.strictEqual(
                built.index.capabilityForDiagnostic(diagnosticIndex).id,
                diagnostic.capabilityId
            );
        } else {
            assert.strictEqual(built.index.capabilityForDiagnostic(diagnosticIndex), null);
        }
    });
    nodesOfKind(built.index, 'opaque').forEach(function(node) {
        if (typeof node.capabilityId === 'string') {
            assert.strictEqual(built.index.capabilityForOpaque(node.id).id, node.capabilityId);
        } else {
            assert.strictEqual(built.index.capabilityForOpaque(node.id), null);
        }
    });
}());

(function testInvalidIdsImmutabilityDeterminismAndFailClosedBuild() {
    var source = 'SELECT a, b FROM t; SELECT c FROM u';
    var first = build(source);
    var second = build(source);
    assert.deepStrictEqual(first.index.snapshot(), second.index.snapshot());
    assert.ok(Object.isFrozen(first.index.snapshot()));

    assert.throws(function() { first.index.nodeById(-1); }, /node id/i);
    assert.throws(function() { first.index.nodeById(999999); }, /node id/i);
    assert.throws(function() { first.index.parentOf(1.5); }, /node id/i);
    assert.throws(function() { first.index.childrenOf(999999); }, /node id/i);
    assert.throws(function() { first.index.depthBefore(-1); }, /leaf id/i);
    assert.throws(function() { first.index.commentBinding(999999); }, /leaf id/i);
    assert.throws(function() { first.index.capabilityForDiagnostic(-1); }, /diagnostic/i);

    assert.throws(function() {
        first.index.nodes().push(first.result.root);
    }, TypeError);

    var sharedStatementRoot = Object.freeze(Object.assign({}, first.result.root, {
        children: Object.freeze([
            first.result.root.children[0],
            first.result.root.children[0]
        ])
    }));
    var table = tokenTable.buildStructuralTokenTable(first.result.leaves, source);
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: sharedStatementRoot,
            leaves: first.result.leaves,
            tokenTable: table,
            dialect: 'hive',
            diagnostics: first.result.diagnostics
        });
    }, /shared|duplicate|node id/i, 'builder must fail closed on invalid topology');

    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: first.result.root,
            leaves: first.result.leaves,
            tokenTable: Object.freeze({
                leafCount: function() { return first.result.leaves.length; }
            }),
            dialect: 'hive',
            diagnostics: first.result.diagnostics
        });
    }, /canonical.*token table|token table/i,
    'index must not retain an unbranded live token table');

    var delimiterArtifact = parser.parseSqlArtifact('SELECT (a)', {
        dialect: 'hive',
        mode: 'document'
    });
    var commaArtifact = parser.parseSqlArtifact('SELECT a,b', {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(delimiterArtifact.output.leaves.length,
        commaArtifact.output.leaves.length, 'probe requires equal leaf counts');
    var wrongSourceTable = tokenTable.buildStructuralTokenTable(
        delimiterArtifact.output.leaves,
        commaArtifact.source
    );
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: delimiterArtifact.output.root,
            leaves: delimiterArtifact.output.leaves,
            tokenTable: wrongSourceTable,
            dialect: 'hive',
            diagnostics: delimiterArtifact.output.diagnostics
        });
    }, /same.*canonical.*leaf|leaf stream|token table/i,
    'index must reject a table built with leaves from a different source');
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: delimiterArtifact.output.root,
            leaves: delimiterArtifact.output.leaves,
            tokenTable: commaArtifact.tokenTable,
            dialect: 'hive',
            diagnostics: delimiterArtifact.output.diagnostics
        });
    }, /same.*leaf|leaf stream|token table/i,
    'index must reject a canonical token table from a different leaf partition');

    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: delimiterArtifact.output.root,
            leaves: commaArtifact.output.leaves,
            tokenTable: commaArtifact.tokenTable,
            dialect: 'hive',
            diagnostics: commaArtifact.output.diagnostics
        });
    }, /program.*leaf|leaf partition|canonical.*tree/i,
    'index must reject a canonical CST from a different leaf partition');

    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: first.result.root,
            leaves: first.result.leaves,
            tokenTable: first.table,
            dialect: 'hive',
            diagnostics: []
        });
    }, /diagnostics.*stable.*frozen/i,
    'index must not retain a mutable diagnostic collection');

    var mutableSpan = {
        start: first.result.root.children[0].span.start,
        end: first.result.root.children[0].span.end
    };
    var shallowFrozenRoot = replaceNode(
        first.result.root,
        first.result.root.children[0].id,
        function(statement) {
            return Object.assign({}, statement, { span: mutableSpan });
        }
    );
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: shallowFrozenRoot,
            leaves: first.result.leaves,
            tokenTable: first.table,
            dialect: 'hive',
            diagnostics: first.result.diagnostics
        });
    }, /range\/span.*stable.*frozen/i,
    'nested range and span values must not remain mutable behind a frozen index');

    var oversizedNodeIdRoot = replaceNode(
        first.result.root,
        first.result.root.children[0].id,
        function(statement) {
            return Object.assign({}, statement, { id: 1000000000 });
        }
    );
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: oversizedNodeIdRoot,
            leaves: first.result.leaves,
            tokenTable: table,
            dialect: 'hive',
            diagnostics: first.result.diagnostics
        });
    }, /linear budget/i,
    'forged ids must fail before expanding direct-address arrays');

    var separatorBuilt = build('SELECT a, b, c FROM t');
    var selectList = separatorBuilt.index.lists().filter(function(list) {
        return list.listRole === 'select-items';
    })[0];
    var duplicateSeparatorRoot = replaceNode(
        separatorBuilt.result.root,
        selectList.id,
        function(list) {
            return Object.assign({}, list, {
                separatorLeafIds: Object.freeze([
                    list.separatorLeafIds[0],
                    list.separatorLeafIds[0]
                ])
            });
        }
    );
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: duplicateSeparatorRoot,
            leaves: separatorBuilt.result.leaves,
            tokenTable: separatorBuilt.table,
            dialect: 'hive',
            diagnostics: separatorBuilt.result.diagnostics
        });
    }, /separator.*multiple/i, 'separator ownership must be globally unique');

    var opaqueBuilt = build('CREATE TABLE t (a STRING)');
    var opaque = nodesOfKind(opaqueBuilt.index, 'opaque')[0];
    var missingCapabilityRoot = replaceNode(
        opaqueBuilt.result.root,
        opaque.id,
        function(node) {
            var copy = Object.assign({}, node);
            delete copy.capabilityId;
            return copy;
        }
    );
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: missingCapabilityRoot,
            leaves: opaqueBuilt.result.leaves,
            tokenTable: opaqueBuilt.table,
            dialect: 'hive',
            diagnostics: opaqueBuilt.result.diagnostics
        });
    }, /missing required capabilityId/i);

    var nonPreservationCapabilityRoot = replaceNode(
        opaqueBuilt.result.root,
        opaque.id,
        function(node) {
            return Object.assign({}, node, { capabilityId: 'from' });
        }
    );
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: nonPreservationCapabilityRoot,
            leaves: opaqueBuilt.result.leaves,
            tokenTable: opaqueBuilt.table,
            dialect: 'hive',
            diagnostics: opaqueBuilt.result.diagnostics
        });
    }, /non-preservation state formatted/i);

    var mismatchedDiagnostics = opaqueBuilt.result.diagnostics.map(function(diagnostic) {
        return Object.freeze(Object.assign({}, diagnostic, {
            code: 'SYN_UNMODELED_CONSTRUCT'
        }));
    });
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: opaqueBuilt.result.root,
            leaves: opaqueBuilt.result.leaves,
            tokenTable: opaqueBuilt.table,
            dialect: 'hive',
            diagnostics: Object.freeze(mismatchedDiagnostics)
        });
    }, /lacks an exact matching diagnostic/i);

    var missingDiagnosticCapability = opaqueBuilt.result.diagnostics.map(function(diagnostic) {
        var copy = Object.assign({}, diagnostic);
        delete copy.capabilityId;
        return Object.freeze(copy);
    });
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: opaqueBuilt.result.root,
            leaves: opaqueBuilt.result.leaves,
            tokenTable: opaqueBuilt.table,
            dialect: 'hive',
            diagnostics: Object.freeze(missingDiagnosticCapability)
        });
    }, /diagnostic 0 is missing required capabilityId/i);

    var genericOpaqueBuilt = build('SELECT a @ b');
    assert.strictEqual(
        nodesOfKind(genericOpaqueBuilt.index, 'opaque')[0].capabilityId,
        null
    );
    assert.throws(function() {
        analysis.buildStructuralIndex({
            root: genericOpaqueBuilt.result.root,
            leaves: genericOpaqueBuilt.result.leaves,
            tokenTable: genericOpaqueBuilt.table,
            dialect: 'hive',
            diagnostics: Object.freeze([])
        });
    }, /opaque node .* lacks an exact matching diagnostic/i,
    'generic opaque recovery must also retain reason/span/recovery diagnostic identity');
}());

(function testDirectBuilderDoesNotSynthesizeParserMarkerIdentity() {
    var aliasBuilt = build('SELECT a AS b');
    var aliasOwner = nodesOfKind(aliasBuilt.index, 'list-item').filter(function(node) {
        return node.alias !== null && node.alias.keywordLeafId !== null;
    })[0];
    assert.ok(aliasOwner, 'explicit alias owner required');
    var missingAliasMarkerRoot = replaceNode(
        aliasBuilt.result.root,
        aliasOwner.id,
        function(node) {
            return Object.assign({}, node, {
                syntaxMarkers: Object.freeze(node.syntaxMarkers.filter(function(marker) {
                    return marker.syntaxId !== 'alias-as';
                }))
            });
        }
    );
    assert.throws(function() {
        directBuild(aliasBuilt, missingAliasMarkerRoot);
    }, /alias AS leaf .* requires exact parser marker ownership/i);

    var typeBuilt = build('SELECT CAST(a AS INT)');
    var typeNode = nodesOfKind(typeBuilt.index, 'type-expression')[0];
    assert.ok(typeNode, 'CAST type expression required');
    var missingTypeMarkerRoot = replaceNode(
        typeBuilt.result.root,
        typeNode.id,
        function(node) {
            return Object.assign({}, node, {
                syntaxMarkers: Object.freeze(node.syntaxMarkers.filter(function(marker) {
                    return marker.syntaxId !== 'type:name';
                }))
            });
        }
    );
    assert.throws(function() {
        directBuild(typeBuilt, missingTypeMarkerRoot);
    }, /code type name leaf .* requires exact parser marker ownership/i);
}());

(function testDirectBuilderRequiresExactCanonicalOperatorCoverage() {
    var built = build('SELECT a NOT BETWEEN b AND c');
    var expression = nodesOfKind(built.index, 'expression').filter(function(node) {
        return node.operatorOccurrences.length === 1 &&
            node.operatorOccurrences[0].leafIds.length === 3;
    })[0];
    assert.ok(expression, 'NOT BETWEEN expression with one three-word occurrence required');

    var occurrence = expression.operatorOccurrences[0];
    var positive = directBuild(built, built.result.root);
    assert.deepStrictEqual(
        positive.operatorOccurrencesOf(expression.id),
        expression.operatorOccurrences,
        'canonical multi-word occurrence must remain accepted'
    );
    occurrence.leafIds.forEach(function(leafId) {
        assert.strictEqual(
            positive.operatorOccurrenceForLeaf(leafId),
            occurrence,
            'every word of a multi-word operator must resolve to its occurrence'
        );
    });

    var missingOccurrenceRoot = replaceNode(
        built.result.root,
        expression.id,
        function(node) {
            return Object.assign({}, node, {
                operatorOccurrences: Object.freeze([])
            });
        }
    );
    assert.throws(function() {
        directBuild(built, missingOccurrenceRoot);
    }, /every operatorLeafId.*exactly one canonical operator occurrence/i,
    'operatorLeafIds without occurrences must fail closed');

    var duplicatedIds = expression.operatorLeafIds.slice();
    duplicatedIds.splice(1, 0, duplicatedIds[0]);
    var duplicateOperatorLeafIdRoot = replaceNode(
        built.result.root,
        expression.id,
        function(node) {
            return Object.assign({}, node, {
                operatorLeafIds: Object.freeze(duplicatedIds)
            });
        }
    );
    assert.throws(function() {
        directBuild(built, duplicateOperatorLeafIdRoot);
    }, /operatorLeafIds.*unique.*source-ordered/i,
    'duplicate operatorLeafIds must not collapse through Set equality');

    var duplicateOccurrenceRoot = replaceNode(
        built.result.root,
        expression.id,
        function(node) {
            return Object.assign({}, node, {
                operatorOccurrences: Object.freeze([occurrence, occurrence])
            });
        }
    );
    assert.throws(function() {
        directBuild(built, duplicateOccurrenceRoot);
    }, /duplicate.*inconsistent ownership/i,
    'one operator leaf must not be consumed by two occurrences');

    var partialOccurrence = Object.freeze(Object.assign({}, occurrence, {
        leafIds: Object.freeze(occurrence.leafIds.slice(0, -1))
    }));
    var partialMultiWordRoot = replaceNode(
        built.result.root,
        expression.id,
        function(node) {
            return Object.assign({}, node, {
                operatorOccurrences: Object.freeze([partialOccurrence])
            });
        }
    );
    assert.throws(function() {
        directBuild(built, partialMultiWordRoot);
    }, /word operator occurrence.*does not match|every operatorLeafId.*exactly one/i,
    'partial multi-word occurrence must fail closed');

    var wrongSemantics = dialectRegistry.getDialect('hive').getOperatorSemantics(
        'is-not-null',
        'postfix'
    );
    assert.ok(wrongSemantics, 'canonical three-word mismatch semantics required');
    var mismatchedOccurrence = Object.freeze({
        ownerNodeId: occurrence.ownerNodeId,
        leafIds: occurrence.leafIds,
        operatorId: wrongSemantics.id,
        capabilityId: wrongSemantics.capabilityId,
        fixity: wrongSemantics.fixity,
        formatClass: wrongSemantics.formatClass,
        semantics: wrongSemantics
    });
    var mismatchedMultiWordRoot = replaceNode(
        built.result.root,
        expression.id,
        function(node) {
            return Object.assign({}, node, {
                operatorOccurrences: Object.freeze([mismatchedOccurrence])
            });
        }
    );
    assert.throws(function() {
        directBuild(built, mismatchedMultiWordRoot);
    }, /word operator occurrence.*does not match/i,
    'canonical semantics identity must still match the referenced source words');
}());

function buildOperatorScaleFixture(operatorCount) {
    var source = new Array(operatorCount).fill('+').join(' ');
    var lexed = lexer.lexSql(source, { dialect: 'hive' });
    var table = tokenTable.buildStructuralTokenTable(lexed.leaves, source);
    var semantics = dialectRegistry.getDialect('hive').getOperatorSemantics('+', 'infix');
    assert.ok(semantics, 'canonical infix + semantics required');
    var operatorLeafIds = Object.freeze(lexed.leaves.filter(function(leaf) {
        return leaf.raw === '+';
    }).map(function(leaf) {
        return leaf.id;
    }));
    assert.strictEqual(operatorLeafIds.length, operatorCount);

    var empty = Object.freeze([]);
    var range = Object.freeze({ start: 0, end: lexed.leaves.length });
    var span = Object.freeze({ start: 0, end: source.length });
    var occurrences = Object.freeze(operatorLeafIds.map(function(leafId) {
        return Object.freeze({
            ownerNodeId: 1,
            leafIds: Object.freeze([leafId]),
            operatorId: semantics.id,
            capabilityId: semantics.capabilityId,
            fixity: semantics.fixity,
            formatClass: semantics.formatClass,
            semantics: semantics
        });
    }));
    var expression = Object.freeze({
        id: 1,
        kind: 'expression',
        expressionKind: 'binary',
        leafRange: range,
        span: span,
        children: empty,
        operatorLeafIds: operatorLeafIds,
        operatorOccurrences: occurrences,
        syntaxMarkers: empty,
        capabilityId: null,
        formatRole: 'intrinsic-primitive'
    });
    var root = Object.freeze({
        id: 0,
        kind: 'program',
        leafRange: range,
        span: span,
        children: Object.freeze([expression]),
        syntaxMarkers: empty,
        capabilityId: null,
        formatRole: 'intrinsic-container'
    });
    return Object.freeze({
        operatorCount: operatorCount,
        operatorLeafIds: operatorLeafIds,
        input: Object.freeze({
            root: root,
            leaves: lexed.leaves,
            tokenTable: table,
            dialect: 'hive',
            diagnostics: empty,
            hasCommentTrivia: false
        })
    });
}

function median(values) {
    var sorted = values.slice().sort(function(left, right) {
        return left - right;
    });
    return sorted[Math.floor(sorted.length / 2)];
}

function measureOperatorScale(fixture) {
    var warm = analysis.buildStructuralIndex(fixture.input);
    assert.strictEqual(warm.operatorOccurrencesOf(1).length, fixture.operatorCount);
    assert.strictEqual(
        warm.operatorOccurrenceForLeaf(
            fixture.operatorLeafIds[fixture.operatorLeafIds.length - 1]
        ).ownerNodeId,
        1
    );

    var samples = [];
    for (var sample = 0; sample < 3; sample++) {
        var started = process.hrtime.bigint();
        var index = analysis.buildStructuralIndex(fixture.input);
        var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        assert.strictEqual(index.operatorOccurrencesOf(1).length, fixture.operatorCount);
        samples.push(elapsedMs);
    }
    return Object.freeze({
        operatorCount: fixture.operatorCount,
        medianMs: median(samples),
        samplesMs: Object.freeze(samples)
    });
}

(function testDirectBuilderOperatorClosureScalesLinearly() {
    var counts = [8000, 16000, 32000];
    var timings = counts.map(function(count) {
        return measureOperatorScale(buildOperatorScaleFixture(count));
    });
    var first = timings[0].medianMs;
    var last = timings[2].medianMs;
    var fourXGrowth = last / Math.max(first, 0.1);

    assert.ok(
        fourXGrowth <= 7,
        '4x operators must remain near-linear; growth=' + fourXGrowth.toFixed(2) +
            ' timings=' + JSON.stringify(timings)
    );
    assert.ok(
        last <= 1000,
        '32k exact operator coverage exceeded disaster gate: ' + JSON.stringify(timings)
    );
    console.log('operator exact-coverage scale ' + JSON.stringify(timings));
}());

(function testLinearScaleSmoke() {
    var statements = [];
    for (var i = 0; i < 1000; i++) {
        statements.push('SELECT a, b FROM t WHERE a = ' + i);
    }
    var source = statements.join(';\n');
    var parsed = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    var table = tokenTable.buildStructuralTokenTable(parsed.leaves, source);
    var started = process.hrtime.bigint();
    var index = analysis.buildStructuralIndex({
        root: parsed.root,
        leaves: parsed.leaves,
        tokenTable: table,
        dialect: 'hive',
        diagnostics: parsed.diagnostics
    });
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(index.statements().length, 1000);
    assert.ok(elapsedMs < 1500, '1000-statement index build took ' + elapsedMs.toFixed(2) + 'ms');
}());

console.log('v2 Wave 2E analysis index tests passed');
