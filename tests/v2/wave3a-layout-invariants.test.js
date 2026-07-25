'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var artifactApi = require('../../.tmp/v2-core/core/layout/artifact.js');
var factoryApi = require('../../.tmp/v2-core/core/layout/doc-factory.js');
var invariantApi = require('../../.tmp/v2-core/core/layout/invariants.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');

function analyze(source, dialect) {
    var output = analysisApi.analyzeSql(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    assert.strictEqual(output.status, 'analyzed', 'fixture must be analyzable');
    return output;
}

function canonicalOptions(dialect) {
    var output = optionsApi.resolveFormatOptions(
        dialect ? { dialect: dialect } : undefined
    );
    assert.strictEqual(output.ok, true);
    return output.options;
}

function canonicalCoverageDocs(factory, excludedLeafIds) {
    var excluded = new Set(excludedLeafIds || []);
    var claimsByStart = new Map();
    factory.verbatimClaims.forEach(function(claim) {
        claimsByStart.set(claim.leafRange.start, claim);
    });
    var docs = [];
    var leafId = 0;
    while (leafId < factory.analysis.leaves.length) {
        var claim = claimsByStart.get(leafId);
        if (claim) {
            for (var owned = claim.leafRange.start; owned < claim.leafRange.end; owned++) {
                assert.strictEqual(excluded.has(owned), false,
                    'a dominating verbatim range cannot be partially excluded');
            }
            var verbatim = factory.verbatim(claim.ownerNodeId, claim.trigger);
            assert.ok(verbatim, 'dominating claim must create canonical verbatim');
            docs.push(verbatim);
            leafId = claim.leafRange.end;
            continue;
        }
        if (!excluded.has(leafId)) {
            var leaf = factory.leaf(leafId, 'raw');
            assert.ok(leaf, 'unclaimed raw leaf must be constructible: ' + leafId);
            docs.push(leaf);
        }
        leafId += 1;
    }
    return docs;
}

function fullCanonicalRoot(factory) {
    var root = factory.concat(canonicalCoverageDocs(factory));
    assert.ok(root);
    return root;
}

(function testCanonicalFactoryAndArtifactIdentity() {
    var analysis = analyze('SELECT  1');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    assert.ok(factory);
    assert.strictEqual(Object.isFrozen(factory), true);
    assert.strictEqual(factoryApi.isCanonicalLayoutDocFactory(factory), true);

    var root = fullCanonicalRoot(factory);
    var checked = invariantApi.validateLayoutDoc(analysis, root);
    assert.strictEqual(checked.ok, true);
    assert.strictEqual(Object.isFrozen(checked), true);
    assert.strictEqual(checked.emittedSourceLeafCount, analysis.leaves.length);

    var created = artifactApi.createLayoutArtifact(
        analysis,
        root,
        canonicalOptions()
    );
    assert.strictEqual(created.ok, true);
    assert.strictEqual(Object.isFrozen(created.artifact), true);
    assert.strictEqual(artifactApi.isCanonicalLayoutArtifact(created.artifact), true);
    assert.strictEqual(
        artifactApi.createLayoutArtifact(analysis, root, canonicalOptions()).ok,
        false,
        'one canonical doc graph must not be rebound to another artifact'
    );
    assert.strictEqual(
        artifactApi.isCanonicalLayoutArtifact(Object.assign({}, created.artifact)),
        false,
        'artifact clone must not inherit provenance'
    );
})();

(function testOnlyRequiredSourceLeavesNeedCoverage() {
    var analysis = analyze('SELECT   1\n');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    var optional = analysis.leaves.filter(function(leaf) {
        return (leaf.kind === 'whitespace' || leaf.kind === 'newline') &&
            !factory.verbatimClaims.some(function(claim) {
                return leaf.id >= claim.leafRange.start && leaf.id < claim.leafRange.end;
            });
    }).map(function(leaf) {
        return leaf.id;
    });
    var root = factory.concat(canonicalCoverageDocs(factory, optional));
    var result = artifactApi.createLayoutArtifact(analysis, root, canonicalOptions());
    assert.strictEqual(result.ok, true,
        'source whitespace/newline may be replaced by generated layout whitespace');
})();

(function testKeywordTransformUsesContextualProof() {
    var analysis = analyze('select window AS order FROM group');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    function leafId(raw, ordinal) {
        var matches = analysis.leaves.filter(function(leaf) {
            return leaf.raw.toLowerCase() === raw.toLowerCase();
        });
        return matches[ordinal || 0].id;
    }

    ['select', 'AS', 'FROM'].forEach(function(raw) {
        var id = leafId(raw);
        assert.strictEqual(analysis.index.leafContext(id).syntax.keywordCaseEligible, true);
        var doc = factory.leaf(id, 'keyword-case');
        assert.ok(doc, 'formatted Hive query keyword must accept contextual proof');
        assert.strictEqual(doc.transform, 'keyword-case');
    });
    assert.strictEqual(factory.leaf(leafId('window'), 'keyword-case'), null,
        'keyword-shaped select item is an identifier');
    assert.strictEqual(factory.leaf(leafId('order'), 'keyword-case'), null,
        'keyword-shaped alias is not syntax');
    assert.strictEqual(factory.leaf(leafId('group'), 'keyword-case'), null,
        'keyword-shaped relation name is not syntax');

    var generic = analyze('select 1', 'generic');
    var genericFactory = factoryApi.createLayoutDocFactory(generic);
    assert.ok(genericFactory.leaf(0, 'keyword-case'),
        'Wave 3E shared generic query must accept contextual keyword proof');

    var genericArray = analyze('select ARRAY[1]', 'generic');
    var genericArrayFactory = factoryApi.createLayoutDocFactory(genericArray);
    var arrayLeaf = genericArray.leaves.find(function(leaf) {
        return leaf.raw.toLowerCase() === 'array';
    });
    assert.ok(arrayLeaf);
    assert.strictEqual(
        genericArrayFactory.leaf(arrayLeaf.id, 'keyword-case'),
        null,
        'structured-only generic ARRAY subset must still dominate its keywords'
    );
})();

(function testProtectedAndCommentLeavesCannotTransform() {
    var analysis = analyze("SELECT 'from' -- WHERE\n");
    var factory = factoryApi.createLayoutDocFactory(analysis);
    analysis.leaves.forEach(function(leaf) {
        if (leaf.channel === 'protected' || leaf.kind === 'line-comment') {
            assert.strictEqual(factory.leaf(leaf.id, 'keyword-case'), null);
        }
    });
})();

(function testOpaqueDominatingClaimCannotBeBypassedByLeafEmission() {
    var source = 'SELECT * FROM t -- keep\nQUALIFY row_number() OVER () = 1';
    var analysis = analyze(source);
    var factory = factoryApi.createLayoutDocFactory(analysis);
    assert.strictEqual(factory.verbatimClaims.length, 1);
    var claim = factory.verbatimClaims[0];
    assert.strictEqual(claim.trigger.kind, 'opaque');
    for (var leafId = claim.leafRange.start; leafId < claim.leafRange.end; leafId++) {
        assert.strictEqual(factory.leaf(leafId, 'raw'), null,
            'opaque claim leaf ' + leafId + ' must not be emitted independently');
    }
    var comment = analysis.leaves.filter(function(leaf) {
        return leaf.kind === 'line-comment';
    })[0];
    assert.ok(comment && comment.id >= claim.leafRange.start &&
        comment.id < claim.leafRange.end);
    assert.strictEqual(factory.leaf(comment.id, 'raw'), null,
        'comments inside opaque ownership must stay inside exact verbatim');

    var root = factory.verbatim(claim.ownerNodeId, claim.trigger);
    var checked = invariantApi.validateLayoutDoc(analysis, root);
    assert.strictEqual(checked.ok, true);
    assert.strictEqual(checked.emittedSourceLeafCount, analysis.leaves.length);
})();

(function testNodeAndOperatorVerbatimHandlesAreExact() {
    var hive = analyze('SELECT ${hiveconf:value}');
    var hiveFactory = factoryApi.createLayoutDocFactory(hive);
    var templateParameter = hive.index.nodes().filter(function(node) {
        return node.kind === 'expression' &&
            node.capabilityId === 'template-parameter';
    })[0];
    assert.ok(templateParameter);
    var queryDoc = hiveFactory.verbatim(templateParameter.id, {
        kind: 'node-capability',
        capabilityId: 'template-parameter'
    });
    assert.ok(queryDoc);
    assert.strictEqual(queryDoc.leafRange, templateParameter.leafRange,
        'verbatim range must be the exact owner range object');
    assert.strictEqual(hiveFactory.verbatim(templateParameter.id, {
        kind: 'node-capability',
        capabilityId: 'select-without-from'
    }), null, 'wrong capability trigger must fail');

    var postgres = analyze("SELECT payload @> '{\"a\":1}' FROM t", 'postgresql');
    var postgresFactory = factoryApi.createLayoutDocFactory(postgres);
    var occurrence;
    var owner;
    postgres.index.nodes().forEach(function(node) {
        if (node.kind !== 'expression') {
            return;
        }
        postgres.index.operatorOccurrencesOf(node.id).forEach(function(value) {
            if (value.capabilityId === 'postgres-json-operators') {
                occurrence = value;
                owner = node;
            }
        });
    });
    assert.ok(occurrence && owner);
    assert.ok(postgresFactory.verbatim(owner.id, {
        kind: 'operator-capability',
        capabilityId: occurrence.capabilityId,
        operatorId: occurrence.operatorId
    }), 'structured PG operator must retain an exact owner claim');
    assert.ok(postgresFactory.verbatimClaims.some(function(claim) {
        return claim.ownerNodeId === owner.id &&
            claim.leafRange.start === owner.leafRange.start &&
            claim.leafRange.end === owner.leafRange.end;
    }), 'PG operator claim must not widen to the formatted query');
    assert.strictEqual(postgresFactory.verbatim(owner.id, {
        kind: 'operator-capability',
        capabilityId: occurrence.capabilityId,
        operatorId: 'forged-operator'
    }), null);
})();

(function testSameRangeVerbatimReasonsChooseOneDeterministicClaim() {
    var script = [
        "const assert = require('assert');",
        "const registry = require('./.tmp/v2-core/core/dialects/registry.js');",
        "const originalGetDialect = registry.getDialect;",
        "const promotions = new Map([",
        "  ['hive', new Set(['select-without-from', 'from'])],",
        "  ['postgresql', new Set(['select-without-from'])]",
        "]);",
        "const demotions = new Map([",
        "  ['hive', new Set(['subquery-expression', 'function-call'])]",
        "]);",
        "const wrapped = new Map();",
        "registry.getDialect = function(id) {",
        "  if (!promotions.has(id)) return originalGetDialect(id);",
        "  if (wrapped.has(id)) return wrapped.get(id);",
        "  const view = originalGetDialect(id);",
        "  const promoted = promotions.get(id);",
        "  const demoted = demotions.get(id) || new Set();",
        "  const capabilities = Object.freeze(view.listCapabilities().map(function(entry) {",
        "    return promoted.has(entry.id)",
        "      ? Object.freeze({ id: entry.id, state: 'formatted' })",
        "      : demoted.has(entry.id)",
        "        ? Object.freeze({ id: entry.id, state: 'structured' })",
        "        : entry;",
        "  }));",
        "  const byId = new Map(capabilities.map(function(entry) { return [entry.id, entry]; }));",
        "  const replacement = Object.create(view);",
        "  Object.defineProperty(replacement, 'listCapabilities', { value: function() { return capabilities; } });",
        "  Object.defineProperty(replacement, 'getCapability', { value: function(capabilityId) { return byId.get(capabilityId) || null; } });",
        "  Object.freeze(replacement);",
        "  wrapped.set(id, replacement);",
        "  return replacement;",
        "};",
        "const analysis = require('./.tmp/v2-core/core/analysis/index.js');",
        "const factoryApi = require('./.tmp/v2-core/core/layout/doc-factory.js');",
        "[",
        "  { dialect: 'hive', source: 'SELECT (SELECT 1)', kind: 'expression', subtypeKey: 'expressionKind', subtype: 'subquery', capabilityId: 'subquery-expression' },",
        "  { dialect: 'hive', source: 'SELECT * FROM explode(arr)', kind: 'expression', subtypeKey: 'expressionKind', subtype: 'function-call', capabilityId: 'function-call' },",
        "  { dialect: 'postgresql', source: 'SELECT 1::int', kind: 'expression', subtypeKey: 'expressionKind', subtype: 'cast', capabilityId: 'cast-type' }",
        "].forEach(function(testCase) {",
        "  const artifact = analysis.analyzeSql(testCase.source, { dialect: testCase.dialect, mode: 'document' });",
        "  assert.strictEqual(artifact.status, 'analyzed');",
        "  const factory = factoryApi.createLayoutDocFactory(artifact);",
        "  assert.ok(factory, testCase.dialect + ' ' + testCase.source + ' must normalize same-range reasons');",
        "  assert.ok(factory.verbatimClaims.length > 0);",
        "  const matching = factory.verbatimClaims.filter(function(claim) {",
        "    const owner = artifact.index.nodeById(claim.ownerNodeId);",
        "    return owner.kind === testCase.kind && owner[testCase.subtypeKey] === testCase.subtype;",
        "  });",
        "  assert.strictEqual(matching.length, 1, testCase.source + ' must select the outer semantic owner');",
        "  const owner = artifact.index.nodeById(matching[0].ownerNodeId);",
        "  assert.strictEqual(owner.capabilityId, testCase.capabilityId);",
        "  assert.strictEqual(owner.leafRange, matching[0].leafRange);",
        "});"
    ].join('\n');
    var result = childProcess.spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8'
    });
    assert.strictEqual(
        result.status,
        0,
        'same-range verbatim claim subprocess failed:\n' +
            result.stdout + '\n' + result.stderr
    );
})();

(function testTrailingCommentUsesRestrictedSuffix() {
    var analysis = analyze('SELECT 1 -- trailing');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    var comment = analysis.leaves.filter(function(leaf) {
        return leaf.kind === 'line-comment';
    })[0];
    assert.ok(comment);
    assert.strictEqual(factory.leaf(comment.id, 'raw'), null,
        'trailing line comments must never enter the ordinary raw-leaf path');
    var suffix = factory.lineSuffix(comment.id, { kind: 'space', columns: 1 });
    assert.ok(suffix);
    assert.strictEqual(Object.isFrozen(suffix.spacing), true);
    var root = factory.concat(
        canonicalCoverageDocs(factory, [comment.id]).concat([suffix])
    );
    assert.strictEqual(invariantApi.validateLayoutDoc(analysis, root).ok, true);
    assert.strictEqual(factory.lineSuffix(comment.id, { kind: 'space', columns: 0 }), null);

    var blockAnalysis = analyze('SELECT 1 /* trailing block */');
    var blockFactory = factoryApi.createLayoutDocFactory(blockAnalysis);
    var blockComment = blockAnalysis.leaves.filter(function(leaf) {
        return leaf.kind === 'block-comment';
    })[0];
    assert.ok(blockComment);
    assert.strictEqual(
        blockAnalysis.index.commentBinding(blockComment.id).placement,
        'trailing'
    );
    assert.strictEqual(blockFactory.leaf(blockComment.id, 'raw'), null,
        'trailing block comments must use the same restricted suffix channel');
    var blockSuffix = blockFactory.lineSuffix(blockComment.id, null);
    assert.ok(blockSuffix);
    var blockRoot = blockFactory.concat(
        canonicalCoverageDocs(blockFactory, [blockComment.id]).concat([blockSuffix])
    );
    assert.strictEqual(invariantApi.validateLayoutDoc(blockAnalysis, blockRoot).ok, true);
})();

(function testPendingLineSuffixBudgetResetsAtGuaranteedLineBreaks() {
    var suffixLimit = 4096;
    var comments = [];
    for (var index = 0; index <= suffixLimit; index++) {
        comments.push('/* suffix-' + index + ' */');
    }
    var analysis = analyze(
        'SELECT 1 FROM t ' + comments.join(' '),
        'generic'
    );
    var commentLeafIds = analysis.leaves.filter(function(leaf) {
        return leaf.kind === 'block-comment';
    }).map(function(leaf) {
        return leaf.id;
    });
    assert.strictEqual(commentLeafIds.length, suffixLimit + 1);

    function suffixParts(factory, breakAfterSuffix) {
        var optionalTriviaIds = analysis.leaves.filter(function(leaf) {
            return leaf.kind === 'whitespace' || leaf.kind === 'newline';
        }).map(function(leaf) {
            return leaf.id;
        });
        var parts = canonicalCoverageDocs(
            factory,
            commentLeafIds.concat(optionalTriviaIds)
        );
        commentLeafIds.forEach(function(commentLeafId) {
            parts.push(factory.lineSuffix(commentLeafId, null));
            if (breakAfterSuffix) {
                parts.push(factory.hardLine());
            }
        });
        return parts;
    }

    var overflowingFactory = factoryApi.createLayoutDocFactory(analysis);
    assert.strictEqual(
        overflowingFactory.budget.maxPendingLineSuffixes,
        suffixLimit
    );
    var overflowingParts = suffixParts(overflowingFactory, false);
    var overflowingRoot = overflowingFactory.concat(overflowingParts);
    var overflowing = invariantApi.validateLayoutDoc(analysis, overflowingRoot);
    assert.strictEqual(overflowing.ok, false);
    assert.ok(overflowing.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET' &&
            /line-suffix budget/i.test(failure.message);
    }));

    var boundedFactory = factoryApi.createLayoutDocFactory(analysis);
    var boundedParts = suffixParts(boundedFactory, true);
    var boundedRoot = boundedFactory.concat(boundedParts);
    var bounded = invariantApi.validateLayoutDoc(analysis, boundedRoot);
    assert.strictEqual(
        bounded.ok,
        true,
        'distributed suffixes must use concurrent pending count: ' +
            JSON.stringify(bounded.failures)
    );
})();

(function testImplicitLineCommentBreaksConsumeTheRealPrefixBudget() {
    var script = [
        "const assert = require('assert');",
        "const registry = require('./.tmp/v2-core/core/dialects/registry.js');",
        "const originalGetDialect = registry.getDialect;",
        "let wrapped = null;",
        "registry.getDialect = function(id) {",
        "  if (id !== 'hive') return originalGetDialect(id);",
        "  if (wrapped !== null) return wrapped;",
        "  const view = originalGetDialect(id);",
        "  const promoted = new Set(['multi-statement', 'select-without-from']);",
        "  const capabilities = Object.freeze(view.listCapabilities().map(function(entry) {",
        "    return promoted.has(entry.id)",
        "      ? Object.freeze({ id: entry.id, state: 'formatted' })",
        "      : entry;",
        "  }));",
        "  const byId = new Map(capabilities.map(function(entry) { return [entry.id, entry]; }));",
        "  wrapped = Object.create(view);",
        "  Object.defineProperty(wrapped, 'listCapabilities', { value: function() { return capabilities; } });",
        "  Object.defineProperty(wrapped, 'getCapability', { value: function(capabilityId) { return byId.get(capabilityId) || null; } });",
        "  Object.freeze(wrapped);",
        "  return wrapped;",
        "};",
        "const analysisApi = require('./.tmp/v2-core/core/analysis/index.js');",
        "const factoryApi = require('./.tmp/v2-core/core/layout/doc-factory.js');",
        "const invariantApi = require('./.tmp/v2-core/core/layout/invariants.js');",
        "const statements = [];",
        "for (let index = 0; index < 100; index++) statements.push('SELECT 1; -- c' + index);",
        "const source = statements.join('\\n') + '\\nSELECT 1';",
        "const analysis = analysisApi.analyzeSql(source, { dialect: 'hive', mode: 'document' });",
        "assert.strictEqual(analysis.status, 'analyzed');",
        "const factory = factoryApi.createLayoutDocFactory(analysis);",
        "assert.ok(factory);",
        "assert.deepStrictEqual(factory.verbatimClaims, []);",
        "const parts = [];",
        "analysis.leaves.forEach(function(leaf) {",
        "  if (leaf.kind === 'whitespace' || leaf.kind === 'newline') return;",
        "  const binding = analysis.index.commentBinding(leaf.id);",
        "  const doc = binding !== null && binding.placement === 'trailing'",
        "    ? factory.lineSuffix(leaf.id, null)",
        "    : factory.leaf(leaf.id, 'raw');",
        "  assert.ok(doc, 'missing doc for leaf ' + leaf.id + ':' + leaf.kind);",
        "  parts.push(doc);",
        "});",
        "const content = factory.concat(parts);",
        "const root = factory.indent(factory.budget.maxCumulativeIndentLevels, content);",
        "const result = invariantApi.validateLayoutDoc(analysis, root);",
        "assert.strictEqual(result.ok, false);",
        "assert.ok(result.failures.some(function(failure) {",
        "  return failure.code === 'LAYOUT_RESOURCE_BUDGET' && /total generated-whitespace budget/i.test(failure.message);",
        "}), 'implicit breaks before later source must include the active indent prefix');",
        "const blockCount = 4097;",
        "const blockChunks = ['SELECT 0'];",
        "for (let index = 0; index < blockCount; index++) {",
        "  blockChunks.push(' /* b' + index + ' */ + ' + (index + 1));",
        "}",
        "const blockAnalysis = analysisApi.analyzeSql(blockChunks.join(''), { dialect: 'hive', mode: 'document' });",
        "assert.strictEqual(blockAnalysis.status, 'analyzed');",
        "const blockFactory = factoryApi.createLayoutDocFactory(blockAnalysis);",
        "assert.ok(blockFactory);",
        "assert.deepStrictEqual(blockFactory.verbatimClaims, []);",
        "assert.strictEqual(blockFactory.budget.maxPendingLineSuffixes, 4096);",
        "const blockParts = [];",
        "blockAnalysis.leaves.forEach(function(leaf) {",
        "  if (leaf.kind === 'whitespace' || leaf.kind === 'newline') return;",
        "  const binding = blockAnalysis.index.commentBinding(leaf.id);",
        "  const doc = binding !== null && binding.placement === 'trailing'",
        "    ? blockFactory.lineSuffix(leaf.id, null)",
        "    : blockFactory.leaf(leaf.id, 'raw');",
        "  assert.ok(doc, 'missing block-suffix doc for leaf ' + leaf.id + ':' + leaf.kind);",
        "  blockParts.push(doc);",
        "});",
        "const blockRoot = blockFactory.concat(blockParts);",
        "const blockResult = invariantApi.validateLayoutDoc(blockAnalysis, blockRoot);",
        "assert.strictEqual(blockResult.ok, true, JSON.stringify(blockResult.failures));"
    ].join('\n');
    var result = childProcess.spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8'
    });
    assert.strictEqual(
        result.status,
        0,
        'implicit line-comment break subprocess failed:\n' +
            result.stdout + '\n' + result.stderr
    );
})();

(function testLeadingAndDanglingCommentsRemainRawSourceLeaves() {
    [
        { source: '-- leading\nSELECT 1', placement: 'leading' },
        { source: 'SELECT 1;\n-- detached', placement: 'dangling' }
    ].forEach(function(testCase) {
        var analysis = analyze(testCase.source);
        var factory = factoryApi.createLayoutDocFactory(analysis);
        var binding = analysis.index.commentBindings()[0];
        assert.ok(binding);
        assert.strictEqual(binding.placement, testCase.placement);
        var comment = analysis.leaves[binding.commentLeafId];
        assert.ok(comment && comment.kind === 'line-comment');
        assert.ok(factory.leaf(comment.id, 'raw'),
            testCase.placement + ' comments must retain the ordinary raw path');
        assert.strictEqual(factory.lineSuffix(comment.id, null), null,
            testCase.placement + ' comments must not masquerade as line suffixes');
        assert.strictEqual(
            invariantApi.validateLayoutDoc(analysis, fullCanonicalRoot(factory)).ok,
            true,
            testCase.placement + ' raw comment coverage must remain valid'
        );
    });
})();

(function testFactoryRejectsSharedSparseProxyAndAmplification() {
    var analysis = analyze('SELECT 1');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    var semicolonAnalysis = analyze('SELECT 1;');
    var semicolonFactory = factoryApi.createLayoutDocFactory(semicolonAnalysis);
    var semicolon = semicolonAnalysis.leaves.length - 1;
    var leaf = semicolonFactory.leaf(semicolon, 'raw');
    assert.ok(leaf);
    assert.strictEqual(semicolonFactory.concat([leaf, leaf]), null,
        'shared child identity must not enter a canonical graph');

    var sparse = new Array(1);
    assert.strictEqual(factory.concat(sparse), null);
    assert.strictEqual(
        factory.concat(new Array(factory.budget.maxDocNodes + 1)),
        null,
        'oversized parts must be rejected from length metadata before copying'
    );
    assert.strictEqual(factory.concat(new Proxy([], {})), null);
    assert.strictEqual(factory.space(-1), null);
    assert.strictEqual(factory.space(1.5), null);
    assert.strictEqual(factory.space(Number.MAX_SAFE_INTEGER), null);
    var zero = factory.space(0);
    assert.ok(zero && zero.kind === 'concat' && zero.parts.length === 0);

    var triggerReads = 0;
    var trigger = {};
    Object.defineProperty(trigger, 'kind', {
        enumerable: true,
        get: function() {
            triggerReads += 1;
            return 'node-capability';
        }
    });
    Object.defineProperty(trigger, 'capabilityId', {
        enumerable: true,
        value: 'select-without-from'
    });
    var query = analysis.index.queries()[0];
    assert.strictEqual(factory.verbatim(query.id, trigger), null);
    assert.strictEqual(triggerReads, 0,
        'verbatim trigger accessors must be rejected without invocation');

    var commentAnalysis = analyze('SELECT 1 -- x');
    var commentFactory = factoryApi.createLayoutDocFactory(commentAnalysis);
    var commentLeaf = commentAnalysis.leaves.filter(function(value) {
        return value.kind === 'line-comment';
    })[0];
    var spacingReads = 0;
    var spacing = { kind: 'space' };
    Object.defineProperty(spacing, 'columns', {
        enumerable: true,
        get: function() {
            spacingReads += 1;
            return 1;
        }
    });
    assert.strictEqual(commentFactory.lineSuffix(commentLeaf.id, spacing), null);
    assert.strictEqual(spacingReads, 0,
        'suffix spacing accessors must not be invoked');
})();

(function testAggregateGeneratedWhitespaceBudgetsFailClosed() {
    var analysis = analyze('SELECT 1');

    var lineFactory = factoryApi.createLayoutDocFactory(analysis);
    var lineParts = canonicalCoverageDocs(lineFactory);
    lineParts.push(lineFactory.space(
        lineFactory.budget.maxGeneratedColumnsPerLine
    ));
    lineParts.push(lineFactory.space(1));
    var lineRoot = lineFactory.concat(lineParts);
    var lineResult = invariantApi.validateLayoutDoc(analysis, lineRoot);
    assert.strictEqual(lineResult.ok, false);
    assert.ok(lineResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET' &&
            /one physical line/i.test(failure.message);
    }), 'individually legal spaces must not exceed the aggregate line budget');

    var totalFactory = factoryApi.createLayoutDocFactory(analysis);
    var totalParts = canonicalCoverageDocs(totalFactory);
    var generatedPerRound =
        totalFactory.budget.maxGeneratedColumnsPerLine + 1;
    var rounds = Math.floor(
        totalFactory.budget.maxGeneratedWhitespaceCodeUnits /
            generatedPerRound
    ) + 1;
    for (var index = 0; index < rounds; index++) {
        totalParts.push(totalFactory.space(
            totalFactory.budget.maxGeneratedColumnsPerLine
        ));
        totalParts.push(totalFactory.hardLine());
    }
    var totalRoot = totalFactory.concat(totalParts);
    var totalResult = invariantApi.validateLayoutDoc(analysis, totalRoot);
    assert.strictEqual(totalResult.ok, false);
    assert.ok(totalResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET' &&
            /total generated-whitespace budget/i.test(failure.message);
    }), 'line resets must not bypass the total generated whitespace budget');

    var indentFactory = factoryApi.createLayoutDocFactory(analysis);
    var indentParts = canonicalCoverageDocs(indentFactory);
    for (var line = 0; line < 100; line++) {
        indentParts.push(indentFactory.hardLine());
    }
    var indentContent = indentFactory.concat(indentParts);
    var deeplyIndented = indentFactory.indent(
        indentFactory.budget.maxCumulativeIndentLevels,
        indentContent
    );
    var indentResult = invariantApi.validateLayoutDoc(analysis, deeplyIndented);
    assert.strictEqual(indentResult.ok, false);
    assert.ok(indentResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET' &&
            /total generated-whitespace budget/i.test(failure.message);
    }), 'indent prefixes after breaks must count toward the total budget');

    var sourceLines = [];
    for (var sourceLine = 0; sourceLine < 100; sourceLine++) {
        sourceLines.push('-- source-line-' + sourceLine);
    }
    var sourceBreakAnalysis = analyze(sourceLines.join('\n') + '\nSELECT 1');
    var sourceBreakFactory = factoryApi.createLayoutDocFactory(
        sourceBreakAnalysis
    );
    var sourceBreakContent = fullCanonicalRoot(sourceBreakFactory);
    var sourceBreakIndented = sourceBreakFactory.indent(
        sourceBreakFactory.budget.maxCumulativeIndentLevels,
        sourceBreakContent
    );
    var sourceBreakResult = invariantApi.validateLayoutDoc(
        sourceBreakAnalysis,
        sourceBreakIndented
    );
    assert.strictEqual(sourceBreakResult.ok, false);
    assert.ok(sourceBreakResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET' &&
            /total generated-whitespace budget/i.test(failure.message);
    }), 'source-derived line endings must budget the active indent prefix');

    var prefixFactory = factoryApi.createLayoutDocFactory(analysis);
    var prefixParts = canonicalCoverageDocs(prefixFactory);
    prefixParts.push(prefixFactory.hardLine());
    var prefixContent = prefixFactory.concat(prefixParts);
    var aligned = prefixFactory.align(
        prefixFactory.budget.maxGeneratedColumnsPerLine,
        prefixContent
    );
    var indentedAndAligned = prefixFactory.indent(1, aligned);
    var prefixResult = invariantApi.validateLayoutDoc(
        analysis,
        indentedAndAligned
    );
    assert.strictEqual(prefixResult.ok, false);
    assert.ok(prefixResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET' &&
            /line prefix|generated-column/i.test(failure.message);
    }), 'indent and align prefixes must share the per-line column budget');
})();

(function testRepeatedVerbatimOverlapStopsBeforeRangeRescan() {
    var columns = [];
    for (var index = 0; index < 1200; index++) {
        columns.push('c' + index);
    }
    var analysis = analyze(
        'SELECT ' + columns.join(', ') + ' FROM t QUALIFY c0 = 1',
        'generic'
    );
    var factory = factoryApi.createLayoutDocFactory(analysis);
    assert.strictEqual(factory.verbatimClaims.length, 1);
    var claim = factory.verbatimClaims[0];
    var docs = [];
    for (var ordinal = 0; ordinal < 1000; ordinal++) {
        docs.push(factory.verbatim(claim.ownerNodeId, claim.trigger));
    }
    var root = factory.concat(docs);
    var started = process.hrtime.bigint();
    var result = invariantApi.validateLayoutDoc(analysis, root);
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'LAYOUT_SOURCE_ORDER';
    }));
    assert.ok(result.emittedSourceLeafCount <= analysis.leaves.length,
        'overlapping ranges must not rescan or recount their full leaf ranges');
    assert.ok(elapsedMs < 500,
        'repeated overlap validation must stay bounded, got ' + elapsedMs.toFixed(2) + 'ms');
})();

(function testForgedMutableCyclicAndProxyGraphsFailWithoutInspectionEffects() {
    var analysis = analyze('SELECT 1');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    var canonical = fullCanonicalRoot(factory);
    assert.strictEqual(
        invariantApi.validateLayoutDoc(analysis, Object.assign({}, canonical)).ok,
        false,
        'plain doc clone must not inherit provenance'
    );

    var cycle = { kind: 'group', mode: 'flat' };
    cycle.content = cycle;
    assert.doesNotThrow(function() {
        assert.strictEqual(invariantApi.validateLayoutDoc(analysis, cycle).ok, false);
    });

    var reads = 0;
    var accessor = {};
    Object.defineProperty(accessor, 'kind', {
        get: function() {
            reads += 1;
            throw new Error('must not run');
        }
    });
    assert.strictEqual(invariantApi.validateLayoutDoc(analysis, accessor).ok, false);
    assert.strictEqual(reads, 0);
    assert.strictEqual(
        invariantApi.validateLayoutDoc(analysis, new Proxy({}, {})).ok,
        false
    );
    var revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.doesNotThrow(function() {
        assert.strictEqual(
            invariantApi.validateLayoutDoc(analysis, revoked.proxy).ok,
            false
        );
    });
})();

(function testCoverageOrderAndFlatSafetyFailClosed() {
    var analysis = analyze('SELECT 1 FROM t;', 'generic');
    var options = canonicalOptions('generic');

    var missingFactory = factoryApi.createLayoutDocFactory(analysis);
    var missing = missingFactory.leaf(0, 'raw');
    assert.ok(missing);
    var missingResult = artifactApi.createLayoutArtifact(
        analysis,
        missing,
        options
    );
    assert.strictEqual(missingResult.ok, false);
    assert.strictEqual(missingResult.code, 'LAYOUT_ARTIFACT_DOC');
    assert.ok(missingResult.invariantFailures.some(function(failure) {
        return failure.code === 'LAYOUT_SOURCE_MISSING';
    }));

    var reverseFactory = factoryApi.createLayoutDocFactory(analysis);
    var reverseDocs = canonicalCoverageDocs(reverseFactory).reverse();
    var reverseRoot = reverseFactory.concat(reverseDocs);
    var reverse = invariantApi.validateLayoutDoc(analysis, reverseRoot);
    assert.strictEqual(reverse.ok, false);
    assert.ok(reverse.failures.some(function(failure) {
        return failure.code === 'LAYOUT_SOURCE_ORDER';
    }));

    var flatFactory = factoryApi.createLayoutDocFactory(analysis);
    var rawRoot = fullCanonicalRoot(flatFactory);
    var hardLine = flatFactory.hardLine();
    var flat = flatFactory.group('flat', hardLine);
    var combined = flatFactory.concat([rawRoot, flat]);
    var flatResult = invariantApi.validateLayoutDoc(analysis, combined);
    assert.strictEqual(flatResult.ok, false);
    assert.ok(flatResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_FLAT_MULTILINE';
    }));

    var multilineAnalysis = analyze('SELECT\n1');
    var multilineFactory = factoryApi.createLayoutDocFactory(multilineAnalysis);
    var multilineRoot = fullCanonicalRoot(multilineFactory);
    var flatMultiline = multilineFactory.group('flat', multilineRoot);
    var multilineResult = invariantApi.validateLayoutDoc(
        multilineAnalysis,
        flatMultiline
    );
    assert.strictEqual(multilineResult.ok, false);
    assert.ok(multilineResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_FLAT_MULTILINE';
    }));

    var commentSource = '-- leading\nSELECT 1 FROM t';
    var commentAnalysis = analyze(commentSource, 'generic');
    var commentLeaf = commentAnalysis.leaves.find(function(leaf) {
        return leaf.kind === 'line-comment';
    });
    assert.ok(commentLeaf);
    var optionalCommentTrivia = commentAnalysis.leaves.filter(function(leaf) {
        return leaf.id !== commentLeaf.id &&
            (leaf.kind === 'whitespace' || leaf.kind === 'newline');
    }).map(function(leaf) {
        return leaf.id;
    });

    var sameFlatFactory = factoryApi.createLayoutDocFactory(commentAnalysis);
    var sameFlatParts = [
        sameFlatFactory.leaf(commentLeaf.id, 'raw')
    ].concat(canonicalCoverageDocs(
        sameFlatFactory,
        [commentLeaf.id].concat(optionalCommentTrivia)
    ));
    var sameFlatContent = sameFlatFactory.concat(sameFlatParts);
    var sameFlatRoot = sameFlatFactory.group('flat', sameFlatContent);
    var sameFlatResult = invariantApi.validateLayoutDoc(
        commentAnalysis,
        sameFlatRoot
    );
    assert.strictEqual(sameFlatResult.ok, false);
    assert.ok(sameFlatResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_FLAT_MULTILINE' &&
            /implicit break.*line comment/i.test(failure.message);
    }), 'one flat scope cannot omit the newline after a raw line comment');

    var boundaryFlatFactory = factoryApi.createLayoutDocFactory(commentAnalysis);
    var boundaryComment = boundaryFlatFactory.leaf(commentLeaf.id, 'raw');
    var boundaryContent = boundaryFlatFactory.concat(
        canonicalCoverageDocs(
            boundaryFlatFactory,
            [commentLeaf.id].concat(optionalCommentTrivia)
        )
    );
    var boundaryFlat = boundaryFlatFactory.group('flat', boundaryContent);
    var boundaryRoot = boundaryFlatFactory.concat([
        boundaryComment,
        boundaryFlat
    ]);
    assert.strictEqual(
        invariantApi.validateLayoutDoc(commentAnalysis, boundaryRoot).ok,
        true,
        'a forced break before entering a new flat scope is valid'
    );

    var eofCommentAnalysis = analyze('-- eof');
    var eofCommentFactory = factoryApi.createLayoutDocFactory(eofCommentAnalysis);
    var eofCommentRoot = eofCommentFactory.group(
        'flat',
        fullCanonicalRoot(eofCommentFactory)
    );
    assert.strictEqual(
        invariantApi.validateLayoutDoc(eofCommentAnalysis, eofCommentRoot).ok,
        true,
        'an EOF raw line comment must not synthesize a final LF'
    );

    var nestedBreakFactory = factoryApi.createLayoutDocFactory(analysis);
    var nestedBreakCoverage = fullCanonicalRoot(nestedBreakFactory);
    var nestedBreakSoftLine = nestedBreakFactory.softLine('space');
    var nestedForcedBreak = nestedBreakFactory.group(
        'break',
        nestedBreakSoftLine
    );
    var flatAroundBreak = nestedBreakFactory.group('flat', nestedForcedBreak);
    var nestedBreakRoot = nestedBreakFactory.concat([
        nestedBreakCoverage,
        flatAroundBreak
    ]);
    var nestedBreakResult = invariantApi.validateLayoutDoc(
        analysis,
        nestedBreakRoot
    );
    assert.strictEqual(nestedBreakResult.ok, false);
    assert.ok(nestedBreakResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_FLAT_MULTILINE';
    }), 'forced-break group nested in flat group must fail closed');

    var nestedFlatFactory = factoryApi.createLayoutDocFactory(analysis);
    var nestedFlatCoverage = fullCanonicalRoot(nestedFlatFactory);
    var nestedFlatSoftLine = nestedFlatFactory.softLine('space');
    var nestedForcedFlat = nestedFlatFactory.group('flat', nestedFlatSoftLine);
    var breakAroundFlat = nestedFlatFactory.group('break', nestedForcedFlat);
    var nestedFlatRoot = nestedFlatFactory.concat([
        nestedFlatCoverage,
        breakAroundFlat
    ]);
    assert.strictEqual(
        invariantApi.validateLayoutDoc(analysis, nestedFlatRoot).ok,
        true,
        'forced-flat child remains flat inside a break group'
    );
})();

(function testGraphAndIndentBudgetsAreCheckedIteratively() {
    var analysis = analyze('SELECT 1');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    var root = fullCanonicalRoot(factory);
    var wrappers = factory.budget.maxGraphNesting;
    for (var index = 0; index < wrappers; index++) {
        root = factory.group('break', root);
        assert.ok(root, 'factory node budget should exceed graph-depth budget');
    }
    var result;
    assert.doesNotThrow(function() {
        result = invariantApi.validateLayoutDoc(analysis, root);
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET';
    }));

    var indentFactory = factoryApi.createLayoutDocFactory(analysis);
    var indented = fullCanonicalRoot(indentFactory);
    var indentWrappers = indentFactory.budget.maxCumulativeIndentLevels + 1;
    for (var ordinal = 0; ordinal < indentWrappers; ordinal++) {
        indented = indentFactory.indent(1, indented);
        assert.ok(indented);
    }
    var indentResult = invariantApi.validateLayoutDoc(analysis, indented);
    assert.strictEqual(indentResult.ok, false);
    assert.ok(indentResult.failures.some(function(failure) {
        return failure.code === 'LAYOUT_RESOURCE_BUDGET';
    }));
})();

(function testCrossAnalysisFactoryAndOptionsClonesFailClosed() {
    var first = analyze('SELECT 1');
    var second = analyze('SELECT 2');
    var firstFactory = factoryApi.createLayoutDocFactory(first);
    var secondFactory = factoryApi.createLayoutDocFactory(second);
    var firstRoot = fullCanonicalRoot(firstFactory);

    assert.strictEqual(secondFactory.concat([firstRoot]), null,
        'cross-factory child must be rejected before construction');
    assert.strictEqual(
        artifactApi.createLayoutArtifact(second, firstRoot, canonicalOptions()).ok,
        false,
        'cross-analysis root must fail'
    );
    var options = canonicalOptions();
    var clonedOptions = Object.assign({}, options);
    var noncanonical = artifactApi.createLayoutArtifact(first, firstRoot, clonedOptions);
    assert.strictEqual(noncanonical.ok, false);
    assert.strictEqual(noncanonical.code, 'LAYOUT_ARTIFACT_OPTIONS');

    var postgresOptions = canonicalOptions('postgresql');
    var wrongDialect = artifactApi.createLayoutArtifact(
        first,
        firstRoot,
        postgresOptions
    );
    assert.strictEqual(wrongDialect.ok, false);
    assert.strictEqual(wrongDialect.code, 'LAYOUT_ARTIFACT_DIALECT');
})();

(function testPreservedAndClonedAnalysisCannotCreateFactory() {
    var preserved = analysisApi.analyzeSql("SELECT 'unterminated", {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(preserved.status, 'preserved');
    assert.strictEqual(factoryApi.createLayoutDocFactory(preserved), null);

    var analyzed = analyze('SELECT 1');
    assert.strictEqual(
        factoryApi.createLayoutDocFactory(Object.assign({}, analyzed)),
        null
    );
})();

(function testEmptySourceUsesCanonicalEmptyConcat() {
    var analysis = analyze('');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    assert.strictEqual(factory.leaf(0, 'raw'), null);
    var empty = factory.empty();
    var created = artifactApi.createLayoutArtifact(
        analysis,
        empty,
        canonicalOptions()
    );
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.artifact.root.kind, 'concat');
    assert.strictEqual(created.artifact.root.parts.length, 0);
})();

console.log('v2 Wave 3A LayoutDoc factory/artifact invariant tests passed');
