'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

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
var parserCases = require('../fixtures/v2-parser-evaluation-cases');
var closureCases = require('../fixtures/v2-wave3-corpus-cases');

var root = path.join(__dirname, '..', '..');

function normalizedOptions(value) {
    var options = Object.assign({}, value || {});
    if (options.dialect === 'postgres') {
        options.dialect = 'postgresql';
    }
    return options;
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

    var corpusRoot = path.join(root, 'tests', 'fixtures', 'production-corpus', 'public');
    fs.readdirSync(corpusRoot).filter(function(fileName) {
        return fileName.endsWith('.sql');
    }).sort().forEach(function(fileName) {
        var baseName = fileName.slice(0, -4);
        var optionsPath = path.join(corpusRoot, baseName + '.options.json');
        cases.push({
            id: 'production/' + baseName,
            source: fs.readFileSync(path.join(corpusRoot, fileName), 'utf8'),
            options: fs.existsSync(optionsPath)
                ? JSON.parse(fs.readFileSync(optionsPath, 'utf8'))
                : { dialect: 'hive' },
            expectedOutcome: 'safe'
        });
    });
    return cases;
}

function deterministicFuzzCases(count) {
    var state = 0x3f202607;
    function next() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
    }
    function pick(values) {
        return values[next() % values.length];
    }
    var dialects = ['hive', 'generic', 'postgresql', 'mysql'];
    var whitespace = [' ', '  ', '\n', '\t'];
    var values = [];
    for (var index = 0; index < count; index++) {
        var dialect = pick(dialects);
        var quoted = dialect === 'hive' || dialect === 'mysql'
            ? '`Mixed Name`'
            : '"Mixed Name"';
        var keyword = pick(['select', 'SELECT', 'SeLeCt']);
        var from = pick(['from', 'FROM', 'FrOm']);
        var source = keyword + pick(whitespace) +
            pick(['a+1', "'FROM  x'", quoted, 'case when a=1 then 2 else 3 end']) +
            pick(whitespace) + 'as x,' + pick(whitespace) +
            '/* fuzz ' + index + ' */' + pick(whitespace) +
            pick(['b*2', 'coalesce(b,0)', ':value', 'not flag']) +
            pick(whitespace) + 'as y' + pick(whitespace) +
            from + pick(whitespace) + 't where a=1 and b>2';
        values.push({
            id: 'fuzz/' + index,
            source: source,
            options: {
                dialect: dialect,
                keywordCase: pick(['upper', 'lower']),
                commaStyle: pick(['leading', 'trailing']),
                indentStyle: pick(['space', 'tab']),
                caseLayout: pick(['expanded', 'compactShort']),
                caseWhenThenWrapLength: 20 + next() % 80,
                maxAlignWidth: 40 + next() % 120,
                unsupportedSyntaxPolicy: pick(['warn', 'preserve', 'bail_out'])
            }
        });
    }
    return values;
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
    assert.strictEqual(corpus.length, 68, 'Wave 3 complete corpus size');
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
    corpus.concat(deterministicFuzzCases(128)).forEach(function(testCase) {
        var result = assertFormatProperties(testCase);
        evidence.safe += result.safe ? 1 : 0;
        evidence.original += result.safe ? 0 : 1;
        evidence.opaque += result.opaqueClaimCount;
    });
    assert.ok(evidence.safe > 0, 'properties must exercise safe results');
    assert.ok(evidence.original > 0, 'properties must exercise original-text results');
    assert.ok(evidence.opaque > 0, 'properties must exercise opaque/verbatim claims');
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

console.log('v2 Wave 3 properties passed (68 corpus + 128 deterministic fuzz + 48 malformed cases)');
