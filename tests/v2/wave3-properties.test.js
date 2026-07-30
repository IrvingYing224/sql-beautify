'use strict';

var assert = require('assert');
var crypto = require('crypto');

var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var alignmentApi = require('../../.tmp/v2-core/core/layout/alignment-policy.js');
var compilerApi = require('../../.tmp/v2-core/core/layout/compiler.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var invariantApi = require('../../.tmp/v2-core/core/layout/invariants.js');
var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
var policyApi = require('../../.tmp/v2-core/core/layout/policy.js');
var rendererApi = require('../../.tmp/v2-core/core/renderer/render.js');
var claimsApi = require('../../.tmp/v2-core/core/layout/verbatim-claims.js');

var layoutCases = require('../fixtures/v2-layout-cases');
var queryCases = require('../fixtures/v2-wave3c-hive-query-cases');
var expressionCases = require('../fixtures/v2-wave3d-expression-cases');
var parserCases = require('../fixtures/v2-sql-corpus-cases');
var closureCases = require('../fixtures/v2-wave3-corpus-cases');
var productionCorpus = require('./helpers/production-corpus');
var formatterFuzz = require('./helpers/formatter-fuzz-cases');

var publicSqlCases = productionCorpus.load_public_cases().filter(function(testCase) {
    return testCase.operation === 'formatSql';
});
var expectedCorpusSize = [
    layoutCases,
    queryCases,
    expressionCases,
    parserCases,
    closureCases,
    publicSqlCases
].reduce(function(total, values) { return total + values.length; }, 0);

function normalizedOptions(value) {
	return Object.assign({}, value || {});
}

function lexedRows(source, dialect) {
    return lexerApi.lexSql(source, { dialect: dialect }).leaves.filter(function(leaf) {
        return leaf.kind !== 'whitespace' && leaf.kind !== 'newline';
    });
}

function protectedRows(source, dialect) {
    return lexerApi.lexSql(source, { dialect: dialect }).leaves.filter(function(leaf) {
        return leaf.channel === 'protected' ||
            leaf.kind === 'line-comment' ||
            leaf.kind === 'block-comment';
    }).map(function(leaf) {
        return [leaf.kind, leaf.channel, leaf.raw];
    });
}

function assertTokenEquivalent(id, source, output, dialect) {
    var before = lexedRows(source, dialect);
    var after = lexedRows(output, dialect);
    assert.strictEqual(after.length, before.length, id + ' non-trivia token count');
    before.forEach(function(leaf, index) {
        var outputLeaf = after[index];
        assert.strictEqual(outputLeaf.kind, leaf.kind, id + ' token kind ' + index);
        assert.strictEqual(outputLeaf.channel, leaf.channel,
            id + ' token channel ' + index);
        if (outputLeaf.raw !== leaf.raw) {
            assert.strictEqual(leaf.kind, 'keyword',
                id + ' only contextual keywords may change raw at ' + index);
            assert.strictEqual(outputLeaf.raw.toLowerCase(), leaf.raw.toLowerCase(),
                id + ' keyword case transform ' + index);
        }
    });
}

function asciiCaseEquivalent(source, output) {
    if (source.length !== output.length) {
        return false;
    }
    for (var index = 0; index < source.length; index++) {
        var sourceCode = source.charCodeAt(index);
        var outputCode = output.charCodeAt(index);
        if (sourceCode === outputCode) {
            continue;
        }
        var sourceIsAsciiLetter =
            (sourceCode >= 65 && sourceCode <= 90) ||
            (sourceCode >= 97 && sourceCode <= 122);
        var outputIsAsciiLetter =
            (outputCode >= 65 && outputCode <= 90) ||
            (outputCode >= 97 && outputCode <= 122);
        if (!sourceIsAsciiLetter || !outputIsAsciiLetter ||
            String.fromCharCode(sourceCode).toLowerCase() !==
                String.fromCharCode(outputCode).toLowerCase()) {
            return false;
        }
    }
    return true;
}

function assertSourceMap(id, source, result, analysis) {
    assert.ok(result.sourceMap, id + ' safe result source map');
    assert.strictEqual(Object.isFrozen(result.sourceMap), true, id + ' frozen map');
    assert.strictEqual(Object.isFrozen(result.sourceMap.entries), true,
        id + ' frozen map entries');
    var previousSourceEnd = 0;
    var previousOutputEnd = 0;
    assert.ok(result.sourceMap.entries.length > 0, id + ' non-empty source map');
    result.sourceMap.entries.forEach(function(entry, index) {
        assert.strictEqual(Object.isFrozen(entry), true,
            id + ' frozen source map entry ' + index);
        assert.strictEqual(Object.isFrozen(entry.source), true,
            id + ' frozen source map source span ' + index);
        assert.strictEqual(Object.isFrozen(entry.output), true,
            id + ' frozen source map output span ' + index);
        assert.ok(entry.source.start >= previousSourceEnd,
            id + ' monotonic source map source ' + index);
        assert.ok(entry.output.start >= previousOutputEnd,
            id + ' monotonic source map output ' + index);
        assert.ok(entry.source.start >= 0 && entry.source.end <= source.length &&
            entry.source.end >= entry.source.start,
        id + ' source map source bounds ' + index);
        assert.ok(entry.output.start >= 0 && entry.output.end <= result.text.length &&
            entry.output.end >= entry.output.start,
        id + ' source map output bounds ' + index);
        assert.ok(entry.source.end > entry.source.start,
            id + ' source map entries must not be empty ' + index);
        assert.strictEqual(
            entry.source.end - entry.source.start,
            entry.output.end - entry.output.start,
            id + ' source map exact byte-run width ' + index
        );
        var sourceSlice = source.slice(entry.source.start, entry.source.end);
        var outputSlice = result.text.slice(entry.output.start, entry.output.end);
        if (outputSlice !== sourceSlice) {
            assert.strictEqual(
                asciiCaseEquivalent(sourceSlice, outputSlice),
                true,
                id + ' mapped transform must be ASCII case-only ' + index
            );
            for (var offset = 0; offset < sourceSlice.length; offset++) {
                if (sourceSlice[offset] === outputSlice[offset]) {
                    continue;
                }
                var location = analysis.index.offsetToLeaf(
                    entry.source.start + offset
                );
                assert.ok(location && location.atEnd === false,
                    id + ' transformed code unit must map to a source leaf ' + index);
                var syntax = analysis.index.leafContext(location.leafId).syntax;
                assert.ok(syntax && syntax.keywordCaseEligible === true,
                    id + ' transformed code unit must be contextual keyword case ' +
                        index);
            }
        }
        previousSourceEnd = entry.source.end;
        previousOutputEnd = entry.output.end;
    });
}

function assertOpaqueClaims(id, source, result, analysis) {
    var claims = claimsApi.dominatingVerbatimClaims(analysis);
    assert.ok(claims, id + ' canonical verbatim claims');
    claims.claims.forEach(function(claim, claimIndex) {
        var firstLeaf = analysis.leaves[claim.leafRange.start];
        var lastLeaf = analysis.leaves[claim.leafRange.end - 1];
        assert.ok(firstLeaf && lastLeaf, id + ' claim leaf bounds ' + claimIndex);
        var sourceStart = firstLeaf.span.start;
        var sourceEnd = lastLeaf.span.end;
        var sourceCursor = sourceStart;
        var outputStart = null;
        var outputCursor = null;
        result.sourceMap.entries.forEach(function(entry) {
            if (sourceCursor >= sourceEnd || entry.source.end <= sourceCursor ||
                entry.source.start >= sourceEnd) {
                return;
            }
            var overlapStart = Math.max(sourceCursor, entry.source.start);
            var overlapEnd = Math.min(sourceEnd, entry.source.end);
            assert.strictEqual(overlapStart, sourceCursor,
                id + ' opaque claim has an unmapped source gap ' + claimIndex);
            var mappedOutputStart = entry.output.start +
                (overlapStart - entry.source.start);
            var mappedOutputEnd = mappedOutputStart + (overlapEnd - overlapStart);
            if (outputCursor === null) {
                outputStart = mappedOutputStart;
            } else {
                assert.strictEqual(mappedOutputStart, outputCursor,
                    id + ' opaque claim has a generated output gap ' + claimIndex);
            }
            outputCursor = mappedOutputEnd;
            sourceCursor = overlapEnd;
        });
        assert.strictEqual(sourceCursor, sourceEnd,
            id + ' opaque claim must map continuously ' + claimIndex);
        assert.notStrictEqual(outputStart, null,
            id + ' opaque claim must have an output start ' + claimIndex);
        assert.notStrictEqual(outputCursor, null,
            id + ' opaque claim must have an output end ' + claimIndex);
        assert.strictEqual(
            result.text.slice(outputStart, outputCursor),
            source.slice(sourceStart, sourceEnd),
            id + ' opaque/verbatim bytes must be exact ' + claimIndex
        );
    });
    return claims.claims.length;
}

function assertFormatProperties(testCase) {
    var id = testCase.id;
    var source = testCase.source;
    var options = normalizedOptions(testCase.options);
    var dialect = options.dialect || 'hive';
    var first = formatApi.formatSqlWithStatistics(source, options);
    var deterministic = formatApi.formatSqlWithStatistics(source, options);
    assert.deepStrictEqual(deterministic, first, id + ' deterministic result/map/stats');
    assert.strictEqual(Object.isFrozen(first), true, id + ' frozen run');
    assert.strictEqual(Object.isFrozen(first.result), true, id + ' frozen result');
    assert.strictEqual(Object.isFrozen(first.statistics), true, id + ' frozen statistics');

    var safe = first.result.status === 'formatted' || first.result.status === 'unchanged';
    var expectedOutcome = testCase.expectedOutcome || 'safe';
    assert.ok(
        expectedOutcome === 'safe' ||
            expectedOutcome === 'original' ||
            expectedOutcome === 'either-local-recovery',
        id + ' must declare a supported outcome contract'
    );
    if (expectedOutcome === 'safe') {
        assert.strictEqual(safe, true,
            id + ' required-safe case must remain formatted/unchanged');
    } else if (expectedOutcome === 'original') {
        assert.strictEqual(safe, false,
            id + ' lexical-fatal/unsupported case must return original text');
    }
    var opaqueClaimCount = 0;
    if (safe) {
        var analysis = analysisApi.analyzeSql(source, {
            dialect: dialect,
            mode: 'document'
        });
        assert.strictEqual(analysis.status, 'analyzed', id + ' canonical analysis');
        assertSourceMap(id, source, first.result, analysis);
        assert.deepStrictEqual(
            protectedRows(first.result.text, dialect),
            protectedRows(source, dialect),
            id + ' protected/comment exactness'
        );
        assertTokenEquivalent(id, source, first.result.text, dialect);
        assert.strictEqual(
            first.statistics.equivalenceComparisonCount,
            lexedRows(source, dialect).length,
            id + ' token-equivalence must compare every non-trivia source leaf'
        );
        assert.strictEqual(first.statistics.equivalenceDiagnosticVisitCount, 0,
            id + ' rendered output must lex without diagnostics');
        opaqueClaimCount = assertOpaqueClaims(
            id,
            source,
            first.result,
            analysis
        );
    } else {
        assert.strictEqual(first.result.text, source,
            id + ' preserved/failed result must return original text');
        assert.strictEqual(first.result.sourceMap, undefined,
            id + ' preserved/failed result must not expose a source map');
    }

    var repeated = formatApi.formatSqlWithStatistics(first.result.text, options);
    assert.strictEqual(repeated.result.text, first.result.text,
        id + ' strict idempotency');
    if (first.result.status === 'formatted' || first.result.status === 'unchanged') {
        assert.strictEqual(repeated.result.status, 'unchanged',
            id + ' second safe pass status');
    } else {
        assert.strictEqual(repeated.result.status, first.result.status,
            id + ' deterministic original-text status');
    }
    return { safe: safe, opaqueClaimCount: opaqueClaimCount };
}

function corpusCases() {
    var cases = [];
    function append(prefix, values, optionsOf) {
        values.forEach(function(value) {
            var details = optionsOf(value);
            cases.push({
                id: prefix + '/' + value.id,
                source: value.source,
                options: details.options || details,
                expectedOutcome: details.expectedOutcome ||
                    (details.expectSafe === false ? 'original' : 'safe')
            });
        });
    }
    append('layout', layoutCases, function(value) { return value.options; });
    append('query', queryCases, function(value) { return value.options; });
    append('expression', expressionCases, function(value) { return value.options; });
    append('parser', parserCases, function(value) {
        return {
            options: { dialect: value.dialect },
            expectedOutcome: value.expectation === 'invalid' ? 'original' : 'safe'
        };
    });
    append('closure', closureCases, function(value) {
        return {
            options: value.options,
            expectedOutcome: value.expectedOutcome
        };
    });

    publicSqlCases.forEach(function(testCase) {
        cases.push({
            id: 'production/' + testCase.name,
            source: testCase.sql,
            options: testCase.options,
            expectedOutcome: 'safe'
        });
    });
    return cases;
}

function environmentInteger(name, fallback, minimum, maximum) {
    var raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    var value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(name + ' must be an integer from ' + minimum +
            ' through ' + maximum + '; received ' + JSON.stringify(raw));
    }
    return value;
}

var formatterFuzzSeed = environmentInteger(
    'FORMATTER_FUZZ_SEED',
    formatterFuzz.DEFAULT_SEED,
    1,
    0xffffffff
);
var formatterFuzzCaseCount = environmentInteger(
    'FORMATTER_FUZZ_CASES',
    formatterFuzz.DEFAULT_CASE_COUNT,
    formatterFuzz.MIN_CASE_COUNT,
    formatterFuzz.MAX_CASE_COUNT
);

function assertFormatterFuzzCoverage(cases) {
    var combinations = new Set();
    var commentKinds = new Set();
    var protectedKinds = new Set();
    var parameterDialects = new Set();
    cases.forEach(function(testCase) {
        var dimensions = testCase.fuzzDimensions;
        combinations.add([
            dimensions.dialect,
            dimensions.leftFamily,
            dimensions.rightFamily
        ].join('/'));
        commentKinds.add(dimensions.commentKind);
        lexerApi.lexSql(testCase.source, {
            dialect: dimensions.dialect
        }).leaves.forEach(function(leaf) {
            if (leaf.channel === 'protected' ||
                leaf.kind === 'line-comment' ||
                leaf.kind === 'block-comment') {
                protectedKinds.add(leaf.kind);
            }
            if (dimensions.rightFamily === 'parameter' &&
                leaf.kind === 'parameter' && leaf.channel === 'protected') {
                parameterDialects.add(dimensions.dialect);
            }
        });
    });
    var expectedCombinations = [];
    formatterFuzz.DIALECTS.forEach(function(dialect) {
        formatterFuzz.LEFT_FAMILIES.forEach(function(leftFamily) {
            formatterFuzz.RIGHT_FAMILIES.forEach(function(rightFamily) {
                expectedCombinations.push([
                    dialect,
                    leftFamily,
                    rightFamily
                ].join('/'));
            });
        });
    });
    assert.deepStrictEqual(
        Array.from(combinations).sort(),
        expectedCombinations.sort(),
        'formatter fuzz must cover the exact 4x4x4 combination matrix'
    );
    assert.deepStrictEqual(
        Array.from(parameterDialects).sort(),
        Array.from(formatterFuzz.DIALECTS).sort(),
        'formatter fuzz must lex a native protected parameter in every dialect'
    );
    assert.deepStrictEqual(
        Array.from(commentKinds).sort(),
        ['block-comment', 'line-comment'],
        'formatter fuzz must generate both comment families'
    );
    [
        'string',
        'quoted-identifier',
        'parameter',
        'line-comment',
        'block-comment'
    ].forEach(function(kind) {
        assert.strictEqual(protectedKinds.has(kind), true,
            'formatter fuzz must exercise protected/comment kind ' + kind);
    });
    return Object.freeze({
        combinations: combinations.size,
        protectedKinds: Object.freeze(Array.from(protectedKinds).sort())
    });
}

function deterministicMalformedCases(count) {
    var dialects = ['hive', 'generic', 'postgresql', 'mysql'];
    var categories = [
        'unterminated-string',
        'unterminated-block-comment',
        'unmatched-parentheses',
        'unterminated-quoted-identifier'
    ];
    var values = [];
    for (var index = 0; index < count; index++) {
        var dialect = dialects[index % dialects.length];
        var category = categories[Math.floor(index / dialects.length) % categories.length];
        var source;
        if (category === 'unterminated-string') {
            source = "SELECT 'unterminated " + index;
        } else if (category === 'unterminated-block-comment') {
            source = 'SELECT /* unterminated ' + index;
        } else if (category === 'unmatched-parentheses') {
            source = 'SELECT ' + '('.repeat(1 + index % 24) + 'x';
        } else {
            source = dialect === 'hive' || dialect === 'mysql'
                ? 'SELECT `unterminated ' + index
                : 'SELECT "unterminated ' + index;
        }
        values.push({
            id: 'malformed/' + index,
            source: source,
            options: { dialect: dialect },
            expectedOutcome: category === 'unmatched-parentheses'
                ? 'either-local-recovery'
                : 'original',
            malformedCategory: category
        });
    }
    return values;
}

(function testCompleteCorpusAndDeterministicFuzzProperties() {
    var corpus = corpusCases();
    assert.strictEqual(corpus.length, expectedCorpusSize,
        'Wave 3 complete formatSql corpus size');
    var corpusIds = new Set();
    corpus.forEach(function(testCase) {
        assert.strictEqual(corpusIds.has(testCase.id), false,
            'Wave 3 corpus ids must be unique: ' + testCase.id);
        corpusIds.add(testCase.id);
    });
    [
        'closure/unknown-expression-local-recovery',
        'closure/structured-template-parameter'
    ].forEach(function(requiredId) {
        assert.strictEqual(corpusIds.has(requiredId), true,
            'Wave 3 inline recovery behavior must belong to the shared corpus: ' + requiredId);
    });
    var evidence = { safe: 0, original: 0, opaque: 0 };
    corpus.forEach(function(testCase) {
        var result = assertFormatProperties(testCase);
        evidence.safe += result.safe ? 1 : 0;
        evidence.original += result.safe ? 0 : 1;
        evidence.opaque += result.opaqueClaimCount;
    });
    var fuzzCases = formatterFuzz.buildDeterministicFormatterFuzzCases(
        formatterFuzzCaseCount,
        formatterFuzzSeed
    );
    var fuzzCoverage = assertFormatterFuzzCoverage(fuzzCases);
    var fuzzDigest = crypto.createHash('sha256');
    fuzzCases.forEach(function(testCase, index) {
        try {
            var result = assertFormatProperties(testCase);
            evidence.safe += result.safe ? 1 : 0;
            evidence.original += result.safe ? 0 : 1;
            evidence.opaque += result.opaqueClaimCount;
            fuzzDigest.update(JSON.stringify([
                testCase.id,
                testCase.source,
                testCase.options,
                result.safe,
                result.opaqueClaimCount
            ]));
            fuzzDigest.update('\n');
        } catch (error) {
            var detail = error && error.stack ? error.stack : String(error);
            throw new Error(
                'formatter fuzz failure seed=0x' + formatterFuzzSeed.toString(16) +
                ' FORMATTER_FUZZ_CASES=' + formatterFuzzCaseCount +
                ' caseIndex=' + index + ':\n' + detail
            );
        }
    });
    assert.ok(evidence.safe > 0, 'properties must exercise safe results');
    assert.ok(evidence.original > 0, 'properties must exercise original-text results');
    assert.ok(evidence.opaque > 0, 'properties must exercise opaque/verbatim claims');
    console.log('v2 Wave 3 deterministic formatter fuzz passed ' + JSON.stringify({
        seed: '0x' + formatterFuzzSeed.toString(16),
        cases: formatterFuzzCaseCount,
        combinations: fuzzCoverage.combinations,
        protectedKinds: fuzzCoverage.protectedKinds,
        digest: fuzzDigest.digest('hex')
    }));
})();

(function testFormatterLevelMalformedFuzzIsDeterministicAndBounded() {
    var cases = deterministicMalformedCases(48);
    var originalTextResults = 0;
    var coverage = new Set();
    cases.forEach(function(testCase) {
        coverage.add(testCase.options.dialect + '/' + testCase.malformedCategory);
        var result = assertFormatProperties(testCase);
        originalTextResults += result.safe ? 0 : 1;
    });
    var expectedCoverage = [];
    ['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialect) {
        [
            'unterminated-string',
            'unterminated-block-comment',
            'unmatched-parentheses',
            'unterminated-quoted-identifier'
        ].forEach(function(category) {
            expectedCoverage.push(dialect + '/' + category);
        });
    });
    assert.deepStrictEqual(Array.from(coverage).sort(), expectedCoverage.sort(),
        'malformed fuzz must cover the exact category/dialect matrix');
    assert.ok(originalTextResults >= 36,
        'all lexical-fatal malformed cases must exercise original-text containment');
})();

(function testDeterministicPlanDocMapAndResult() {
    function build() {
        var source = "select a as x, longer_name as y from t where a='FROM'";
        var analysis = analysisApi.analyzeSql(source, {
            dialect: 'hive',
            mode: 'document'
        });
        var resolved = optionsApi.resolveFormatOptions({ dialect: 'hive' });
        assert.strictEqual(analysis.status, 'analyzed');
        assert.strictEqual(resolved.ok, true);
        var planned = policyApi.buildLayoutPlan(analysis, resolved.options);
        assert.strictEqual(planned.ok, true);
        var compiled = compilerApi.compileLayoutPlan(planned.plan);
        assert.strictEqual(compiled.ok, true);
        var rendered = rendererApi.renderLayoutArtifact(compiled.artifact);
        assert.strictEqual(rendered.ok, true);
        var alignment = alignmentApi.deriveLayoutAlignmentPlan(
            analysis,
            resolved.options,
            rendered
        );
        assert.ok(alignment && alignment.targets.length > 0,
            'determinism fixture must execute alignment phase');
        var alignedPlan = policyApi.buildLayoutPlan(
            analysis,
            resolved.options,
            alignment
        );
        assert.strictEqual(alignedPlan.ok, true);
        var alignedCompiled = compilerApi.compileLayoutPlan(alignedPlan.plan);
        assert.strictEqual(alignedCompiled.ok, true);
        var alignedRendered = rendererApi.renderLayoutArtifact(
            alignedCompiled.artifact
        );
        assert.strictEqual(alignedRendered.ok, true);
        return {
            alignmentTargets: alignment.targets,
            leafEmissions: alignedPlan.plan.leafEmissions,
            gapActions: alignedPlan.plan.gapActions,
            scopeStarts: alignedPlan.plan.scopeStarts,
            scopeEnds: alignedPlan.plan.scopeEnds,
            planStatistics: alignedPlan.plan.statistics,
            root: alignedCompiled.artifact.root,
            rendered: alignedRendered
        };
    }
    assert.deepStrictEqual(build(), build(),
        'canonical plan/doc/source-map/render must be deterministic');
})();

(function testMalformedBoundariesAndOriginalTextFailuresFailClosed() {
    var source = 'select  1';
    var analysis = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    var resolved = optionsApi.resolveFormatOptions({ dialect: 'hive' });
    assert.strictEqual(analysis.status, 'analyzed');
    assert.strictEqual(resolved.ok, true);
    var planned = policyApi.buildLayoutPlan(analysis, resolved.options);
    assert.strictEqual(planned.ok, true);
    assert.strictEqual(compilerApi.compileLayoutPlan(Object.assign({}, planned.plan)).ok,
        false, 'cloned plan must fail closed');
    var compiled = compilerApi.compileLayoutPlan(planned.plan);
    assert.strictEqual(compiled.ok, true);
    assert.strictEqual(
        invariantApi.validateLayoutDoc(
            analysis,
            Object.assign({}, compiled.artifact.root)
        ).ok,
        false,
        'cloned doc must fail closed'
    );
    var forgedRender = rendererApi.renderLayoutArtifact(
        Object.assign({}, compiled.artifact)
    );
    assert.strictEqual(forgedRender.ok, false, 'cloned artifact must fail closed');
    assert.strictEqual(forgedRender.text, undefined,
        'renderer failure must not expose partial text');
    assert.strictEqual(forgedRender.sourceMap, undefined,
        'renderer failure must not expose a partial map');

    [
        {
            id: 'unterminated',
            source: "select 'unterminated",
            options: { dialect: 'hive' },
            mode: 'document',
            status: 'preserved'
        },
        {
            id: 'unsupported-bailout',
            source: 'select * from t qualify row_number() over()=1',
            options: { dialect: 'hive', unsupportedSyntaxPolicy: 'bail_out' },
            mode: 'document',
            status: 'preserved'
        },
        {
            id: 'proxy-options',
            source: source,
            options: new Proxy({ dialect: 'hive' }, {}),
            mode: 'document',
            status: 'failed'
        },
        {
            id: 'invalid-mode',
            source: source,
            options: { dialect: 'hive' },
            mode: 'invalid-mode',
            status: 'failed'
        }
    ].forEach(function(testCase) {
        var result = formatApi.formatSql(
            testCase.source,
            testCase.options,
            testCase.mode
        );
        assert.strictEqual(result.status, testCase.status, testCase.id + ' status');
        assert.strictEqual(result.text, testCase.source,
            testCase.id + ' original text');
        assert.strictEqual(result.sourceMap, undefined,
            testCase.id + ' no partial map');
    });
})();

console.log('v2 Wave 3 properties passed (' + expectedCorpusSize +
    ' formatSql corpus + ' + formatterFuzzCaseCount +
    ' deterministic fuzz + 48 malformed cases)');
