'use strict';

var assert = require('assert');
var analysis = require('../../../.tmp/v2-core/core/analysis/analyze');

// Deliberately simple scan-based oracle for the pre-index range semantics.
// It consumes real canonical analysis, independently of the optimized queries.
function reference(source, start, end, artifact) {
    if (start === end) { return 'fragment'; }
    if (start === 0 && end === source.length) { return 'document'; }
    if (artifact.status !== 'analyzed' || artifact.index === null) {
        return 'ADAPTER_RANGE_ANALYSIS';
    }
    function protectedBoundary(offset) {
        var location = artifact.index.offsetToLeaf(offset);
        if (location === null) { return false; }
        var leaf = artifact.leaves[location.leafId];
        return location.relativeOffset > 0 && location.relativeOffset < leaf.raw.length &&
            (leaf.channel === 'protected' || leaf.kind === 'line-comment' || leaf.kind === 'block-comment');
    }
    if (protectedBoundary(start) || protectedBoundary(end)) { return 'ADAPTER_RANGE_PROTECTED'; }
    var lineStart = start === 0 || source[start - 1] === '\n' ||
        (source[start - 1] === '\r' && source[start] !== '\n');
    var splitCrlf = source[end] === '\n' && source[end - 1] === '\r';
    var lineEnd = end === source.length || (!splitCrlf &&
        (source[end] === '\r' || source[end] === '\n' || source[end - 1] === '\n' ||
            (source[end - 1] === '\r' && source[end] !== '\n')));
    if (!lineStart || !lineEnd) { return 'ADAPTER_RANGE_LINE'; }
    var nodes = artifact.index.nodes();
    if (nodes.some(function(node) {
        return node.kind === 'opaque' && node.span.start < end && start < node.span.end;
    })) { return 'ADAPTER_RANGE_OPAQUE'; }
    var content = artifact.leaves.filter(function(leaf) {
        return leaf.channel !== 'trivia' && leaf.span.start < end && start < leaf.span.end;
    });
    if (content.length === 0) { return 'ADAPTER_RANGE_EMPTY'; }
    var boundary = { start: content[0].span.start, end: content[content.length - 1].span.end };
    var statements = [];
    var owned = false;
    nodes.forEach(function(node) {
        if (!['statement', 'clause', 'list'].includes(node.kind)) { return; }
        var syntax = artifact.leaves.slice(node.leafRange.start, node.leafRange.end)
            .filter(function(leaf) { return leaf.channel !== 'trivia'; });
        if (syntax.length === 0) { return; }
        var nodeBoundary = { start: syntax[0].span.start, end: syntax[syntax.length - 1].span.end };
        if (nodeBoundary.start === boundary.start && nodeBoundary.end === boundary.end) { owned = true; }
        if (node.kind === 'statement') { statements.push(nodeBoundary); }
    });
    if (owned) { return 'fragment'; }
    statements.sort(function(left, right) { return left.start - right.start || left.end - right.end; });
    var first = statements.findIndex(function(statement) { return statement.start === boundary.start; });
    if (first >= 0) {
        for (var index = first; index < statements.length; index++) {
            if (statements[index].end === boundary.end) { return index > first ? 'document' : 'ADAPTER_RANGE_OWNERSHIP'; }
            if (statements[index].end > boundary.end) { break; }
        }
    }
    return 'ADAPTER_RANGE_OWNERSHIP';
}

module.exports = function(range) {
    var originalAnalyze = analysis.analyzeSql;
    try {
        [
            'select a,\n b\nfrom t\nwhere x=1\n',
            'select a;\r\n\r\nselect b;\r\nselect c;\r\n',
            'select a;\rselect b;\r',
            '-- first\nselect a;\n/* last */\n  ',
            "select 'a\nb', `x\ny` from t;\nselect c;",
            'select a;\nCREATE TABLE t(x INT);\nselect b;\n',
            '\uFEFFselect a;\n;\nselect b;\n',
            ' \t\nselect a;\n\t \nselect b;\n   '
        ].forEach(function(source) {
            var artifact = originalAnalyze(source, { dialect: 'hive', mode: 'document' });
            analysis.analyzeSql = function(value) {
                assert.strictEqual(value, source);
                return artifact;
            };
            for (var start = 0; start <= source.length; start++) {
                for (var end = start; end <= source.length; end++) {
                    var expected = reference(source, start, end, artifact);
                    var result = range.validateFormatTargetRanges(source, [{
                        id: 'equivalence', start: start, end: end, mode: 'fragment'
                    }], { dialect: 'hive' });
                    assert.strictEqual(result.safe ? result.targetModes[0].mode : result.code, expected,
                        'indexed range must preserve scan semantics at ' + start + ':' + end + ' in ' + JSON.stringify(source));
                }
            }
        });

        // Instrument only adapter-visible reads. The SQL analysis remains real;
        // timing, parser internals and machine load do not affect this budget.
        [64, 128, 256].forEach(function(count) {
            var line = 'select a;\n';
            var source = line.repeat(count);
            var artifact = originalAnalyze(source, { dialect: 'hive', mode: 'document' });
            assert.strictEqual(artifact.status, 'analyzed');
            var reads = 0;
            var lookups = 0;
            var measuredLeaves = new Proxy(artifact.leaves, {
                get: function(target, property, receiver) {
                    if (typeof property === 'string' && /^\d+$/.test(property)) { reads += 1; }
                    return Reflect.get(target, property, receiver);
                }
            });
            var measuredIndex = Object.assign({}, artifact.index, {
                offsetToLeaf: function(offset) { lookups += 1; return artifact.index.offsetToLeaf(offset); }
            });
            analysis.analyzeSql = function() {
                return Object.assign({}, artifact, { leaves: measuredLeaves, index: measuredIndex });
            };
            var targets = Array.from({ length: count }, function(_, index) {
                return { id: String(index), start: index * line.length,
                    end: (index + 1) * line.length - 1, mode: 'fragment' };
            });
            assert.strictEqual(range.validateFormatTargetRanges(source, targets).status, 'valid');
            var independentBudget = 8 * artifact.leaves.length + 12 * count;
            assert.ok(reads <= independentBudget,
                'range leaf reads must scale with input plus targets: ' + reads + ' > ' + independentBudget);
            assert.ok(lookups <= 4 * count, 'each range must use bounded offset lookups');
        });

        [64, 128, 256].forEach(function(count) {
            var line = 'select a;\n';
            var source = line.repeat(count) + 'CREATE TABLE t(x INT);\n'.repeat(count);
            var artifact = originalAnalyze(source, { dialect: 'hive', mode: 'document' });
            assert.strictEqual(artifact.status, 'analyzed');
            var opaqueReads = 0;
            var opaqueCount = 0;
            var nodes = artifact.index.nodes().map(function(node) {
                if (node.kind !== 'opaque') { return node; }
                opaqueCount += 1;
                var span = {};
                Object.defineProperties(span, {
                    start: { get: function() { opaqueReads += 1; return node.span.start; } },
                    end: { get: function() { opaqueReads += 1; return node.span.end; } }
                });
                return Object.assign({}, node, { span: span });
            });
            assert.ok(opaqueCount >= count, 'the fixture must exercise a growing opaque set');
            analysis.analyzeSql = function() {
                return Object.assign({}, artifact, { index: Object.assign({}, artifact.index, {
                    nodes: function() { return nodes; }
                }) });
            };
            var targets = Array.from({ length: count }, function(_, index) {
                return { id: String(index), start: index * line.length,
                    end: (index + 1) * line.length - 1, mode: 'fragment' };
            });
            assert.strictEqual(range.validateFormatTargetRanges(source, targets).status, 'valid');
            var budget = 12 * (opaqueCount + count) * Math.ceil(Math.log2(opaqueCount + 1));
            assert.ok(opaqueReads <= budget,
                'opaque queries must remain bounded by sorting and binary lookup: ' + opaqueReads + ' > ' + budget);
        });

        // Overlapping/nested intervals require the maximum end of the prefix,
        // not just the end of the last interval found by binary search.
        var nestedSource = 'select a;\nselect b;\nselect c;\nselect d;\n';
        var nestedArtifact = originalAnalyze(nestedSource, { dialect: 'hive', mode: 'document' });
        var nestedSpans = [{ start: 0, end: 25 }, { start: 1, end: 2 }, { start: 8, end: 9 }];
        analysis.analyzeSql = function() {
            return Object.assign({}, nestedArtifact, { index: Object.assign({}, nestedArtifact.index, {
                nodes: function() {
                    return nestedArtifact.index.nodes().concat(nestedSpans.map(function(span) {
                        return { kind: 'opaque', span: span };
                    }));
                }
            }) });
        };
        assert.strictEqual(range.validateFormatTargetRanges(nestedSource, [
            { id: 'nested', start: 20, end: 29, mode: 'fragment' }
        ]).code, 'ADAPTER_RANGE_OPAQUE');
        nestedSpans = [{ start: 0, end: 20 }, { start: 29, end: 35 }];
        assert.strictEqual(range.validateFormatTargetRanges(nestedSource, [
            { id: 'touching', start: 20, end: 29, mode: 'fragment' }
        ]).status, 'valid', 'half-open touching opaque intervals must not intersect');
    } finally {
        analysis.analyzeSql = originalAnalyze;
    }
};
