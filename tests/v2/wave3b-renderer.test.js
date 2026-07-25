'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var artifactApi = require('../../.tmp/v2-core/core/layout/artifact.js');
var displayApi = require('../../.tmp/v2-core/core/renderer/display-width.js');
var environmentApi = require('../../.tmp/v2-core/core/renderer/environment.js');
var factoryApi = require('../../.tmp/v2-core/core/layout/doc-factory.js');
var invariantApi = require('../../.tmp/v2-core/core/layout/invariants.js');
var metricsApi = require('../../.tmp/v2-core/core/renderer/metrics.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
var renderApi = require('../../.tmp/v2-core/core/renderer/render.js');

function canonicalOptions(input) {
    var resolved = optionsApi.resolveFormatOptions(input);
    assert.strictEqual(resolved.ok, true);
    return resolved.options;
}

function analyzed(source, mode) {
    var result = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: mode || 'document'
    });
    assert.strictEqual(result.status, 'analyzed');
    return result;
}

function artifactFrom(source, optionInput, buildRoot, mode) {
    var analysis = analyzed(source, mode);
    var factory = factoryApi.createLayoutDocFactory(analysis);
    assert.ok(factory);
    assert.deepStrictEqual(factory.verbatimClaims, [],
        'renderer fixture requires formatted no-FROM authority');
    var root = buildRoot(factory, analysis);
    assert.ok(root, 'fixture must build a canonical LayoutDoc root');
    var created = artifactApi.createLayoutArtifact(
        analysis,
        root,
        canonicalOptions(optionInput)
    );
    assert.strictEqual(created.ok, true,
        created.ok ? '' : JSON.stringify(created.invariantFailures));
    return created.artifact;
}

function codeLeaf(factory, analysis, raw) {
    var leaf = analysis.leaves.filter(function(value) {
        return value.raw === raw && value.channel !== 'trivia';
    })[0];
    assert.ok(leaf, 'missing source leaf ' + raw);
    var doc = factory.leaf(leaf.id, 'raw');
    assert.ok(doc, 'missing canonical leaf doc ' + raw);
    return doc;
}

function assertFrozenSourceMap(sourceMap) {
    assert.strictEqual(Object.isFrozen(sourceMap), true);
    assert.strictEqual(Object.isFrozen(sourceMap.entries), true);
    var previousOutputEnd = -1;
    var previousSourceEnd = -1;
    sourceMap.entries.forEach(function(entry) {
        assert.strictEqual(Object.isFrozen(entry), true);
        assert.strictEqual(Object.isFrozen(entry.output), true);
        assert.strictEqual(Object.isFrozen(entry.source), true);
        assert.ok(entry.output.start >= previousOutputEnd);
        assert.ok(entry.source.start >= previousSourceEnd);
        assert.ok(entry.output.end > entry.output.start);
        assert.ok(entry.source.end > entry.source.start);
        previousOutputEnd = entry.output.end;
        previousSourceEnd = entry.source.end;
    });
}

(function testPinnedUnicode151DisplayWidth() {
    assert.strictEqual(displayApi.UNICODE_VERSION, '15.1.0');
    [
        ['ASCII', 5],
        ['界', 2],
        ['Ａ', 2],
        ['e\u0301', 1],
        ['❤️', 2],
        ['👨‍👩‍👧‍👦', 2],
        ['🇨🇳', 2],
        ['1️⃣', 2],
        ['👍🏽', 2],
        ['\u0378', 1]
    ].forEach(function(testCase) {
        assert.strictEqual(
            displayApi.displayWidth(testCase[0]),
            testCase[1],
            JSON.stringify(testCase[0]) + ' display width'
        );
    });

    [0, 1, 2, 3].forEach(function(startColumn) {
        var measured = displayApi.measureDisplayText('\tX', startColumn);
        assert.ok(measured);
        assert.strictEqual(measured.endColumn, 5,
            'tab stop must depend on the real starting column');
        assert.strictEqual(measured.containsTab, true);
    });

    var crlf = displayApi.measureDisplayText('a\r\n界', 0);
    assert.ok(crlf);
    assert.strictEqual(crlf.lineBreakCount, 1);
    assert.strictEqual(crlf.endColumn, 2);
    assert.strictEqual(crlf.startsWithLineBreak, false);
    assert.strictEqual(crlf.endsWithLineBreak, false);
    assert.strictEqual(displayApi.displayWidth('a\r\n界'), null,
        'single-line width must be unknown for multiline text');
    assert.strictEqual(displayApi.measureDisplayText('x', -1), null);

    assert.strictEqual(displayApi.graphemeClusterCount('각'), 1,
        'Hangul L/V/T sequence must form one grapheme cluster');
    assert.strictEqual(displayApi.graphemeClusterCount('क्क'), 1,
        'Unicode 15.1 Indic conjunct rule GB9c must be implemented');
    assert.strictEqual(displayApi.graphemeClusterCount('🇨🇳🇺'), 2,
        'regional indicators must pair from the start of the run');
    assert.strictEqual(displayApi.graphemeClusterCount('\u0301'), 1);
    assert.strictEqual(displayApi.displayWidth('\u0301'), 1,
        'isolated combining input uses conservative width one');
    assert.strictEqual(displayApi.graphemeClusterCount('\uD800'), 1);
    assert.strictEqual(displayApi.displayWidth('\uD800'), 1,
        'isolated surrogate must remain deterministic and conservative');
    assert.strictEqual(displayApi.displayWidth('❤'), 1,
        'text-default emoji without VS16 remains width one');
    assert.strictEqual(displayApi.displayWidth('❤︎'), 1,
        'text variation selector must not force emoji width');

    [
        ['GB3 CR x LF', '\r\n', 1],
        ['GB4 control break', '\u0000A', 2],
        ['GB6 Hangul L x V', '\u1100\u1161', 1],
        ['GB7 Hangul V x T', '\uAC00\u11A8', 1],
        ['GB8 Hangul T x T', '\uAC01\u11A8', 1],
        ['GB9 extend', 'A\u0301', 1],
        ['GB9 ZWJ', 'A\u200D', 1],
        ['GB9a spacing mark', 'A\u0903', 1],
        ['GB9b prepend', '\u0600A', 1],
        ['GB9c Indic conjunct', 'क्क', 1],
        ['GB11 pictographic ZWJ', '👨‍👩', 1],
        ['GB12/13 RI pair', '🇨🇳🇺', 2],
        ['GB999 fallback break', 'AB', 2]
    ].forEach(function(testCase) {
        assert.strictEqual(
            displayApi.graphemeClusterCount(testCase[1]),
            testCase[2],
            testCase[0]
        );
    });
})();

(function testFlatBreakAndAutoGroupsShareMetrics() {
    function grouped(mode, maxFlatWidth) {
        return artifactFrom('SELECT 1', undefined, function(factory, analysis) {
            var content = factory.concat([
                codeLeaf(factory, analysis, 'SELECT'),
                factory.softLine('space'),
                codeLeaf(factory, analysis, '1')
            ]);
            return mode === 'auto'
                ? factory.autoGroup(maxFlatWidth, content)
                : factory.group(mode, content);
        });
    }

    var flat = grouped('flat');
    var flatMetrics = metricsApi.measureLayoutArtifact(flat);
    assert.strictEqual(flatMetrics.ok, true);
    assert.strictEqual(flatMetrics.metrics.summary.flatWidth, 8);
    assert.strictEqual(flatMetrics.metrics.summary.containsContextualWidth, false);
    assert.strictEqual(renderApi.renderLayoutArtifact(flat).text, 'SELECT 1');

    var broken = renderApi.renderLayoutArtifact(grouped('break'));
    assert.strictEqual(broken.ok, true);
    assert.strictEqual(broken.text, 'SELECT\n1');

    var crlf = renderApi.renderLayoutArtifact(
        grouped('break'),
        environmentApi.renderEnvironmentForNewline('\r\n')
    );
    assert.strictEqual(crlf.ok, true);
    assert.strictEqual(crlf.text, 'SELECT\r\n1');
    assert.deepStrictEqual(crlf.sourceMap.entries, [
        { source: { start: 0, end: 6 }, output: { start: 0, end: 6 } },
        { source: { start: 7, end: 8 }, output: { start: 8, end: 9 } }
    ], 'CRLF code-unit width must be reflected in output source-map offsets');

    var cr = renderApi.renderLayoutArtifact(
        grouped('break'),
        environmentApi.renderEnvironmentForNewline('\r')
    );
    assert.strictEqual(cr.ok, true);
    assert.strictEqual(cr.text, 'SELECT\r1');

    var forgedEnvironment = renderApi.renderLayoutArtifact(
        grouped('break'),
        Object.freeze({ newline: '\r\n' })
    );
    assert.strictEqual(forgedEnvironment.ok, false);
    assert.strictEqual(forgedEnvironment.code, 'RENDER_NEWLINE_CONTRACT');

    var autoFlat = renderApi.renderLayoutArtifact(grouped('auto', 8));
    var autoBreak = renderApi.renderLayoutArtifact(grouped('auto', 7));
    assert.strictEqual(autoFlat.ok, true);
    assert.strictEqual(autoFlat.text, 'SELECT 1');
    assert.strictEqual(autoBreak.ok, true);
    assert.strictEqual(autoBreak.text, 'SELECT\n1');
})();

(function testGeneratedEolDoesNotRewriteSourceDerivedNewlines() {
    var artifact = artifactFrom('SELECT /*a\nb*/ 1', undefined,
        function(factory, analysis) {
            var comment = analysis.leaves.find(function(leaf) {
                return leaf.kind === 'block-comment';
            });
            assert.ok(comment);
            return factory.concat([
                codeLeaf(factory, analysis, 'SELECT'),
                factory.hardLine(),
                factory.leaf(comment.id, 'raw'),
                factory.space(1),
                codeLeaf(factory, analysis, '1')
            ]);
        });
    var rendered = renderApi.renderLayoutArtifact(
        artifact,
        environmentApi.renderEnvironmentForNewline('\r\n')
    );
    assert.strictEqual(rendered.ok, true);
    assert.strictEqual(rendered.text, 'SELECT\r\n/*a\nb*/ 1',
        'generated EOL must follow the environment while source text stays lossless');
})();

(function testIndentAlignPadAndTabUseOneColumnModel() {
    function withBreak(wrapper, optionInput) {
        return artifactFrom('SELECT 1', optionInput, function(factory, analysis) {
            var continuation = factory.concat([
                factory.hardLine(),
                codeLeaf(factory, analysis, '1')
            ]);
            var wrapped = wrapper(factory, continuation);
            return factory.concat([
                codeLeaf(factory, analysis, 'SELECT'),
                wrapped
            ]);
        });
    }

    var spaced = renderApi.renderLayoutArtifact(withBreak(function(factory, content) {
        return factory.indent(1, content);
    }, { indentStyle: 'space' }));
    assert.strictEqual(spaced.ok, true);
    assert.strictEqual(spaced.text, 'SELECT\n    1');

    var tabbed = renderApi.renderLayoutArtifact(withBreak(function(factory, content) {
        return factory.indent(1, content);
    }, { indentStyle: 'tab' }));
    assert.strictEqual(tabbed.ok, true);
    assert.strictEqual(tabbed.text, 'SELECT\n\t1');

    var aligned = renderApi.renderLayoutArtifact(withBreak(function(factory, content) {
        return factory.align(3, content);
    }));
    assert.strictEqual(aligned.ok, true);
    assert.strictEqual(aligned.text, 'SELECT\n   1');

    var paddedArtifact = artifactFrom('SELECT 1', undefined, function(factory, analysis) {
        return factory.concat([
            codeLeaf(factory, analysis, 'SELECT'),
            factory.padToColumn(8),
            codeLeaf(factory, analysis, '1')
        ]);
    });
    var padded = renderApi.renderLayoutArtifact(paddedArtifact);
    assert.strictEqual(padded.ok, true);
    assert.strictEqual(padded.text, 'SELECT  1');
})();

(function testSourceMapAndLineSuffixAreBuiltDuringEmission() {
    var artifact = artifactFrom('SELECT 1 --尾', undefined, function(factory, analysis) {
        var parts = [];
        analysis.leaves.forEach(function(leaf) {
            var binding = analysis.index.commentBinding(leaf.id);
            var doc = binding !== null && binding.placement === 'trailing'
                ? factory.lineSuffix(leaf.id, null)
                : factory.leaf(leaf.id, 'raw');
            assert.ok(doc, 'missing identity doc for leaf ' + leaf.id);
            parts.push(doc);
        });
        return factory.concat(parts);
    });
    var rendered = renderApi.renderLayoutArtifact(artifact);
    assert.strictEqual(rendered.ok, true);
    assert.strictEqual(rendered.text, 'SELECT 1 --尾',
        'EOF line comment must not manufacture a final newline');
    assertFrozenSourceMap(rendered.sourceMap);
    assert.deepStrictEqual(rendered.sourceMap.entries, [{
        source: { start: 0, end: 'SELECT 1 --尾'.length },
        output: { start: 0, end: 'SELECT 1 --尾'.length }
    }], 'adjacent source/output runs must merge');

    var clone = Object.assign({}, artifact);
    assert.doesNotThrow(function() {
        var rejected = renderApi.renderLayoutArtifact(clone);
        assert.strictEqual(rejected.ok, false);
        assert.strictEqual(rejected.text, undefined,
            'renderer failure must not leak partial text');
        assert.strictEqual(rejected.sourceMap, undefined,
            'renderer failure must not leak a partial source map');
    });

    var repeated = renderApi.renderLayoutArtifact(artifact);
    assert.strictEqual(repeated.ok, true);
    assert.deepStrictEqual(repeated, rendered,
        'rendering the same immutable artifact must be deterministic');
})();

(function testMultipleLineSuffixesFlushInRegistrationOrder() {
    var artifact = artifactFrom('SELECT 1/*a*//*b*/', undefined,
        function(factory, analysis) {
            var parts = [];
            analysis.leaves.forEach(function(leaf) {
                var doc;
                if (leaf.kind === 'block-comment') {
                    doc = factory.lineSuffix(leaf.id, {
                        kind: 'space',
                        columns: 1
                    });
                } else {
                    doc = factory.leaf(leaf.id, 'raw');
                }
                assert.ok(doc, 'FIFO fixture leaf ' + leaf.id);
                parts.push(doc);
            });
            return factory.concat(parts);
        });
    var rendered = renderApi.renderLayoutArtifact(artifact);
    assert.strictEqual(rendered.ok, true);
    assert.strictEqual(rendered.text, 'SELECT 1 /*a*/ /*b*/',
        'pending line suffixes must flush FIFO');
})();

(function testGeneratedHorizontalWhitespaceFlushesPendingSuffixesFirst() {
    function suffixBefore(kind) {
        var source = kind === 'line-comment'
            ? 'SELECT 1--a\n+2'
            : 'SELECT 1/*a*/+2';
        return artifactFrom(source, undefined, function(factory, analysis) {
            var comment = analysis.leaves.find(function(leaf) {
                return leaf.kind === kind;
            });
            assert.ok(comment, kind + ' fixture comment');
            var between = kind === 'line-comment'
                ? factory.space(1)
                : factory.padToColumn(16);
            return factory.concat([
                codeLeaf(factory, analysis, 'SELECT'),
                factory.space(1),
                codeLeaf(factory, analysis, '1'),
                factory.lineSuffix(comment.id, null),
                between,
                codeLeaf(factory, analysis, '+'),
                factory.space(1),
                codeLeaf(factory, analysis, '2')
            ]);
        });
    }

    var block = renderApi.renderLayoutArtifact(suffixBefore('block-comment'));
    assert.strictEqual(block.ok, true);
    assert.strictEqual(block.text, 'SELECT 1/*a*/   + 2',
        'pad must flush a pending block suffix before generated whitespace');

    var line = renderApi.renderLayoutArtifact(suffixBefore('line-comment'));
    assert.strictEqual(line.ok, true);
    assert.strictEqual(line.text, 'SELECT 1--a\n + 2',
        'space after a line suffix must force a physical line break first');

    var crlfLine = renderApi.renderLayoutArtifact(
        suffixBefore('line-comment'),
        environmentApi.renderEnvironmentForNewline('\r\n')
    );
    assert.strictEqual(crlfLine.ok, true);
    assert.strictEqual(crlfLine.text, 'SELECT 1--a\r\n + 2',
        'line-suffix flushing must use the same request EOL');
})();

(function testNestedIndentAlignPadAndSuffixShareDisplayContext() {
    function nested(indentStyle) {
        return artifactFrom('SELECT 1/*a*/', { indentStyle: indentStyle },
            function(factory, analysis) {
                var comment = analysis.leaves.filter(function(leaf) {
                    return leaf.kind === 'block-comment';
                })[0];
                var content = factory.concat([
                    factory.hardLine(),
                    factory.padToColumn(8),
                    codeLeaf(factory, analysis, '1'),
                    factory.lineSuffix(comment.id, {
                        kind: 'space',
                        columns: 1
                    })
                ]);
                return factory.concat([
                    codeLeaf(factory, analysis, 'SELECT'),
                    factory.indent(1, factory.align(2, content))
                ]);
            });
    }

    var spaced = renderApi.renderLayoutArtifact(nested('space'));
    assert.strictEqual(spaced.ok, true);
    assert.strictEqual(spaced.text, 'SELECT\n        1 /*a*/');

    var tabbed = renderApi.renderLayoutArtifact(nested('tab'));
    assert.strictEqual(tabbed.ok, true);
    assert.strictEqual(tabbed.text, 'SELECT\n\t    1 /*a*/',
        'tab indent, align, absolute pad and suffix must share one column model');
})();

(function testTabMetricsAndNewlineFailureStayFailClosed() {
    var tabArtifact = artifactFrom('SELECT\t1', undefined, function(factory, analysis) {
        return factory.concat(analysis.leaves.map(function(leaf) {
            return factory.leaf(leaf.id, 'raw');
        }));
    });
    var tabMetrics = metricsApi.measureLayoutArtifact(tabArtifact);
    assert.strictEqual(tabMetrics.ok, true);
    assert.strictEqual(tabMetrics.metrics.summary.flatWidth, null);
    assert.strictEqual(tabMetrics.metrics.summary.containsTab, true);

    var newlineArtifact = artifactFrom('SELECT 1', undefined, function(factory, analysis) {
        var parts = analysis.leaves.map(function(leaf) {
            return factory.leaf(leaf.id, 'raw');
        });
        parts.push(factory.hardLine());
        return factory.concat(parts);
    });
    var rejected = renderApi.renderLayoutArtifact(newlineArtifact);
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, 'RENDER_NEWLINE_CONTRACT');
    assert.strictEqual(rejected.text, undefined);
    assert.strictEqual(rejected.sourceMap, undefined);

    ['document', 'statement', 'fragment'].forEach(function(mode) {
        var trailing = artifactFrom('SELECT 1\n', undefined,
            function(factory, analysis) {
                var parts = [];
                analysis.leaves.forEach(function(leaf) {
                    if (leaf.kind === 'newline') {
                        parts.push(factory.hardLine());
                        parts.push(factory.space(1));
                    }
                    parts.push(factory.leaf(leaf.id, 'raw'));
                });
                return factory.concat(parts);
            }, mode);
        var trailingRejected = renderApi.renderLayoutArtifact(trailing);
        assert.strictEqual(trailingRejected.ok, false, mode + ' trailing run');
        assert.strictEqual(
            trailingRejected.code,
            'RENDER_NEWLINE_CONTRACT',
            mode + ' must not add a line break beside preserved trailing trivia'
        );
    });

    ['statement', 'fragment'].forEach(function(mode) {
        var leading = artifactFrom('\nSELECT 1', undefined,
            function(factory, analysis) {
                return factory.concat([
                    factory.hardLine(),
                    factory.padToColumn(1)
                ].concat(analysis.leaves.map(function(leaf) {
                    return factory.leaf(leaf.id, 'raw');
                })));
            }, mode);
        var leadingRejected = renderApi.renderLayoutArtifact(leading);
        assert.strictEqual(leadingRejected.ok, false, mode + ' leading run');
        assert.strictEqual(leadingRejected.code, 'RENDER_NEWLINE_CONTRACT');
    });
})();

(function testDeepLegalGraphUsesExplicitStacks() {
    var terms = [];
    for (var index = 0; index < 160; index++) {
        terms.push(String(index));
    }
    var source = 'SELECT ' + terms.join(' + ');
    var artifact = artifactFrom(source, undefined, function(factory, analysis) {
        var parts = analysis.leaves.map(function(leaf) {
            return factory.leaf(leaf.id, 'raw');
        });
        var root = factory.concat(parts);
        // The deepest source leaf is one level below the initial concat root.
        var maximumLegalWrappers = factory.budget.maxGraphNesting - 2;
        for (var depth = 0; depth < maximumLegalWrappers; depth++) {
            root = factory.group('flat', root);
            assert.ok(root, 'depth ' + depth + ' must remain within the legal budget');
        }
        return root;
    });
    var metrics = metricsApi.measureLayoutArtifact(artifact);
    assert.strictEqual(metrics.ok, true);
    assert.strictEqual(Object.isFrozen(metrics.metrics.statistics), true);
    var rendered = renderApi.renderLayoutArtifact(artifact);
    assert.strictEqual(rendered.ok, true);
    assert.strictEqual(rendered.text, source);
    assert.strictEqual(
        rendered.statistics.docVisitCount,
        metrics.metrics.docNodeCount
    );
    assert.strictEqual(
        metrics.metrics.statistics.docVisitCount,
        metrics.metrics.docNodeCount * 2
    );
    assert.strictEqual(
        metrics.metrics.statistics.summaryLookupCount,
        metrics.metrics.docNodeCount
    );
    assert.strictEqual(
        rendered.statistics.metricsDocVisitCount,
        metrics.metrics.statistics.docVisitCount
    );
    assert.strictEqual(
        rendered.statistics.metricsSummaryLookupCount,
        metrics.metrics.statistics.summaryLookupCount
    );
    assert.ok(
        rendered.statistics.metricsLookupCount <=
            rendered.statistics.docVisitCount
    );
})();

(function testTenThousandDeepAdversarialDocIsRejectedIteratively() {
    var terms = [];
    for (var index = 0; index < 600; index++) {
        terms.push(String(index));
    }
    var analysis = analyzed('SELECT ' + terms.join('+'));
    var factory = factoryApi.createLayoutDocFactory(analysis);
    assert.ok(factory.budget.maxDocNodes > 11000,
        'fixture must permit construction beyond ten thousand nodes');
    var parts = analysis.leaves.map(function(leaf) {
        return leaf.channel === 'trivia' ? null : factory.leaf(leaf.id, 'raw');
    }).filter(Boolean);
    var root = factory.concat(parts);
    for (var ordinal = 0; ordinal < 10001; ordinal++) {
        root = factory.group('break', root);
        assert.ok(root, 'deep adversarial node ' + ordinal);
    }
    var checked;
    assert.doesNotThrow(function() {
        checked = invariantApi.validateLayoutDoc(analysis, root);
    });
    assert.strictEqual(checked.ok, false);
    assert.ok(checked.failures.some(function(value) {
        return value.code === 'LAYOUT_RESOURCE_BUDGET';
    }), 'adversarial deep graph must be bounded by the iterative validator');
})();

console.log('v2 Wave 3B renderer tests passed');
