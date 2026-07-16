'use strict';

var assert = require('assert');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parser = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js'));
var parserContext = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser-context.js'));
var dialects = require(path.join(root, '.tmp', 'v2-core', 'core', 'dialects', 'index.js'));
var invariants = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js'));
var tokenTable = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js'));

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

function parse(source, mode, dialect) {
    var dialectId = dialect || 'hive';
    var result = parser.parseSql(source, {
        dialect: dialectId,
        mode: mode || 'document'
    });
    assert.strictEqual(result.leaves.map(function(leaf) {
        return leaf.raw;
    }).join(''), source, 'parse must conserve source');
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source,
        dialect: dialectId,
        tokenTable: tokenTable.buildStructuralTokenTable(result.leaves, source)
    });
    assert.strictEqual(
        checked.ok,
        true,
        'parse output invariants: ' + JSON.stringify(checked.failures, null, 2)
    );
    return {
        result: result,
        nodes: flatten(result.root)
    };
}

function slice(source, node) {
    return source.slice(node.span.start, node.span.end);
}

function opaqueNodes(parsed) {
    return parsed.nodes.filter(function(node) {
        return node.kind === 'opaque';
    });
}

function assertOpaqueDiagnostics(parsed, source) {
    opaqueNodes(parsed).forEach(function(node) {
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.code === node.reasonCode &&
                diagnostic.capabilityId === node.capabilityId &&
                diagnostic.span.start === node.span.start &&
                diagnostic.span.end === node.span.end;
        }), 'opaque node requires matching diagnostic: ' + slice(source, node));
        assert.strictEqual(
            parsed.result.leaves.slice(node.leafRange.start, node.leafRange.end).map(function(leaf) {
                return leaf.raw;
            }).join(''),
            slice(source, node),
            'opaque range must reconstruct exactly from leaves'
        );
    });
}

(function testExpressionRecoveryDoesNotInventImplicitAlias() {
    var source = 'SELECT a @ b, c + 1 FROM t';
    var parsed = parse(source);
    assert.deepStrictEqual(opaqueNodes(parsed).map(function(node) {
        return [node.boundary, slice(source, node)];
    }), [['expression', 'a @ b']]);
    assert.ok(parsed.nodes.some(function(node) {
        return node.kind === 'expression' &&
            node.expressionKind === 'binary' &&
            slice(source, node) === 'c + 1';
    }), 'later list item must remain structured');
    assertOpaqueDiagnostics(parsed, source);
}());

(function testReliableStatementsRecoverIndependently() {
    var source = 'SELECT 1; SELECT a,,b; SELECT 3; SELECT x FROM t WHERE; SELECT 4';
    var parsed = parse(source);
    assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query', 'query', 'query', 'opaque', 'query']);
    assert.deepStrictEqual(opaqueNodes(parsed).map(function(node) {
        return [node.boundary, slice(source, node)];
    }), [
        ['clause', 'a,,b'],
        ['statement', ' SELECT x FROM t WHERE;']
    ]);
    assert.ok(parsed.result.diagnostics.every(function(diagnostic) {
        return diagnostic.recovery !== 'preserve-target';
    }), 'reliable semicolon recovery must not escalate the whole target');
    assertOpaqueDiagnostics(parsed, source);
}());

(function testUnreliableOrLexicallyFatalInputPreservesOneTarget() {
    [
        'SELECT (a; SELECT 2',
        "SELECT 'unterminated; SELECT 2"
    ].forEach(function(source) {
        var parsed = parse(source);
        assert.strictEqual(parsed.result.root.children.length, 1);
        assert.deepStrictEqual(opaqueNodes(parsed).map(function(node) {
            return [node.boundary, slice(source, node)];
        }), [['target', source]]);
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-target';
        }));
        assert.ok(parsed.result.diagnostics.every(function(diagnostic) {
            return diagnostic.capabilityId === null;
        }), 'lexical/malformed target recovery must not invent capability identity');
        assert.ok(opaqueNodes(parsed).every(function(node) {
            return node.capabilityId === null;
        }), 'lexical/malformed target opaque must not invent capability identity');
        assertOpaqueDiagnostics(parsed, source);
    });
}());

(function testDiagnosticsAreStableSortedAndDeduplicated() {
    var source = 'SELECT a @ b, c @ d FROM t; SELECT x @ y';
    var first = parse(source).result.diagnostics;
    var second = parse(source).result.diagnostics;
    assert.deepStrictEqual(first, second, 'diagnostics must be deterministic');
    function compare(left, right) {
        var severity = { error: 0, warning: 1, info: 2 };
        return left.span.start - right.span.start ||
            left.span.end - right.span.end ||
            severity[left.severity] - severity[right.severity] ||
            left.code.localeCompare(right.code) ||
            left.message.localeCompare(right.message) ||
            left.recovery.localeCompare(right.recovery) ||
            String(left.capabilityId).localeCompare(String(right.capabilityId));
    }
    for (var i = 1; i < first.length; i++) {
        assert.ok(compare(first[i - 1], first[i]) <= 0, 'diagnostics complete total order');
    }
    var keys = first.map(function(diagnostic) {
        return JSON.stringify(diagnostic);
    });
    assert.strictEqual(new Set(keys).size, keys.length, 'diagnostics must be deduplicated');

    var duplicate = {
        code: 'SYN_UNEXPECTED_TOKEN',
        severity: 'warning',
        message: 'same',
        capabilityId: null,
        span: { start: 2, end: 3 },
        recovery: 'verbatim-node'
    };
    var nearDuplicate = Object.assign({}, duplicate, { message: 'same but distinct' });
    var capabilityDistinct = Object.assign({}, duplicate, { capabilityId: 'qualify' });
    assert.deepStrictEqual(
        parserContext.finalizeDiagnostics([
            duplicate,
            nearDuplicate,
            capabilityDistinct,
            duplicate
        ]),
        [duplicate, capabilityDistinct, nearDuplicate],
        'only exact duplicate diagnostic keys may collapse'
    );
}());

(function testKeywordShapedNamesAndFunctionsRemainStructured() {
    var source = [
        'SELECT match_recognize(a), qualify AS q, pivot AS p, merge AS m',
        'FROM t AS pivot WHERE qualify = 1'
    ].join(' ');
    var parsed = parse(source);
    assert.deepStrictEqual(opaqueNodes(parsed), []);
    assert.deepStrictEqual(parsed.result.diagnostics, []);
}());

(function testRealUnsupportedConstructsUseContextAndCapability() {
    assert.strictEqual(
        dialects.getDialect('hive').getCapability('qualify').state,
        'diagnostic',
        'QUALIFY capability must describe its current recovery boundary'
    );
    [
        [
            'SELECT * FROM t MATCH_RECOGNIZE (PATTERN (A) DEFINE A AS k > 0)',
            'MATCH_RECOGNIZE',
            'match-recognize'
        ],
        ['SELECT * FROM t PIVOT (sum(x) FOR k IN (1))', 'PIVOT', 'pivot'],
        ['SELECT * FROM t UNPIVOT (v FOR k IN (a, b))', 'UNPIVOT', 'unpivot'],
        ['SELECT * FROM t UNPIVOT INCLUDE NULLS (v FOR k IN (a, b))', 'UNPIVOT', 'unpivot'],
        ['SELECT * FROM t UNPIVOT EXCLUDE NULLS (v FOR k IN (a, b))', 'UNPIVOT', 'unpivot'],
        ['SELECT a FROM t QUALIFY row_number() OVER() = 1', 'QUALIFY', 'qualify'],
        [
            'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1',
            'MERGE',
            'merge'
        ]
    ].forEach(function(entry) {
        var source = entry[0];
        var parsed = parse(source);
        assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['opaque'], entry[1] + ' statement recovery');
        assert.deepStrictEqual(opaqueNodes(parsed).map(function(node) {
            return node.boundary;
        }), ['statement']);
        assert.deepStrictEqual(opaqueNodes(parsed).map(function(node) {
            return node.capabilityId;
        }), [entry[2]], entry[1] + ' opaque capability identity');
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' &&
                diagnostic.capabilityId === entry[2];
        }), entry[1] + ' structured capability diagnostic');
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' &&
                diagnostic.message.toUpperCase().indexOf(entry[1]) >= 0;
        }), entry[1] + ' context diagnostic');
        assertOpaqueDiagnostics(parsed, source);
    });
}());

(function testRelationAliasColumnListsDoNotBecomeUnsupportedConstructs() {
    ['generic', 'postgresql'].forEach(function(dialect) {
        var sources = [
            'ordinary_alias(c1, c2)',
            'match_recognize(c1, c2)',
            'match_recognize(pattern)',
            'pivot(c1, c2)',
            'unpivot(c1, c2)',
            'qualify(c1, c2)'
        ].map(function(alias) {
            return 'SELECT * FROM base ' + alias;
        }).concat([
            'SELECT * FROM base AS qualify(c1, c2)',
            'SELECT * FROM schema.base qualify(c1)',
            'SELECT * FROM fn(x) qualify(c1)',
            'SELECT * FROM (SELECT 1) qualify(c1)',
            'SELECT * FROM a CROSS JOIN b qualify(c1)',
            'SELECT * FROM a JOIN b qualify(c1) ON a.id = b.id',
            'SELECT * FROM join(x) qualify(c1)',
            'SELECT * FROM a CROSS JOIN join(x) qualify(c1)',
            'SELECT * FROM base qualify(c1), other',
            'SELECT * FROM base qualify(c1) CROSS JOIN other'
        ]);
        sources.forEach(function(source) {
            var parsed = parse(source, undefined, dialect);
            assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
                return statement.statementKind;
            }), ['query'], dialect + ' ' + source);
            assert.strictEqual(parsed.result.diagnostics.some(function(diagnostic) {
                return diagnostic.recovery === 'preserve-statement' ||
                    diagnostic.recovery === 'preserve-target';
            }), false, dialect + ' alias column list must not widen recovery: ' + source);
        });
    });

    var manyAliases = 'SELECT * FROM t0 qualify(c0)';
    for (var index = 1; index < 24; index++) {
        manyAliases += ' CROSS JOIN t' + index + ' qualify(c' + index + ')';
    }
    var manyParsed = parse(manyAliases, undefined, 'postgresql');
    assert.deepStrictEqual(manyParsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query']);
    assert.strictEqual(manyParsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' ||
            /proof budget/i.test(diagnostic.message);
    }), false, 'legal alias column lists must not consume the QUALIFY proof budget');
}());

(function testQualifyAfterAnExistingRelationAliasRemainsARealClause() {
    [
        'SELECT * FROM t q QUALIFY (flag)',
        'SELECT * FROM t AS q QUALIFY (flag)',
        'SELECT * FROM (SELECT 1 AS flag) q QUALIFY (flag)',
        'SELECT * FROM fn(x) q QUALIFY (flag)',
        'SELECT * FROM a JOIN b q ON a.id = b.id QUALIFY (flag)',
        'SELECT * FROM t alias_name(c) QUALIFY (flag)',
        'SELECT * FROM (SELECT 1 AS c) q(c) QUALIFY (flag)',
        'SELECT * FROM fn(x) q(c) QUALIFY (flag)',
        'SELECT * FROM a CROSS JOIN t q(c) QUALIFY (flag)',
        'SELECT * FROM a, t q(c) QUALIFY (flag)',
        'SELECT * FROM a JOIN b USING (id) QUALIFY (flag)',
        'SELECT * FROM t JOIN u ON true, v q QUALIFY (flag)'
    ].forEach(function(source) {
        ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialect) {
            var parsed = parse(source, undefined, dialect);
            assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
                return statement.statementKind;
            }), ['opaque'], dialect + ' existing relation alias: ' + source);
            assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
                return diagnostic.recovery === 'preserve-statement' &&
                    diagnostic.capabilityId === 'qualify';
            }), dialect + ' must retain the QUALIFY capability diagnostic: ' + source);
            assertOpaqueDiagnostics(parsed, source);
        });
    });
}());

(function testMalformedRelationPrefixDoesNotProveAQualifyClause() {
    [
        'SELECT * FROM t q(c,) QUALIFY (flag)',
        'SELECT * FROM t q alias_name(c) QUALIFY (flag)'
    ].forEach(function(source) {
        var parsed = parse(source, undefined, 'postgresql');
        assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['query'], source);
        assert.strictEqual(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' &&
                diagnostic.capabilityId === 'qualify';
        }), false, 'unproven malformed relation prefix must avoid a false QUALIFY claim');
    });
}());

(function testJoinUsingIsStructuredBeforeAnyLaterUnsupportedClause() {
    var source = 'SELECT * FROM a JOIN b USING (id, tenant_id)';
    ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialect) {
        var parsed = parse(source, undefined, dialect);
        assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['query'], dialect + ' JOIN USING statement');
        assert.deepStrictEqual(opaqueNodes(parsed), [], dialect + ' JOIN USING opaque nodes');
        assert.ok(parsed.nodes.some(function(node) {
            return node.kind === 'clause' && node.clauseKind === 'join-using';
        }), dialect + ' JOIN USING clause');
    });
}());

(function testExistingAliasDoesNotHideContinuationShapedQualifyBodies() {
    [
        'SELECT * FROM t q QUALIFY join(flag)',
        'SELECT * FROM t q QUALIFY on',
        'SELECT * FROM t q QUALIFY using'
    ].forEach(function(source) {
        ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialect) {
            var parsed = parse(source, undefined, dialect);
            assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
                return statement.statementKind;
            }), ['opaque'], dialect + ' continuation-shaped QUALIFY body: ' + source);
            assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
                return diagnostic.recovery === 'preserve-statement' &&
                    diagnostic.capabilityId === 'qualify';
            }), dialect + ' must retain QUALIFY identity: ' + source);
            assertOpaqueDiagnostics(parsed, source);
        });
    });
}());

(function testJoinShapedFunctionIsAQualifyBodyWithoutAnExistingAlias() {
    [
        'SELECT * FROM t QUALIFY join(flag)',
        'SELECT * FROM t QUALIFY join((SELECT 1)) = 1',
        'SELECT * FROM t QUALIFY join ((SELECT 1)) OVER () = 1',
        'SELECT * FROM t QUALIFY join ((SELECT 1)).x = 1',
        'SELECT * FROM t QUALIFY join ((SELECT 1)) IS NULL',
        'SELECT * FROM t QUALIFY on',
        'SELECT * FROM t QUALIFY using',
        'SELECT * FROM on QUALIFY flag'
    ].forEach(function(source) {
        ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialect) {
            var parsed = parse(source, undefined, dialect);
            assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
                return statement.statementKind;
            }), ['opaque'], dialect + ' continuation-shaped QUALIFY body: ' + source);
            assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
                return diagnostic.recovery === 'preserve-statement' &&
                    diagnostic.capabilityId === 'qualify';
            }), dialect + ' must retain QUALIFY identity: ' + source);
            assertOpaqueDiagnostics(parsed, source);
        });
    });

    var subscript = 'SELECT * FROM t QUALIFY join ((SELECT 1))[1] = 1';
    ['hive', 'generic', 'postgresql'].forEach(function(dialect) {
        var parsed = parse(subscript, undefined, dialect);
        assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['opaque'], dialect + ' subscript QUALIFY body');
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' &&
                diagnostic.capabilityId === 'qualify';
        }), dialect + ' subscript QUALIFY identity');
    });
    var mysqlSubscript = parse(subscript, undefined, 'mysql');
    assert.deepStrictEqual(mysqlSubscript.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query']);
    assert.strictEqual(mysqlSubscript.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' &&
            diagnostic.capabilityId === 'qualify';
    }), false, 'MySQL must not claim QUALIFY when its suffix expression is unproven');

    var quotedTable = 'SELECT * FROM "on" QUALIFY flag';
    var quotedParsed = parse(quotedTable, undefined, 'postgresql');
    assert.deepStrictEqual(quotedParsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['opaque']);
    assert.ok(quotedParsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' &&
            diagnostic.capabilityId === 'qualify';
    }), 'quoted keyword-shaped table must not hide QUALIFY');
    assertOpaqueDiagnostics(quotedParsed, quotedTable);
}());

(function testOpenRelationAliasSlotsStillAcceptContinuationForms() {
    [
        'SELECT * FROM t qualify JOIN u ON t.id = u.id',
        'SELECT * FROM a JOIN t qualify ON a.id = t.id',
        'SELECT * FROM a JOIN t qualify USING (id)'
    ].forEach(function(source) {
        var parsed = parse(source, undefined, 'postgresql');
        assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['query'], source);
        assert.strictEqual(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' ||
                diagnostic.recovery === 'preserve-target';
        }), false, 'open alias slot must avoid a false QUALIFY diagnostic: ' + source);
    });

    var lateral = 'SELECT * FROM t qualify LATERAL VIEW explode(xs) e AS x';
    var lateralParsed = parse(lateral, undefined, 'hive');
    assert.deepStrictEqual(lateralParsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query']);
    assert.strictEqual(lateralParsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' ||
            diagnostic.recovery === 'preserve-target';
    }), false, 'open alias slot before LATERAL VIEW must remain local');
}());

(function testLateralViewOutputCommasDoNotOpenARelationAliasSlot() {
    var source = [
        'SELECT * FROM t',
        'LATERAL VIEW explode(xs) e AS c1, c2',
        'QUALIFY (flag)'
    ].join(' ');
    var parsed = parse(source, undefined, 'hive');
    assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['opaque']);
    assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' &&
            diagnostic.capabilityId === 'qualify';
    }), 'LATERAL VIEW output commas must not hide a real QUALIFY clause');
    assertOpaqueDiagnostics(parsed, source);
}());

(function testWithPrefixedMergeKeepsItsCapabilityDiagnostic() {
    var source = [
        'WITH s AS (SELECT 1 AS id)',
        'MERGE INTO t USING s ON t.id = s.id',
        'WHEN MATCHED THEN UPDATE SET x = 1'
    ].join(' ');
    ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialect) {
        var parsed = parse(source, undefined, dialect);
        assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['opaque']);
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.code === 'SYN_UNSUPPORTED_STATEMENT' &&
                diagnostic.recovery === 'preserve-statement' &&
                diagnostic.capabilityId === 'merge';
        }), dialect + ' WITH MERGE capability diagnostic');
    });
}());

(function testClauseBodiesBeginningWithDelimiterOrUnaryOperatorStayStructured() {
    [
        'SELECT * FROM (SELECT * FROM t) x',
        'SELECT * FROM t WHERE (x = 1)',
        'SELECT x FROM t GROUP BY x HAVING (count(*) > 1)',
        'SELECT * FROM t LIMIT (1)',
        'SELECT * FROM t WHERE !flag',
        'SELECT where(x) FROM t',
        'SELECT x, where FROM t'
    ].forEach(function(source) {
        var parsed = parse(source);
        assert.deepStrictEqual(opaqueNodes(parsed), [], source);
        assert.deepStrictEqual(parsed.result.diagnostics, [], source);
    });

    var nestedUnsupported = parse(
        'SELECT * FROM (SELECT a FROM t QUALIFY row_number() OVER() = 1) x'
    );
    assert.deepStrictEqual(nestedUnsupported.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['opaque']);
    assert.ok(nestedUnsupported.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' &&
            diagnostic.capabilityId === 'qualify';
    }));
}());

(function testNestedNamesDoNotBecomeUnsupportedConstructs() {
    var source = [
        'SELECT (SELECT match_recognize(pivot) FROM inner_t) AS x',
        'FROM outer_t WHERE merge = qualify'
    ].join(' ');
    var parsed = parse(source);
    assert.deepStrictEqual(opaqueNodes(parsed), []);
    assert.deepStrictEqual(parsed.result.diagnostics, []);
}());

(function testQualifyIdentifiersRemainExpressionsOrAliases() {
    [
        'SELECT * FROM t WHERE x BETWEEN qualify AND 2',
        'SELECT CASE qualify WHEN 1 THEN 1 ELSE 0 END FROM t',
        'SELECT * FROM t qualify ORDER BY 1'
    ].forEach(function(source) {
        var parsed = parse(source);
        assert.deepStrictEqual(opaqueNodes(parsed), [], source);
        assert.deepStrictEqual(parsed.result.diagnostics, [], source);
    });
}());

(function testDenseQualifyIdentifiersRemainLinearAndUnambiguous() {
    var count = 1600;
    var source = 'SELECT * FROM t WHERE ' + new Array(count + 1).join('qualify + ') + '0';
    var started = process.hrtime.bigint();
    var parsed = parse(source);
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepStrictEqual(opaqueNodes(parsed), []);
    assert.deepStrictEqual(parsed.result.diagnostics, []);
    assert.ok(elapsedMs < 1500,
        'keyword-shaped identifier recognition must stay bounded, elapsed=' + elapsedMs + 'ms');
}());

(function testAmbiguousMalformedQualifyCandidatesHaveABoundedProofBudget() {
    var count = 1200;
    var source = 'SELECT * FROM t WHERE ' +
        new Array(count + 1).join('x qualify y, ') + 'z';
    var started = process.hrtime.bigint();
    var parsed = parse(source);
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(parsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_INTERNAL_INVARIANT';
    }), false);
    assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['opaque']);
    assert.ok(opaqueNodes(parsed).some(function(node) {
        return node.boundary === 'statement';
    }), 'exhausted proof budget must fail closed at the statement boundary');
    assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' &&
            /proof budget/i.test(diagnostic.message);
    }));
    assert.ok(elapsedMs < 1500,
        'ambiguous unsupported proofs must be capped, elapsed=' + elapsedMs + 'ms');
}());

(function testLegalRelationAliasesDoNotConsumeTheQualifyProofBudget() {
    var source = 'SELECT * FROM t0 qualify ';
    for (var index = 1; index < 16; index++) {
        source += 'CROSS JOIN t' + index + ' qualify ';
    }
    source += 'CROSS JOIN tail q QUALIFY row_number() OVER() = 1';
    var parsed = parse(source);
    assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['opaque']);
    assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' &&
            diagnostic.capabilityId === 'qualify';
    }), 'real QUALIFY must remain visible after sixteen legal relation aliases');

    var onIdentifiers = 'SELECT * FROM base';
    for (var joinIndex = 0; joinIndex < 24; joinIndex++) {
        onIdentifiers += ' JOIN t' + joinIndex + ' qualify ON qualify';
    }
    var onParsed = parse(onIdentifiers);
    assert.deepStrictEqual(onParsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query']);
    assert.strictEqual(onParsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' ||
            /proof budget/i.test(diagnostic.message);
    }), false, 'ON identifiers and relation aliases must not consume proof budget');

    var compactJoins = 'SELECT * FROM t0 qualify JOIN(SELECT 0) d0 ON true';
    for (var compactIndex = 1; compactIndex < 20; compactIndex++) {
        compactJoins += ', t' + compactIndex + ' qualify JOIN(SELECT ' +
            compactIndex + ') d' + compactIndex + ' ON true';
    }
    var compactParsed = parse(compactJoins);
    assert.deepStrictEqual(compactParsed.result.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query']);
    assert.strictEqual(compactParsed.result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'preserve-statement' ||
            /proof budget/i.test(diagnostic.message);
    }), false, 'compact JOIN(subquery) continuations must not consume proof budget');
}());

(function testHiveDdlUsesRegistryVerbatimStateAtAProvenStatementBoundary() {
    [
        'CREATE TABLE `t;` (`a,b` STRING COMMENT "x")',
        'TRUNCATE TABLE db.t'
    ].forEach(function(ddl) {
        var source = 'SELECT 1; ' + ddl + '; SELECT 2';
        var parsed = parse(source);
        assert.deepStrictEqual(parsed.result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['query', 'opaque', 'query']);
        assert.deepStrictEqual(opaqueNodes(parsed).map(function(node) {
            return [node.boundary, slice(source, node)];
        }), [['statement', ' ' + ddl + ';']]);
        assert.deepStrictEqual(opaqueNodes(parsed).map(function(node) {
            return node.capabilityId;
        }), ['hive-ddl']);
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'verbatim-node' &&
                diagnostic.capabilityId === 'hive-ddl';
        }), 'registry verbatim structured identity must own ' + ddl);
        assert.ok(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'verbatim-node' &&
                diagnostic.message.indexOf('hive-ddl') >= 0;
        }), 'registry verbatim UX message must mention hive-ddl for ' + ddl);
        assert.strictEqual(parsed.result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' ||
                diagnostic.recovery === 'preserve-target';
        }), false);
    });
}());

console.log('v2 Wave 2D recovery and opaque tests passed');
