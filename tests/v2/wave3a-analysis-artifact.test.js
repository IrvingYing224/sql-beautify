'use strict';

var assert = require('assert');
var analysis = require('../../.tmp/v2-core/core/analysis/index.js');
var artifactApi = require('../../.tmp/v2-core/core/analysis/artifact.js');
var analyzer = require('../../.tmp/v2-core/core/analysis/analyze.js');
var layoutFactory = require('../../.tmp/v2-core/core/layout/doc-factory.js');
var parser = require('../../.tmp/v2-core/core/syntax/parser.js');

(function testCanonicalAnalyzedProvenance() {
    var source = 'SELECT window AS order FROM group';
    var result = analysis.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(result.status, 'analyzed');
    assert.strictEqual(result.source, source);
    assert.strictEqual(result.dialect, 'hive');
    assert.strictEqual(result.mode, 'document');
    assert.ok(result.index);
    assert.strictEqual(Object.isFrozen(result), true);
    assert.strictEqual(analysis.isCanonicalAnalysisArtifact(result), true);
    assert.strictEqual(analysis.isCanonicalAnalyzedArtifact(result), true);
    assert.strictEqual(
        analysis.isCanonicalAnalysisArtifact(Object.assign({}, result)),
        false,
        'plain clone must not inherit analysis provenance'
    );
})();

(function testDialectAndModeAreRetained() {
    [
        ['generic', 'statement'],
        ['postgresql', 'fragment'],
        ['mysql', 'document']
    ].forEach(function(entry) {
        var result = analysis.analyzeSql('SELECT 1', {
            dialect: entry[0],
            mode: entry[1]
        });
        assert.strictEqual(result.dialect, entry[0]);
        assert.strictEqual(result.mode, entry[1]);
        assert.strictEqual(analysis.isCanonicalAnalysisArtifact(result), true);
    });
})();

(function testTargetPreservationDoesNotBecomeLayoutEligible() {
    var result = analysis.analyzeSql("SELECT 'unterminated", {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(result.status, 'preserved');
    assert.ok(result.index, 'preserved analysis keeps its trusted index');
    assert.strictEqual(analysis.isCanonicalAnalysisArtifact(result), true);
    assert.strictEqual(analysis.isCanonicalAnalyzedArtifact(result), false);
    assert.strictEqual(result.source, "SELECT 'unterminated");
})();

(function testPreservedParseCannotBeRelabeledAnalyzed() {
    var parsed = parser.parseSqlArtifact("SELECT 'unterminated", {
        dialect: 'hive',
        mode: 'document'
    });
    var preserved = analyzer.analyzeParseArtifact(parsed);
    assert.strictEqual(preserved.status, 'preserved');
    var relabeled = artifactApi.createAnalysisArtifact(
        parsed,
        'analyzed',
        preserved.index
    );
    assert.strictEqual(
        analysis.isCanonicalAnalysisArtifact(relabeled),
        false,
        'preserve-target diagnostics must prevent analyzed provenance'
    );
    assert.strictEqual(analysis.isCanonicalAnalyzedArtifact(relabeled), false);
    assert.strictEqual(layoutFactory.createLayoutDocFactory(relabeled), null);
    assert.throws(function() {
        artifactApi.createAnalysisArtifact(parsed, 'forged-status', preserved.index);
    }, /Unknown analysis artifact status/);
})();

(function testForgedParseArtifactsNeverGainCanonicalAnalysisIdentity() {
    var parsed = parser.parseSqlArtifact('SELECT 1', {
        dialect: 'hive',
        mode: 'document'
    });
    var wrongSource = Object.freeze(Object.assign({}, parsed, {
        source: 'SELECT 2'
    }));
    var output = analyzer.analyzeParseArtifact(wrongSource);
    assert.strictEqual(output.status, 'failed');
    assert.strictEqual(output.source, 'SELECT 2');
    assert.strictEqual(output.index, null);
    assert.strictEqual(analysis.isCanonicalAnalysisArtifact(output), false);

    var cloned = Object.freeze(Object.assign({}, parsed));
    var clonedOutput = analyzer.analyzeParseArtifact(cloned);
    assert.strictEqual(analysis.isCanonicalAnalysisArtifact(clonedOutput), false);
})();

(function testDirectIndexCannotForgeParserBoundProvenance() {
    var parsed = parser.parseSqlArtifact('SELECT 1', {
        dialect: 'hive',
        mode: 'document'
    });
    var directIndex = analysis.buildStructuralIndex({
        root: parsed.output.root,
        leaves: parsed.output.leaves,
        tokenTable: parsed.tokenTable,
        dialect: parsed.dialect,
        diagnostics: parsed.output.diagnostics,
        hasCommentTrivia: parsed.hasCommentTrivia
    });
    var forged = artifactApi.createAnalysisArtifact(
        parsed,
        'analyzed',
        directIndex
    );
    assert.strictEqual(analysis.isCanonicalAnalysisArtifact(forged), false);
})();

console.log('v2 Wave 3A analysis artifact tests passed');
