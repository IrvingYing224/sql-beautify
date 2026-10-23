'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/analyze.js');
var factoryApi = require('../../.tmp/v2-core/core/layout/doc-factory.js');
var limits = require('../../.tmp/v2-core/core/layout/resource-limits.js');
var budgets = require('../../.tmp/v2-core/core/layout/resource-budget.js');

function analyze(source, dialect) {
    var output = analysisApi.analyzeSql(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    assert.strictEqual(output.status, 'analyzed', 'fixture must be analyzable');
    return output;
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

(function testEmptyInputUsesOneUnitFloor() {
    var budget = budgets.createLayoutResourceBudget(0, 0, 0);
    assert.ok(budget);
    assert.strictEqual(Object.isFrozen(budget), true);
    assert.deepStrictEqual(budget, {
        inputUnits: 1,
        sourceLength: 0,
        maxDocNodes: 88,
        maxPlanActions: 80,
        maxGraphNesting: 65,
        maxCumulativeIndentLevels: 33,
        maxPendingLineSuffixes: 1,
        maxGeneratedColumnsPerLine: 260,
        maxGeneratedWhitespaceCodeUnits: 4128,
        maxOutputCodeUnits: 4128
    });
})();

(function testFormulaUsesLeavesPlusNodes() {
    var budget = budgets.createLayoutResourceBudget(100, 2, 3);
    assert.ok(budget);
    assert.strictEqual(budget.inputUnits, 5);
    assert.strictEqual(budget.maxDocNodes, 184);
    assert.strictEqual(budget.maxPlanActions, 144);
    assert.strictEqual(budget.maxGeneratedColumnsPerLine, 276);
    assert.strictEqual(budget.maxGeneratedWhitespaceCodeUnits, 4456);
    assert.strictEqual(budget.maxOutputCodeUnits, 4556);
})();

(function testCapsAreDeterministic() {
    var budget = budgets.createLayoutResourceBudget(50000, 5000, 5000);
    assert.ok(budget);
    assert.strictEqual(budget.maxGraphNesting, 4096);
    assert.strictEqual(budget.maxCumulativeIndentLevels, 512);
    assert.strictEqual(budget.maxPendingLineSuffixes, 4096);
})();

(function testInvalidAndOverflowInputsFailClosed() {
    [
        [-1, 0, 0],
        [0, -1, 0],
        [0, 0, -1],
        [0.5, 0, 0],
        [0, NaN, 0],
        [0, 0, Infinity],
        [Number.MAX_SAFE_INTEGER, 1, 1],
        [0, Number.MAX_SAFE_INTEGER, 1],
        [0, Math.floor((Number.MAX_SAFE_INTEGER - 64) / 24) + 1, 0],
        [Math.floor(Number.MAX_SAFE_INTEGER / 3), 1, 0]
    ].forEach(function(args) {
        assert.strictEqual(
            budgets.createLayoutResourceBudget(args[0], args[1], args[2]),
            null,
            'invalid budget input must fail: ' + JSON.stringify(args)
        );
    });
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
    var overflowing = limits.checkLayoutResources(analysis, overflowingRoot);
    assert.strictEqual(overflowing.ok, false);
    assert.ok(/line-suffix budget/i.test(overflowing.message));

    var boundedFactory = factoryApi.createLayoutDocFactory(analysis);
    var boundedParts = suffixParts(boundedFactory, true);
    var boundedRoot = boundedFactory.concat(boundedParts);
    var bounded = limits.checkLayoutResources(analysis, boundedRoot);
    assert.strictEqual(
        bounded.ok,
        true,
        'distributed suffixes must use concurrent pending count: ' +
            bounded.message
    );
})();

(function testImplicitLineCommentBreaksConsumeTheRealPrefixBudget() {
    function suffixRoot(factory, analysis) {
        var parts = [];
        analysis.leaves.forEach(function(leaf) {
            if (leaf.kind === 'whitespace' || leaf.kind === 'newline') {
                return;
            }
            var binding = analysis.index.commentBinding(leaf.id);
            var doc = binding !== null && binding.placement === 'trailing'
                ? factory.lineSuffix(leaf.id, null)
                : factory.leaf(leaf.id, 'raw');
            assert.ok(doc, 'missing doc for leaf ' + leaf.id + ':' + leaf.kind);
            parts.push(doc);
        });
        return factory.concat(parts);
    }

    var statements = [];
    for (var index = 0; index < 100; index++) {
        statements.push('SELECT 1 FROM t; -- c' + index);
    }
    var analysis = analyze(statements.join('\n') + '\nSELECT 1 FROM t');
    var factory = factoryApi.createLayoutDocFactory(analysis);
    assert.deepStrictEqual(factory.verbatimClaims, []);
    var root = factory.indent(
        factory.budget.maxCumulativeIndentLevels,
        suffixRoot(factory, analysis)
    );
    var result = limits.checkLayoutResources(analysis, root);
    assert.strictEqual(result.ok, false);
    assert.ok(/total generated-whitespace budget/i.test(result.message),
        'implicit breaks before later source must include the active indent prefix');

    var blockChunks = ['SELECT 0'];
    for (var block = 0; block < 4097; block++) {
        blockChunks.push(' /* b' + block + ' */ + ' + (block + 1));
    }
    var blockAnalysis = analyze(blockChunks.join('') + ' FROM t');
    var blockFactory = factoryApi.createLayoutDocFactory(blockAnalysis);
    assert.deepStrictEqual(blockFactory.verbatimClaims, []);
    assert.strictEqual(blockFactory.budget.maxPendingLineSuffixes, 4096);
    var blockResult = limits.checkLayoutResources(
        blockAnalysis,
        suffixRoot(blockFactory, blockAnalysis)
    );
    assert.strictEqual(blockResult.ok, true, blockResult.message);
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
    var lineResult = limits.checkLayoutResources(analysis, lineRoot);
    assert.strictEqual(lineResult.ok, false);
    assert.ok(/one physical line/i.test(lineResult.message), 'individually legal spaces must not exceed the aggregate line budget');

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
    var totalResult = limits.checkLayoutResources(analysis, totalRoot);
    assert.strictEqual(totalResult.ok, false);
    assert.ok(/total generated-whitespace budget/i.test(totalResult.message), 'line resets must not bypass the total generated whitespace budget');

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
    var indentResult = limits.checkLayoutResources(analysis, deeplyIndented);
    assert.strictEqual(indentResult.ok, false);
    assert.ok(/total generated-whitespace budget/i.test(indentResult.message), 'indent prefixes after breaks must count toward the total budget');

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
    var sourceBreakResult = limits.checkLayoutResources(
        sourceBreakAnalysis,
        sourceBreakIndented
    );
    assert.strictEqual(sourceBreakResult.ok, false);
    assert.ok(/total generated-whitespace budget/i.test(sourceBreakResult.message), 'source-derived line endings must budget the active indent prefix');

    var prefixFactory = factoryApi.createLayoutDocFactory(analysis);
    var prefixParts = canonicalCoverageDocs(prefixFactory);
    prefixParts.push(prefixFactory.hardLine());
    var prefixContent = prefixFactory.concat(prefixParts);
    var aligned = prefixFactory.align(
        prefixFactory.budget.maxGeneratedColumnsPerLine,
        prefixContent
    );
    var indentedAndAligned = prefixFactory.indent(1, aligned);
    var prefixResult = limits.checkLayoutResources(
        analysis,
        indentedAndAligned
    );
    assert.strictEqual(prefixResult.ok, false);
    assert.ok(/line prefix|generated-column/i.test(prefixResult.message), 'indent and align prefixes must share the per-line column budget');
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
        result = limits.checkLayoutResources(analysis, root);
    });
    assert.strictEqual(result.ok, false);
    assert.ok(/nesting budget/.test(result.message), result.message);

    var indentFactory = factoryApi.createLayoutDocFactory(analysis);
    var indented = fullCanonicalRoot(indentFactory);
    var indentWrappers = indentFactory.budget.maxCumulativeIndentLevels + 1;
    for (var ordinal = 0; ordinal < indentWrappers; ordinal++) {
        indented = indentFactory.indent(1, indented);
        assert.ok(indented);
    }
    var indentResult = limits.checkLayoutResources(analysis, indented);
    assert.strictEqual(indentResult.ok, false);
    assert.ok(/cumulative indent budget/.test(indentResult.message), indentResult.message);
})();

console.log('v2 Wave 3A layout resource budget tests passed');
