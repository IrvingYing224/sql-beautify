var assert = require('assert');
var bridgeModule = require('../../dist/v2-format-bridge.cjs');

var calls = [];
var formatter = {
    formatSqlTarget: function(source, options, mode) {
        calls.push({ source: source, options: options, mode: mode });
        return {
            status: 'formatted',
            text: source.toUpperCase(),
            diagnostics: [],
            sourceMap: { entries: [] }
        };
    }
};
var bridge = bridgeModule.create_v2_format_bridge({ formatter: formatter });

var mapped = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: {
        dialect: 'postgres',
        languageMode: 'sql',
        keywordCase: 'upper'
    }
});
assert.strictEqual(mapped.kind, 'edit', 'formatted v2 result must map to edit');
assert.strictEqual(mapped.text, 'SELECT A', 'bridge must retain formatter output for edit');
assert.strictEqual(calls[0].options.dialect, 'postgresql', 'public postgres value must map to v2 postgresql');
assert.strictEqual(calls[0].options.languageMode, undefined, 'legacy languageMode must not cross v2 boundary');
assert.strictEqual(calls[0].mode, 'document', 'document request must use document parse mode');

var range = bridge.format_request({
    kind: 'range',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(range.kind, 'edit', 'range result must map to edit');
assert.strictEqual(calls[1].mode, 'fragment', 'range request must use fragment parse mode');

formatter.formatSqlTarget = function() {
    return {
        status: 'preserved',
        text: 'private source',
        diagnostics: [{
            code: 'SYN_PRESERVED',
            severity: 'warning',
            message: 'Target was preserved',
            capabilityId: null,
            span: { start: 0, end: 0 },
            recovery: 'preserve-target'
        }],
        sourceMap: { entries: [{ source: { start: 0, end: 8 }, output: { start: 0, end: 8 } }] }
    };
};
var preserved = bridge.format_request({
    kind: 'range',
    source: 'private source',
    options: { dialect: 'hive' }
});
assert.strictEqual(preserved.kind, 'preserved', 'preserved v2 result must remain no-edit');
assert.strictEqual(preserved.text, 'private source', 'preserved result must retain original source');

formatter.formatSqlTarget = function() {
    return {
        status: 'failed',
        text: 'changed',
        diagnostics: [{
            code: 'FMT_FAILED',
            severity: 'error',
            message: 'Formatting failed',
            capabilityId: null,
            span: { start: 0, end: 0 },
            recovery: 'preserve-target'
        }]
    };
};
var failed = bridge.format_request({
    kind: 'document',
    source: 'private source',
    options: { dialect: 'hive' }
});
assert.strictEqual(failed.kind, 'failed', 'failed v2 result must remain no-edit');
assert.strictEqual(failed.text, 'private source', 'failed result must discard changed text');

formatter.formatSqlTarget = function() {
    throw new Error('private source must not be surfaced');
};
var thrown = bridge.format_request({
    kind: 'document',
    source: 'private source',
    options: { dialect: 'hive' }
});
assert.strictEqual(thrown.kind, 'failed', 'formatter throw must be contained as failed');
assert.strictEqual(thrown.diagnostics[0].code, 'FMT_RUNTIME', 'formatter throw must use stable bridge code');
assert.ok(!/private source/.test(thrown.diagnostics[0].message), 'bridge failure must not leak source');

formatter.formatSqlTarget = function() {
    return {
        status: 'formatted',
        text: 'SELECT A',
        diagnostics: [{
            code: 'SYN_UNMODELED_CONSTRUCT',
            severity: 'warning',
            message: 'Syntax was preserved',
            capabilityId: 'match-recognize',
            span: { start: 0, end: 8 },
            recovery: 'preserve-target'
        }],
        sourceMap: { entries: [{ source: { start: 0, end: 8 }, output: { start: 0, end: 8 } }] }
    };
};
var warning = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(warning.kind, 'edit', 'warning does not prevent a safe edit');
assert.strictEqual(warning.diagnostics[0].severity, 'warning', 'v2 severity must survive bridge mapping');

formatter.formatSqlTarget = function() {
    return { status: 'unknown', text: 'changed', diagnostics: [] };
};
var badStatus = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(badStatus.kind, 'failed', 'unknown result status must fail closed');
assert.strictEqual(badStatus.diagnostics[0].code, 'FMT_RESULT_STATUS');

formatter.formatSqlTarget = function() {
    return { status: 'formatted', text: 'changed', diagnostics: [{ message: 'bad' }] };
};
var badDiagnostic = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(badDiagnostic.kind, 'failed', 'invalid diagnostic shape must fail closed');
assert.strictEqual(badDiagnostic.diagnostics[0].code, 'FMT_DIAGNOSTIC_SHAPE');

formatter.formatSqlTarget = function() {
    return { status: 'formatted', text: 'changed', diagnostics: [] };
};
var cancelledBefore = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' },
    cancelled: true
});
assert.strictEqual(cancelledBefore.kind, 'cancelled', 'pre-cancelled request must not call formatter');

var cancellationChecks = 0;
var cancelledAfter = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' },
    isCancelled: function() {
        cancellationChecks += 1;
        return cancellationChecks > 1;
    }
});
assert.strictEqual(cancelledAfter.kind, 'cancelled', 'post-format cancellation must discard edit');

var getterFailure = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: {
        get dialect() {
            throw new Error('untrusted getter');
        }
    }
});
assert.strictEqual(getterFailure.kind, 'failed', 'configuration getter failure must fail closed');

var unknownOption = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: {
        dialect: 'hive',
        hiddenOption: true
    }
});
assert.strictEqual(unknownOption.kind, 'failed', 'unknown adapter options must fail closed');
assert.strictEqual(unknownOption.diagnostics[0].code, 'FMT_OPTIONS_SHAPE');

formatter.formatSqlTarget = function(source) {
    return {
        status: 'unchanged',
        text: source + ' changed',
        diagnostics: [],
        sourceMap: { entries: [] }
    };
};
var inconsistentUnchanged = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(inconsistentUnchanged.kind, 'failed', 'unchanged status with changed text must fail closed');
assert.strictEqual(inconsistentUnchanged.diagnostics[0].code, 'FMT_RESULT_STATUS');

formatter.formatSqlTarget = function() {
    return {
        status: 'formatted',
        text: 'SELECT A',
        diagnostics: [],
        sourceMap: {
            entries: [{
                source: { start: 0, end: 8 },
                output: { start: 1, end: 8 }
            }]
        }
    };
};
var invalidSourceMap = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(invalidSourceMap.kind, 'failed', 'length-changing source map runs must fail closed');
assert.strictEqual(invalidSourceMap.diagnostics[0].code, 'FMT_SOURCE_MAP_SHAPE');

formatter.formatSqlTarget = function() {
    return {
        status: 'formatted',
        text: 'SELECT A',
        diagnostics: [],
        sourceMap: {
            entries: [{
                source: { start: 0, end: 0 },
                output: { start: 3, end: 3 }
            }]
        }
    };
};
var zeroLengthSourceMap = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(zeroLengthSourceMap.kind, 'failed', 'zero-length source map runs must fail closed');
assert.strictEqual(zeroLengthSourceMap.diagnostics[0].code, 'FMT_SOURCE_MAP_SHAPE');

formatter.formatSqlTarget = function() {
    var statusReads = 0;
    var textReads = 0;
    var mapReads = 0;
    var result = {
        diagnostics: []
    };
    Object.defineProperties(result, {
        status: {
            enumerable: true,
            get: function() {
                statusReads += 1;
                return statusReads == 1 ? 'formatted' : 'unknown';
            }
        },
        text: {
            enumerable: true,
            get: function() {
                textReads += 1;
                return textReads == 1 ? 'SELECT A' : 'EVIL';
            }
        },
        sourceMap: {
            enumerable: true,
            get: function() {
                mapReads += 1;
                return mapReads == 1
                    ? { entries: [{
                        source: { start: 0, end: 8 },
                        output: { start: 0, end: 8 }
                    }] }
                    : { entries: [{
                        source: { start: 99, end: 100 },
                        output: { start: 99, end: 100 }
                    }] };
            }
        }
    });
    return result;
};
var changingResult = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(changingResult.kind, 'edit', 'bridge must normalize one stable top-level result snapshot');
assert.strictEqual(changingResult.status, 'formatted', 'bridge kind and status must remain consistent');
assert.strictEqual(changingResult.text, 'SELECT A', 'later text getter values must not escape');
assert.deepStrictEqual(changingResult.sourceMap.entries[0].source, { start: 0, end: 8 },
    'later source map getter values must not escape');

formatter.formatSqlTarget = function() {
    return {
        status: 'formatted',
        text: 'SELECT A',
        diagnostics: [{
            code: 'FMT_BAD_RECOVERY',
            severity: 'warning',
            message: 'Bad recovery',
            capabilityId: null,
            span: { start: 0, end: 0 },
            recovery: 'toString'
        }],
        sourceMap: { entries: [] }
    };
};
var inheritedRecovery = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(inheritedRecovery.kind, 'failed', 'inherited object keys are not valid recovery actions');
assert.strictEqual(inheritedRecovery.diagnostics[0].code, 'FMT_DIAGNOSTIC_SHAPE');

var revokedResult = Proxy.revocable({}, {});
revokedResult.revoke();
formatter.formatSqlTarget = function() {
    return revokedResult.proxy;
};
var unreadableResult = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(unreadableResult.kind, 'failed', 'unreadable formatter result must be contained');
assert.strictEqual(unreadableResult.diagnostics[0].code, 'FMT_RESULT_READ');

var requestProxy = Proxy.revocable({}, {});
requestProxy.revoke();
var unreadableRequest = bridge.format_request(requestProxy.proxy);
assert.strictEqual(unreadableRequest.kind, 'failed', 'unreadable requests must be contained');
assert.strictEqual(unreadableRequest.diagnostics[0].code, 'FMT_REQUEST_READ');

formatter.formatSqlTarget = function(source) {
    return {
        status: 'unchanged',
        text: source,
        diagnostics: [],
        sourceMap: { entries: [] }
    };
};
var frozen = bridge.format_request({
    kind: 'document',
    source: 'select a',
    options: { dialect: 'hive' }
});
assert.strictEqual(Object.isFrozen(frozen), true, 'bridge result must be frozen');
assert.strictEqual(Object.isFrozen(frozen.diagnostics), true, 'bridge diagnostics must be frozen');
assert.strictEqual(Object.isFrozen(frozen.sourceMap), true, 'bridge source map must be frozen');
assert.strictEqual(Object.isFrozen(frozen.sourceMap.entries), true, 'bridge source map entries must be frozen');

console.log('v2 format bridge tests passed');
