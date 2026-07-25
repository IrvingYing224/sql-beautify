'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parserPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js');
var invariantsPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'invariants.js'
);
var nodeFactoryPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'node-factory.js'
);
var dialectRegistryPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'dialects',
    'registry.js'
);
var contextualInvariantsPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'cst-contextual-invariants.js'
);
var dialectContextPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'cst-dialect-context.js'
);
var contextualInvariantContextPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'cst-contextual-invariant-context.js'
);
var contextualFactInvariantsPath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'cst-contextual-fact-invariants.js'
);

assert.ok(fs.existsSync(parserPath), 'build:v2-core required');
assert.ok(fs.existsSync(invariantsPath), 'invariants module must exist');
assert.ok(fs.existsSync(nodeFactoryPath), 'node factory module must exist');
assert.ok(fs.existsSync(dialectRegistryPath), 'dialect registry module must exist');

var parser = require(parserPath);
var invariants = require(invariantsPath);
var nodeFactory = require(nodeFactoryPath);
var dialectRegistry = require(dialectRegistryPath);
var contextualInvariants = require(contextualInvariantsPath);
var dialectContextApi = require(dialectContextPath);
var contextualInvariantContextApi = require(contextualInvariantContextPath);
var contextualFactInvariants = require(contextualFactInvariantsPath);

function parse(source, dialect) {
    return parser.parseSqlArtifact(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
}

function validate(artifact, replacementRoot) {
    return invariants.validateSyntaxInvariants({
        root: replacementRoot || artifact.output.root,
        leaves: artifact.output.leaves,
        source: artifact.source,
        dialect: artifact.dialect,
        tokenTable: artifact.tokenTable
    });
}

function nodes(rootNode) {
    var result = [];
    var stack = [rootNode];
    while (stack.length > 0) {
        var node = stack.pop();
        result.push(node);
        if (Array.isArray(node.children)) {
            for (var index = node.children.length - 1; index >= 0; index--) {
                stack.push(node.children[index]);
            }
        }
    }
    return result;
}

function find(rootNode, predicate) {
    var found = nodes(rootNode).find(predicate);
    assert.ok(found, 'target node must exist');
    return found;
}

function replaceNode(node, nodeId, mutate) {
    if (node.id === nodeId) {
        var changed = Object.assign({}, node);
        mutate(changed, node);
        return changed;
    }
    if (!Array.isArray(node.children)) {
        return node;
    }
    var changedChild = false;
    var children = node.children.map(function(child) {
        var replacement = replaceNode(child, nodeId, mutate);
        changedChild = changedChild || replacement !== child;
        return replacement;
    });
    return changedChild
        ? Object.assign({}, node, { children: Object.freeze(children) })
        : node;
}

function frozenMarker(marker, overrides) {
    return Object.freeze(Object.assign({}, marker, overrides));
}

function assertRejected(label, artifact, replacementRoot, messagePattern) {
    var result = validate(artifact, replacementRoot);
    assert.strictEqual(result.ok, false, label + ' must fail closed');
    if (messagePattern) {
        assert.ok(
            result.failures.some(function(failure) {
                return messagePattern.test(failure.message) || messagePattern.test(failure.code);
            }),
            label + ': ' + JSON.stringify(result.failures)
        );
    }
}

(function contextualKindSnapshotPreservesTheBaselineReadSequence() {
    var events = [];
    var range = { start: 0, end: 0 };
    var raw = {
        id: 0,
        syntaxMarkers: Object.freeze([])
    };
    Object.defineProperty(raw, 'kind', {
        enumerable: true,
        get: function() {
            events.push('kind');
            return 'program';
        }
    });
    Object.defineProperty(raw, 'leafRange', {
        enumerable: true,
        get: function() {
            events.push('leafRange');
            return range;
        }
    });
    ['capabilityId', 'formatRole'].forEach(function(field) {
        Object.defineProperty(raw, field, {
            enumerable: true,
            get: function() {
                throw new Error(field + ' accessor must not execute');
            }
        });
    });
    contextualInvariants.validateContextualNodeFacts(
        raw,
        [],
        [],
        [],
        dialectContextApi.getCstDialectInvariantContext('hive'),
        false
    );
    assert.deepStrictEqual(
        events,
        ['kind', 'kind', 'leafRange', 'leafRange', 'kind'],
        'contextual split must retain guard, nodeKind snapshot, owner range, then marker reads'
    );
}());

(function emptyContextualFactsReuseOneFrozenIdentity() {
    function contextFor(artifact, node) {
        var context = contextualInvariantContextApi.createContextualInvariantContext(
            node,
            node.children,
            artifact.output.leaves,
            [],
            dialectContextApi.getCstDialectInvariantContext('hive'),
            true
        );
        assert.ok(context);
        return context;
    }
    var emptyArtifact = parse('SELECT 1');
    var emptyContext = contextFor(emptyArtifact, emptyArtifact.output.root);
    var first = contextualFactInvariants.validateContextualFactShape(emptyContext);
    var second = contextualFactInvariants.validateContextualFactShape(emptyContext);
    assert.strictEqual(first, second,
        'empty contextual facts must reuse one canonical identity');
    assert.strictEqual(Object.isFrozen(first), true,
        'empty contextual fact identity must be frozen');
    assert.deepStrictEqual(
        [first.nameClaims.length, first.separatorLeafIds.length,
            first.operatorLeafIds.length],
        [0, 0, 0]
    );

    var listArtifact = parse('SELECT a,b');
    var list = find(listArtifact.output.root, function(node) {
        return node.kind === 'list' && node.separatorLeafIds.length > 0;
    });
    var listFacts = contextualFactInvariants.validateContextualFactShape(
        contextFor(listArtifact, list)
    );
    assert.notStrictEqual(listFacts, first,
        'non-empty separator facts must not reuse the empty identity');
    assert.strictEqual(listFacts.separatorLeafIds.length, 1,
        'non-empty separator facts must remain complete');
}());

(function contextualScratchIsLocalAndReusedAcrossNodes() {
    var artifact = parse('SELECT a,b');
    var dialectContext = dialectContextApi.getCstDialectInvariantContext('hive');
    var failures = [];
    var scratch = contextualInvariantContextApi.createContextualInvariantScratch(
        artifact.output.leaves,
        failures,
        dialectContext
    );
    var rootContext = contextualInvariantContextApi.createContextualInvariantContext(
        artifact.output.root,
        artifact.output.root.children,
        artifact.output.leaves,
        failures,
        dialectContext,
        true,
        scratch
    );
    var statement = artifact.output.root.children[0];
    var statementContext = contextualInvariantContextApi.createContextualInvariantContext(
        statement,
        statement.children,
        artifact.output.leaves,
        failures,
        dialectContext,
        true,
        scratch
    );
    assert.strictEqual(rootContext, scratch,
        'first node must use the validation-local contextual scratch');
    assert.strictEqual(statementContext, scratch,
        'subsequent nodes must reuse the same contextual scratch');
    assert.strictEqual(statementContext.raw, statement,
        'contextual scratch must expose only the current node');
    assert.strictEqual(statementContext.nodeKind, 'statement');
    assert.deepStrictEqual(failures, []);
}());

(function canonicalFactsPass() {
    [
        parse('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a,b'),
        parse('SELECT CASE WHEN a BETWEEN 1 AND 2 THEN CAST(x AS ARRAY<INT>) END'),
        parse('SELECT sum(x) OVER (PARTITION BY k ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'),
        parse('SELECT a @> b, c::INT FROM schema.t', 'postgresql'),
        parse('SELECT CAST(x AS `Order`)'),
        parse('SELECT a AS b FROM t AS x;'),
        parse('WITH q AS (SELECT 1) SELECT 1 UNION SELECT 2'),
        parse('WITH q AS (SELECT 1) SELECT 1 UNION ALL SELECT 2'),
        parse('SELECT CAST(x AS STRUCT<a:INT,b:ARRAY<STRING>>)'),
        parse('SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id')
    ].forEach(function(artifact) {
        var result = validate(artifact);
        assert.strictEqual(result.ok, true, JSON.stringify(result.failures));
    });
}());

(function requiredMarkerClosureFailsClosed() {
    function rejectRemovedMarker(label, source, nodePredicate, markerPredicate) {
        var artifact = parse(source);
        var target = find(artifact.output.root, nodePredicate);
        var retained = target.syntaxMarkers.filter(function(marker) {
            return !markerPredicate(marker, artifact.output.leaves[marker.leafId]);
        });
        assert.ok(
            retained.length < target.syntaxMarkers.length,
            label + ' probe must remove at least one marker'
        );
        assertRejected(
            label,
            artifact,
            replaceNode(artifact.output.root, target.id, function(node) {
                node.syntaxMarkers = Object.freeze(retained);
            }),
            /must have exact|must contain|INV_ORDINAL/i
        );
    }

    rejectRemovedMarker(
        'SELECT clause head marker closure',
        'SELECT a FROM t',
        function(node) {
            return node.kind === 'clause' && node.clauseKind === 'select';
        },
        function(marker) {
            return marker.syntaxId === 'clause:select';
        }
    );
    rejectRemovedMarker(
        'FROM clause head marker closure',
        'SELECT a FROM t',
        function(node) {
            return node.kind === 'clause' && node.clauseKind === 'from';
        },
        function(marker) {
            return marker.syntaxId === 'clause:from';
        }
    );
    rejectRemovedMarker(
        'statement terminator marker closure',
        'SELECT 1;',
        function(node) {
            return node.kind === 'statement';
        },
        function(marker) {
            return marker.syntaxId === 'statement-terminator';
        }
    );
    rejectRemovedMarker(
        'list-item alias AS marker closure',
        'SELECT a AS b FROM t',
        function(node) {
            return node.kind === 'list-item' &&
                node.alias !== null && node.alias.keywordLeafId !== null;
        },
        function(marker) {
            return marker.syntaxId === 'alias-as';
        }
    );
    rejectRemovedMarker(
        'relation alias AS marker closure',
        'SELECT a FROM t AS x',
        function(node) {
            return node.kind === 'relation' &&
                node.alias !== null && node.alias.keywordLeafId !== null;
        },
        function(marker) {
            return marker.syntaxId === 'alias-as';
        }
    );
    rejectRemovedMarker(
        'CTE AS marker closure',
        'WITH q AS (SELECT 1) SELECT 1',
        function(node) {
            return node.kind === 'cte';
        },
        function(marker) {
            return marker.syntaxId === 'cte-as';
        }
    );
    rejectRemovedMarker(
        'JOIN head marker closure',
        'SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id',
        function(node) {
            return node.kind === 'relation' && node.relationKind === 'join';
        },
        function(marker, leaf) {
            return marker.syntaxId === 'join-head' && leaf.raw.toLowerCase() === 'outer';
        }
    );
    ['ALL', 'DISTINCT'].forEach(function(qualifier) {
        rejectRemovedMarker(
            'set operator ' + qualifier + ' marker closure',
            'SELECT 1 UNION ' + qualifier + ' SELECT 2',
            function(node) {
                return node.kind === 'clause' && node.clauseKind === 'set-operation';
            },
            function(marker, leaf) {
                return marker.syntaxId === 'set-operator' &&
                    leaf.raw.toUpperCase() === qualifier;
            }
        );
    });
    rejectRemovedMarker(
        'STRUCT member colon marker closure',
        'SELECT CAST(x AS STRUCT<a:INT>)',
        function(node) {
            return node.kind === 'list-item' && node.itemRole === 'type-member';
        },
        function(marker) {
            return marker.syntaxId === 'type:member-colon';
        }
    );
    rejectRemovedMarker(
        'code type name marker closure',
        'SELECT CAST(x AS ARRAY<INT>)',
        function(node) {
            return node.kind === 'type-expression' &&
                node.syntaxMarkers.some(function(marker) {
                    return marker.syntaxId === 'type:name';
                });
        },
        function(marker) {
            return marker.syntaxId === 'type:name';
        }
    );
    ['case:start', 'case:end'].forEach(function(syntaxId) {
        rejectRemovedMarker(
            syntaxId + ' marker closure',
            'SELECT CASE WHEN a THEN b ELSE c END',
            function(node) {
                return node.kind === 'expression' && node.expressionKind === 'case';
            },
            function(marker) {
                return marker.syntaxId === syntaxId;
            }
        );
    });
    ['case:when', 'case:then'].forEach(function(syntaxId) {
        rejectRemovedMarker(
            syntaxId + ' marker closure',
            'SELECT CASE WHEN a THEN b ELSE c END',
            function(node) {
                return node.kind === 'case-branch' && node.branchKind === 'when';
            },
            function(marker) {
                return marker.syntaxId === syntaxId;
            }
        );
    });
    rejectRemovedMarker(
        'case:else marker closure',
        'SELECT CASE WHEN a THEN b ELSE c END',
        function(node) {
            return node.kind === 'case-branch' && node.branchKind === 'else';
        },
        function(marker) {
            return marker.syntaxId === 'case:else';
        }
    );
    rejectRemovedMarker(
        'window OVER marker closure',
        'SELECT sum(x) OVER (PARTITION BY k ORDER BY ts ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)',
        function(node) {
            return node.kind === 'expression' && node.expressionKind === 'window';
        },
        function(marker) {
            return marker.syntaxId === 'window:over';
        }
    );
    ['window:partition-by', 'window:order-by'].forEach(function(syntaxId) {
        rejectRemovedMarker(
            syntaxId + ' marker closure',
            'SELECT sum(x) OVER (PARTITION BY k ORDER BY ts)',
            function(node) {
                return node.kind === 'window-spec';
            },
            function(marker) {
                return marker.syntaxId === syntaxId;
            }
        );
    });
    ['window:rows', 'window:between', 'window:and'].forEach(function(syntaxId) {
        rejectRemovedMarker(
            syntaxId + ' marker closure',
            'SELECT sum(x) OVER (ORDER BY ts ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)',
            function(node) {
                return node.kind === 'expression' &&
                    node.expressionKind === 'between' &&
                    node.operatorLeafIds.length === 0;
            },
            function(marker) {
                return marker.syntaxId === syntaxId;
            }
        );
    });
    rejectRemovedMarker(
        'window current-row marker closure',
        'SELECT sum(x) OVER (ORDER BY ts ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)',
        function(node) {
            return node.kind === 'expression' &&
                node.expressionKind === 'frame-bound' &&
                node.syntaxMarkers.some(function(marker) {
                    return marker.syntaxId === 'window:current-row';
                });
        },
        function(marker, leaf) {
            return marker.syntaxId === 'window:current-row' &&
                leaf.raw.toLowerCase() === 'row';
        }
    );
    rejectRemovedMarker(
        'parenthesized expression delimiter closure',
        'SELECT (a) FROM t',
        function(node) {
            return node.kind === 'expression' &&
                node.expressionKind === 'parenthesized';
        },
        function(marker) {
            return marker.syntaxId === 'delimiter';
        }
    );
    rejectRemovedMarker(
        'parenthesized query delimiter closure',
        'SELECT * FROM (SELECT 1) q',
        function(node) {
            return node.kind === 'query' && node.queryKind === 'parenthesized';
        },
        function(marker) {
            return marker.syntaxId === 'delimiter';
        }
    );
    rejectRemovedMarker(
        'function DISTINCT operator marker closure',
        'SELECT count(DISTINCT x)',
        function(node) {
            return node.kind === 'expression' &&
                node.expressionKind === 'function-call';
        },
        function(marker) {
            return marker.syntaxId === 'operator';
        }
    );
    rejectRemovedMarker(
        'list-item modifier marker closure',
        'SELECT a FROM t ORDER BY a DESC',
        function(node) {
            return node.kind === 'list-item' && node.modifierLeafIds.length > 0;
        },
        function(marker) {
            return marker.syntaxId === 'operator';
        }
    );
    ['type:cast', 'type:as', 'delimiter'].forEach(function(syntaxId) {
        rejectRemovedMarker(
            'CAST ' + syntaxId + ' marker closure',
            'SELECT CAST(x AS INT)',
            function(node) {
                return node.kind === 'expression' && node.expressionKind === 'cast';
            },
            function(marker) {
                return marker.syntaxId === syntaxId;
            }
        );
    });
}());

(function markerShapeAndBindingFailClosed() {
    var artifact = parse('SELECT a FROM t');
    var clause = find(artifact.output.root, function(node) {
        return node.kind === 'clause' && node.clauseKind === 'select';
    });
    var marker = clause.syntaxMarkers[0];

    assertRejected(
        'missing syntaxMarkers',
        artifact,
        replaceNode(artifact.output.root, clause.id, function(node) {
            delete node.syntaxMarkers;
        }),
        /syntaxMarkers.*own data property/i
    );
    assertRejected(
        'mutable syntaxMarkers',
        artifact,
        replaceNode(artifact.output.root, clause.id, function(node) {
            node.syntaxMarkers = clause.syntaxMarkers.slice();
        }),
        /stable frozen dense data array/i
    );
    assertRejected(
        'sparse syntaxMarkers',
        artifact,
        replaceNode(artifact.output.root, clause.id, function(node) {
            var sparse = new Array(2);
            sparse[0] = marker;
            node.syntaxMarkers = Object.freeze(sparse);
        }),
        /stable frozen dense data array/i
    );
    assertRejected(
        'non-finite syntax id',
        artifact,
        replaceNode(artifact.output.root, clause.id, function(node) {
            node.syntaxMarkers = Object.freeze([
                frozenMarker(marker, { syntaxId: 'clause:not-real' })
            ]);
        }),
        /non-finite syntaxId/i
    );
    assertRejected(
        'non-finite part ordinal',
        artifact,
        replaceNode(artifact.output.root, clause.id, function(node) {
            node.syntaxMarkers = Object.freeze([
                frozenMarker(marker, { partOrdinal: Infinity })
            ]);
        }),
        /partOrdinal.*finite/i
    );

    var primitiveArtifact = parse('SELECT 1');
    var primitive = find(primitiveArtifact.output.root, function(node) {
        return node.kind === 'expression' && node.expressionKind === 'literal';
    });
    assertRejected(
        'unexpected marker on primitive expression',
        primitiveArtifact,
        replaceNode(primitiveArtifact.output.root, primitive.id, function(node) {
            node.syntaxMarkers = Object.freeze([
                Object.freeze({
                    leafId: primitive.leafRange.start,
                    syntaxId: 'operator',
                    partOrdinal: 0,
                    syntaxRole: 'literal',
                    keywordCaseEligible: false
                })
            ]);
        }),
        /exact syntax marker closure/i
    );

    var identifierArtifact = parse('SELECT value_name');
    var identifier = find(identifierArtifact.output.root, function(node) {
        return node.kind === 'expression' && node.expressionKind === 'identifier';
    });
    assertRejected(
        'keyword-shaped extra operator marker on identifier',
        identifierArtifact,
        replaceNode(identifierArtifact.output.root, identifier.id, function(node) {
            node.syntaxMarkers = Object.freeze([
                Object.freeze({
                    leafId: identifier.leafRange.start,
                    syntaxId: 'operator',
                    partOrdinal: 0,
                    syntaxRole: 'word-operator-keyword',
                    keywordCaseEligible: true
                })
            ]);
        }),
        /exact syntax marker closure/i
    );

    var list = clause.children[0];
    var childLeafId = list.leafRange.start;
    assertRejected(
        'marker overlaps direct child',
        artifact,
        replaceNode(artifact.output.root, clause.id, function(node) {
            node.syntaxMarkers = Object.freeze(clause.syntaxMarkers.concat([
                Object.freeze({
                    leafId: childLeafId,
                    syntaxId: 'operator',
                    partOrdinal: 0,
                    syntaxRole: 'user-type-name',
                    keywordCaseEligible: false
                })
            ]));
        }),
        /overlaps a direct child/i
    );

    var quoted = parse('SELECT * FROM `select`');
    var relation = find(quoted.output.root, function(node) {
        return node.kind === 'relation' && node.relationKind === 'table';
    });
    assertRejected(
        'protected marker',
        quoted,
        replaceNode(quoted.output.root, relation.id, function(node) {
            node.syntaxMarkers = Object.freeze([
                Object.freeze({
                    leafId: relation.nameLeafRange.start,
                    syntaxId: 'type:name',
                    partOrdinal: 0,
                    syntaxRole: 'user-type-name',
                    keywordCaseEligible: false
                })
            ]);
        }),
        /code grammar leaf|overlaps nameLeafRange/i
    );
}());

(function capabilityRoleAllowlistFailsClosed() {
    var artifact = parse('SELECT a FROM t');
    var query = find(artifact.output.root, function(node) {
        return node.kind === 'query';
    });
    assertRejected(
        'null capability authority',
        artifact,
        replaceNode(artifact.output.root, query.id, function(node) {
            node.capabilityId = null;
        }),
        /illegal formatRole\/capabilityId|does not allow/i
    );
    assertRejected(
        'wrong node capability',
        artifact,
        replaceNode(artifact.output.root, query.id, function(node) {
            node.capabilityId = 'case-expression';
        }),
        /does not allow/i
    );
    assertRejected(
        'unknown format role',
        artifact,
        replaceNode(artifact.output.root, query.id, function(node) {
            node.formatRole = 'magic';
        }),
        /illegal value/i
    );
    assertRejected(
        'select-with-FROM capability clone',
        artifact,
        replaceNode(artifact.output.root, query.id, function(node) {
            node.capabilityId = 'select-without-from';
        }),
        /must use from capability authority/i
    );

    var mysql = parse("SELECT @name, _utf8mb4'abc', ?", 'mysql');
    var mysqlVariable = find(mysql.output.root, function(node) {
        return node.kind === 'expression' &&
            node.expressionKind === 'parameter' &&
            node.capabilityId === 'mysql-variables';
    });
    assertRejected(
        'MySQL variable missing primitive capability',
        mysql,
        replaceNode(mysql.output.root, mysqlVariable.id, function(node) {
            node.capabilityId = null;
            node.formatRole = 'intrinsic-primitive';
        }),
        /does not allow/i
    );
    var mysqlPlainParameter = find(mysql.output.root, function(node) {
        return node.kind === 'expression' &&
            node.expressionKind === 'parameter' &&
            node.capabilityId === null;
    });
    assertRejected(
        'ordinary MySQL parameter forged as variable capability',
        mysql,
        replaceNode(mysql.output.root, mysqlPlainParameter.id, function(node) {
            node.capabilityId = 'mysql-variables';
            node.formatRole = 'capability';
        }),
        /does not allow/i
    );

    var hiveTemplate = parse('SELECT ${hiveconf:key}', 'hive');
    var templateParameter = find(hiveTemplate.output.root, function(node) {
        return node.kind === 'expression' &&
            node.expressionKind === 'parameter';
    });
    assert.strictEqual(templateParameter.capabilityId, 'template-parameter');
    assert.strictEqual(templateParameter.formatRole, 'capability');
}());

(function canonicalDialectProvenanceFailsClosed() {
    var artifact = parse('SELECT a FROM t', 'hive');
    var result = invariants.validateSyntaxInvariants({
        root: artifact.output.root,
        leaves: artifact.output.leaves,
        source: artifact.source,
        dialect: 'postgresql',
        tokenTable: artifact.tokenTable
    });
    assert.strictEqual(result.ok, false, 'canonical root must retain its parser dialect');
    assert.ok(
        result.failures.some(function(failure) {
            return /different leaf partition or dialect/i.test(failure.message);
        }),
        JSON.stringify(result.failures)
    );
}());

(function relationNameAndClauseSeparatorsFailClosed() {
    var artifact = parse('SELECT * FROM db.t,u');
    var from = find(artifact.output.root, function(node) {
        return node.kind === 'clause' && node.clauseKind === 'from';
    });
    var relation = from.children[0];
    assert.ok(from.separatorLeafIds.length > 0, 'FROM must retain direct comma ownership');

    assertRejected(
        'missing table name range',
        artifact,
        replaceNode(artifact.output.root, relation.id, function(node) {
            node.nameLeafRange = null;
        }),
        /must own a complete nameLeafRange/i
    );
    assertRejected(
        'mutable table name range',
        artifact,
        replaceNode(artifact.output.root, relation.id, function(node) {
            node.nameLeafRange = {
                start: relation.nameLeafRange.start,
                end: relation.nameLeafRange.end
            };
        }),
        /stable frozen range/i
    );
    assertRejected(
        'truncated qualified name',
        artifact,
        replaceNode(artifact.output.root, relation.id, function(node) {
            node.nameLeafRange = Object.freeze({
                start: relation.nameLeafRange.start,
                end: relation.nameLeafRange.start + 1
            });
        }),
        /unclaimed syntax leaf|complete qualified name/i
    );
    assertRejected(
        'missing FROM separator',
        artifact,
        replaceNode(artifact.output.root, from.id, function(node) {
            node.separatorLeafIds = Object.freeze([]);
        }),
        /exactly own every direct-child comma gap/i
    );
    assertRejected(
        'separator overlaps child',
        artifact,
        replaceNode(artifact.output.root, from.id, function(node) {
            node.separatorLeafIds = Object.freeze([relation.leafRange.start]);
        }),
        /code comma|overlaps a direct child/i
    );
}());

(function operatorOccurrenceIdentityFailsClosed() {
    var artifact = parse('SELECT a @> b FROM t', 'postgresql');
    var expression = find(artifact.output.root, function(node) {
        return node.kind === 'expression' && node.operatorOccurrences.length > 0;
    });
    var occurrence = expression.operatorOccurrences[0];

    assertRejected(
        'cloned operator semantics',
        artifact,
        replaceNode(artifact.output.root, expression.id, function(node) {
            node.operatorOccurrences = Object.freeze([
                Object.freeze(Object.assign({}, occurrence, {
                    semantics: Object.freeze(Object.assign({}, occurrence.semantics))
                }))
            ]);
        }),
        /forged semantics identity/i
    );
    assertRejected(
        'operator occurrence missing coverage',
        artifact,
        replaceNode(artifact.output.root, expression.id, function(node) {
            node.operatorOccurrences = Object.freeze([]);
        }),
        /every operatorLeafId/i
    );
    assertRejected(
        'sparse operator occurrence array',
        artifact,
        replaceNode(artifact.output.root, expression.id, function(node) {
            var sparse = new Array(2);
            sparse[0] = occurrence;
            node.operatorOccurrences = Object.freeze(sparse);
        }),
        /stable frozen dense data array/i
    );
    assertRejected(
        'marker operator double claim',
        artifact,
        replaceNode(artifact.output.root, expression.id, function(node) {
            node.syntaxMarkers = Object.freeze([
                Object.freeze({
                    leafId: occurrence.leafIds[0],
                    syntaxId: 'operator',
                    partOrdinal: 0,
                    syntaxRole: 'symbol-operator',
                    keywordCaseEligible: false
                })
            ]);
        }),
        /also claims an operator occurrence/i
    );
}());

(function crossDialectOperatorIdentityFailsClosed() {
    var artifact = parse('SELECT a + b', 'postgresql');
    var expression = find(artifact.output.root, function(node) {
        return node.kind === 'expression' && node.operatorOccurrences.length > 0;
    });
    var occurrence = expression.operatorOccurrences[0];
    var hiveSemantics = dialectRegistry.getDialect('hive')
        .getOperatorSemantics('+', 'infix');
    assert.ok(hiveSemantics, 'Hive infix + semantics required');
    assert.notStrictEqual(
        hiveSemantics,
        occurrence.semantics,
        'dialect registries must own distinct canonical semantics objects'
    );

    assertRejected(
        'cross-dialect operator semantics identity',
        artifact,
        replaceNode(artifact.output.root, expression.id, function(node) {
            node.operatorOccurrences = Object.freeze([
                Object.freeze(Object.assign({}, occurrence, {
                    operatorId: hiveSemantics.id,
                    capabilityId: hiveSemantics.capabilityId,
                    fixity: hiveSemantics.fixity,
                    formatClass: hiveSemantics.formatClass,
                    semantics: hiveSemantics
                }))
            ]);
        }),
        /forged semantics identity/i
    );
}());

(function canonicalFastPathRequiresFactoryOwnedDescendants() {
    var artifact = parse('SELECT 1');
    var canonicalRoot = artifact.output.root;
    var canonicalNodeCount = nodeFactory.canonicalProgramNodeCount(canonicalRoot);
    assert.ok(canonicalNodeCount > 1, 'canonical parser root must carry node-count proof');

    var accessorReads = 0;
    var accessorInjected = false;
    function cloneForeignSubtree(node) {
        var clone = {};
        Object.keys(node).forEach(function(key) {
            if (key === 'children' ||
                (!accessorInjected && key === 'syntaxMarkers' && node.kind === 'expression')) {
                return;
            }
            clone[key] = node[key];
        });
        if (!accessorInjected && node.kind === 'expression') {
            accessorInjected = true;
            Object.defineProperty(clone, 'syntaxMarkers', {
                enumerable: true,
                configurable: false,
                get: function() {
                    accessorReads += 1;
                    return node.syntaxMarkers;
                }
            });
        }
        if (Object.prototype.hasOwnProperty.call(node, 'children')) {
            clone.children = Object.freeze(node.children.map(cloneForeignSubtree));
        }
        return Object.freeze(clone);
    }

    var foreignChildren = canonicalRoot.children.map(cloneForeignSubtree);
    assert.strictEqual(accessorInjected, true, 'probe must inject a foreign accessor node');

    var parserFactory = nodeFactory.createParserNodeFactory(
        artifact.tokenTable,
        artifact.dialect
    );
    for (var id = 1; id < canonicalNodeCount; id++) {
        parserFactory.createOpaque(
            canonicalRoot.leafRange,
            'SYN_UNMODELED_CONSTRUCT',
            'statement'
        );
    }

    var wrappedRoot;
    var constructionError = null;
    try {
        wrappedRoot = parserFactory.createProgram(
            canonicalRoot.leafRange,
            foreignChildren,
            {
                syntaxMarkers: canonicalRoot.syntaxMarkers,
                capabilityId: canonicalRoot.capabilityId,
                formatRole: canonicalRoot.formatRole
            }
        );
    } catch (error) {
        constructionError = error;
    }

    if (constructionError !== null) {
        assert.match(
            String(constructionError.message || constructionError),
            /canonical|factory|foreign|owned|provenance|child/i,
            'factory-level rejection must identify the foreign canonical subtree'
        );
        assert.strictEqual(accessorReads, 0, 'factory rejection must not invoke foreign accessors');
        return;
    }

    assert.strictEqual(
        nodeFactory.canonicalProgramNodeCountForLeaves(
            wrappedRoot,
            artifact.output.leaves
        ),
        canonicalNodeCount,
        'probe must reproduce a root-level canonical proof over foreign descendants'
    );
    var result = validate(artifact, wrappedRoot);
    assert.strictEqual(
        result.ok,
        false,
        'root provenance must not trust non-factory-proven descendants'
    );
    assert.ok(
        result.failures.some(function(failure) {
            return /canonical|factory|foreign|owned|provenance|own data property|shape/i.test(
                failure.code + ' ' + failure.message
            );
        }),
        'foreign canonical subtree rejection must retain actionable evidence: ' +
            JSON.stringify(result.failures)
    );
}());

(function rootChildrenElementsUseOneStableSnapshot() {
    var artifact = parse('SELECT 1');
    var statement = artifact.output.root.children[0];
    var reads = 0;
    var stableChildren = new Array(1);
    Object.defineProperty(stableChildren, 0, {
        enumerable: true,
        configurable: true,
        get: function() {
            reads += 1;
            return statement;
        }
    });
    var stableRoot = Object.assign({}, artifact.output.root, {
        children: stableChildren
    });
    var stableResult = validate(artifact, stableRoot);
    assert.strictEqual(stableResult.ok, true, JSON.stringify(stableResult.failures));
    assert.strictEqual(reads, 1,
        'root child element accessor must be consumed exactly once');

    var forwardArtifact = parse('SELECT 1; SELECT 2');
    var first = forwardArtifact.output.root.children[0];
    var second = forwardArtifact.output.root.children[1];
    var forwardReads = 0;
    var forwardChildren = [null, second];
    Object.defineProperty(forwardChildren, 0, {
        enumerable: true,
        configurable: true,
        get: function() {
            forwardReads += 1;
            Object.defineProperty(forwardChildren, 1, {
                enumerable: true,
                configurable: true,
                writable: true,
                value: first
            });
            return first;
        }
    });
    var forwardRoot = Object.assign({}, forwardArtifact.output.root, {
        children: forwardChildren
    });
    var forwardResult = validate(forwardArtifact, forwardRoot);
    assert.strictEqual(forwardReads, 1);
    assert.strictEqual(forwardResult.ok, false,
        'forward child replacement must invalidate the snapshot');
    assert.ok(forwardResult.failures.some(function(failure) {
        return /children.*dense|children.*array|INV_SHAPE/i.test(
            failure.code + ' ' + failure.message
        );
    }), JSON.stringify(forwardResult.failures));
}());

(function highFanOutMarkerClosureStaysSubQuadratic() {
    function median(values) {
        return values.slice().sort(function(left, right) {
            return left - right;
        })[Math.floor(values.length / 2)];
    }

    function cloneAsNonCanonicalDataTree(node) {
        var clone = {};
        Object.keys(node).forEach(function(key) {
            if (key !== 'children') {
                clone[key] = node[key];
            }
        });
        if (Array.isArray(node.children)) {
            clone.children = node.children.map(cloneAsNonCanonicalDataTree);
        }
        return clone;
    }

    function validationMedianMs(source, nonCanonicalClone) {
        var artifact = parse(source);
        var root = nonCanonicalClone
            ? cloneAsNonCanonicalDataTree(artifact.output.root)
            : artifact.output.root;
        var warm = validate(artifact, root);
        assert.strictEqual(warm.ok, true, JSON.stringify(warm.failures));
        var samples = [];
        for (var sample = 0; sample < 5; sample++) {
            var started = process.hrtime.bigint();
            var result = validate(artifact, root);
            samples.push(Number(process.hrtime.bigint() - started) / 1e6);
            assert.strictEqual(result.ok, true, JSON.stringify(result.failures));
        }
        return median(samples);
    }

    function assertScale(label, sourceForSize, nonCanonicalClone) {
        var sizes = [2000, 8000];
        var timings = sizes.map(function(size) {
            return {
                size: size,
                medianMs: validationMedianMs(
                    sourceForSize(size),
                    nonCanonicalClone
                )
            };
        });
        var ratio = timings[1].medianMs /
            Math.max(timings[0].medianMs, 0.001);
        assert.ok(
            ratio <= 8,
            label + ' validation regressed toward O(n^2): ' +
                JSON.stringify(timings)
        );
        assert.ok(
            timings[timings.length - 1].medianMs <= 1500,
            label + ' 8k validation exceeded the disaster gate: ' +
                JSON.stringify(timings)
        );
        return timings;
    }

    var caseTimings = assertScale('high-fanout CASE', function(size) {
        var branches = [];
        for (var index = 0; index < size; index++) {
            branches.push('WHEN c' + index + ' THEN ' + index);
        }
        return 'SELECT CASE ' + branches.join(' ') + ' ELSE 0 END FROM t';
    });
    var listTimings = assertScale('high-fanout SELECT list', function(size) {
        var members = [];
        for (var index = 0; index < size; index++) {
            members.push('c' + index);
        }
        return 'SELECT ' + members.join(',') + ' FROM t';
    });
    var clonedCaseTimings = assertScale(
        'noncanonical high-fanout CASE',
        function(size) {
            var branches = [];
            for (var index = 0; index < size; index++) {
                branches.push('WHEN c' + index + ' THEN ' + index);
            }
            return 'SELECT CASE ' + branches.join(' ') +
                ' ELSE 0 END FROM t';
        },
        true
    );
    var clonedListTimings = assertScale(
        'noncanonical high-fanout SELECT list',
        function(size) {
            var members = [];
            for (var index = 0; index < size; index++) {
                members.push('c' + index);
            }
            return 'SELECT ' + members.join(',') + ' FROM t';
        },
        true
    );
    console.log('high-fanout marker closure scale ' + JSON.stringify({
        case: caseTimings,
        list: listTimings,
        clonedCase: clonedCaseTimings,
        clonedList: clonedListTimings
    }));
}());

console.log('v2 Wave 3A CST invariant tests passed');
