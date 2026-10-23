'use strict';

var assert = require('assert');
var parser = require('../../.tmp/v2-core/core/syntax/parser.js');
var analysis = require('../../.tmp/v2-core/core/analysis/structural-index.js');
var analyzer = require('../../.tmp/v2-core/core/analysis/analyze.js');
var dialectRegistry = require('../../.tmp/v2-core/core/dialects/registry.js');

function build(source, dialect) {
    var artifact = parser.parseSqlArtifact(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    var result = artifact.output;
    var table = artifact.tokenTable;
    var index = analysis.buildStructuralIndex(artifact);
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

// A parse artifact whose output fields are replaced, to exercise the index's semantic checks.
function forged(built, output) {
    return Object.freeze(Object.assign({}, built.artifact, {
        output: Object.freeze(Object.assign({}, built.result, output))
    }));
}

function directBuild(built, root) {
    return analysis.buildStructuralIndex(forged(built, { root: root }));
}

(function testAnalyzeSqlConsumesRetainedParseArtifact() {
    var source = 'SELECT a, b FROM t WHERE a > 0';
    var output = analyzer.analyzeSql(source, { dialect: 'hive', mode: 'document' });
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

(function testDialectPrimitiveCapabilityReachesIndex() {
    var mysqlArtifact = parser.parseSqlArtifact('SELECT @name', {
        dialect: 'mysql',
        mode: 'document'
    });
    var mysqlIndex = analysis.buildStructuralIndex(mysqlArtifact);
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
        if (node.kind !== 'program') {
            assert.ok(node.kind === 'statement' || index.nearestAncestor(node.id, 'statement'));
        }
    });

    var queries = nodesOfKind(index, 'query');
    assert.ok(queries.length >= 3, 'outer, CTE, and second-statement queries');
    nodesOfKind(index, 'clause').forEach(function(clause) {
        var owner = index.queryOfClause(clause.id);
        assert.ok(owner && owner.kind === 'query');
        assert.strictEqual(index.nearestAncestor(clause.id, 'query'), owner);
    });

    var caseBranch = nodesOfKind(index, 'case-branch')[0];
    assert.ok(caseBranch, 'CASE branch must be indexed');
    assert.ok(index.nearestAncestor(caseBranch.id, 'expression'));
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
            assert.strictEqual(index.parentOf(member.id), list);
        });
        list.separatorLeafIds.forEach(function(separatorLeafId, ordinal) {
            assert.strictEqual(built.result.leaves[separatorLeafId].raw, ',');
            assert.ok(members[ordinal].leafRange.end <= separatorLeafId);
            assert.ok(separatorLeafId < members[ordinal + 1].leafRange.start);
            assert.strictEqual(index.leafContext(separatorLeafId).syntax.directOwnerNodeId, list.id);
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
}());

(function testInvalidIdsImmutabilityDeterminismAndFailClosedBuild() {
    var source = 'SELECT a, b FROM t; SELECT c FROM u';
    var first = build(source);
    var second = build(source);
    function projection(index) {
        return index.nodes().map(function(node) {
            var parent = index.parentOf(node.id);
            return [node.id, node.kind, parent === null ? null : parent.id];
        });
    }
    assert.deepStrictEqual(projection(first.index), projection(second.index));

    assert.throws(function() { first.index.nodeById(-1); }, /node id/i);
    assert.throws(function() { first.index.nodeById(999999); }, /node id/i);
    assert.throws(function() { first.index.parentOf(1.5); }, /node id/i);
    assert.throws(function() { first.index.childrenOf(999999); }, /node id/i);
    assert.throws(function() { first.index.depthBefore(-1); }, /leaf id/i);
    assert.throws(function() { first.index.commentBinding(999999); }, /leaf id/i);

    assert.throws(function() {
        first.index.nodes().push(first.result.root);
    }, TypeError);

    var sharedStatementRoot = Object.freeze(Object.assign({}, first.result.root, {
        children: Object.freeze([
            first.result.root.children[0],
            first.result.root.children[0]
        ])
    }));
    assert.throws(function() {
        analysis.buildStructuralIndex(forged(first, { root: sharedStatementRoot }));
    }, /shared|duplicate|node id/i, 'builder must fail closed on invalid topology');

    var oversizedNodeIdRoot = replaceNode(
        first.result.root,
        first.result.root.children[0].id,
        function(statement) {
            return Object.assign({}, statement, { id: 1000000000 });
        }
    );
    assert.throws(function() {
        analysis.buildStructuralIndex(forged(first, { root: oversizedNodeIdRoot }));
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
        analysis.buildStructuralIndex(forged(separatorBuilt, { root: duplicateSeparatorRoot }));
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
        analysis.buildStructuralIndex(forged(opaqueBuilt, { root: missingCapabilityRoot }));
    }, /missing required capabilityId/i);

    var nonPreservationCapabilityRoot = replaceNode(
        opaqueBuilt.result.root,
        opaque.id,
        function(node) {
            return Object.assign({}, node, { capabilityId: 'from' });
        }
    );
    assert.throws(function() {
        analysis.buildStructuralIndex(forged(opaqueBuilt, { root: nonPreservationCapabilityRoot }));
    }, /non-preservation state formatted/i);

    var mismatchedDiagnostics = opaqueBuilt.result.diagnostics.map(function(diagnostic) {
        return Object.freeze(Object.assign({}, diagnostic, {
            code: 'SYN_UNMODELED_CONSTRUCT'
        }));
    });
    assert.throws(function() {
        analysis.buildStructuralIndex(forged(opaqueBuilt, { diagnostics: Object.freeze(mismatchedDiagnostics) }));
    }, /lacks an exact matching diagnostic/i);

    var missingDiagnosticCapability = opaqueBuilt.result.diagnostics.map(function(diagnostic) {
        var copy = Object.assign({}, diagnostic);
        delete copy.capabilityId;
        return Object.freeze(copy);
    });
    assert.throws(function() {
        analysis.buildStructuralIndex(forged(opaqueBuilt, { diagnostics: Object.freeze(missingDiagnosticCapability) }));
    }, /diagnostic 0 is missing required capabilityId/i);

    var genericOpaqueBuilt = build('SELECT a @ b');
    assert.strictEqual(
        nodesOfKind(genericOpaqueBuilt.index, 'opaque')[0].capabilityId,
        null
    );
    assert.throws(function() {
        analysis.buildStructuralIndex(forged(genericOpaqueBuilt, { diagnostics: Object.freeze([]) }));
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
            positive.leafContext(leafId).syntax.directOwnerNodeId,
            expression.id,
            'every word of a multi-word operator must resolve to its expression'
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

console.log('v2 Wave 2E analysis index tests passed');
