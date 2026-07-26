var assert = require('assert');
var fs = require('fs');
var path = require('path');
var cancellation = require('../../.tmp/v2-core/adapters/transaction/cancellation');
var diagnostics = require('../../.tmp/v2-core/adapters/diagnostics/convert');
var presentation = require('../../.tmp/v2-core/adapters/diagnostics/presentation');
var safeMessages = require('../../.tmp/v2-core/adapters/diagnostics/safe-messages');

var controller = cancellation.createCancellationController();
var calls = [];
var disposeFirst = controller.token.onCancellationRequested(function() {
    calls.push('first');
});
controller.token.onCancellationRequested(function() {
    calls.push('second');
    throw new Error('listener failure must be contained');
});
disposeFirst();
controller.cancel();
controller.cancel();
assert.strictEqual(controller.token.isCancellationRequested, true);
assert.deepStrictEqual(calls, ['second'], 'cancel must notify remaining listeners once');
var immediateCalls = 0;
assert.doesNotThrow(function() {
    controller.token.onCancellationRequested(function() {
        throw new Error('late listener failure must be contained');
    });
}, 'late cancellation listener throw must be contained');
controller.token.onCancellationRequested(function() {
    immediateCalls += 1;
});
assert.strictEqual(immediateCalls, 1, 'late listener must observe cancellation synchronously');

var converted = diagnostics.convertDiagnostic({
    code: 'SYN_UNMODELED_CONSTRUCT',
    severity: 'warning',
    message: 'private_table at /private/path.sql',
    capabilityId: 'hive-clause',
    span: { start: 2, end: 5 },
    recovery: 'preserve-target'
}, 'selection:1', 10, 8);
assert.deepStrictEqual(converted.span, { start: 12, end: 15 },
    'diagnostic span must become an absolute document span');
assert.strictEqual(converted.targetId, 'selection:1');
assert.ok(!/private_table|private\/path/.test(converted.message),
    'adapter diagnostic message must not copy source or paths');
assert.ok(converted.message.indexOf('capability: hive-clause') >= 0,
    'validated capability identity must remain available in the safe message');
assert.strictEqual(Object.isFrozen(converted), true);
assert.strictEqual(diagnostics.convertDiagnostic({
    code: 'BAD', severity: 'error', message: 'x', capabilityId: null,
    span: { start: 0, end: 9 }, recovery: 'preserve-target'
}, 'selection:1', 10, 8), null, 'out-of-target diagnostic must fail closed');
assert.strictEqual(diagnostics.convertDiagnostic({
    code: 'BAD', severity: 'fatal', message: 'x', capabilityId: null,
    span: { start: 0, end: 1 }, recovery: 'preserve-target'
}, 'selection:1', 10, 8), null, 'unknown diagnostic severity must fail closed');
assert.strictEqual(diagnostics.convertDiagnostic({
    code: 'BAD', severity: 'error', message: 'x', capabilityId: null,
    span: { start: 0, end: 1 }, recovery: 'toString'
}, 'selection:1', 10, 8), null, 'inherited recovery keys must fail closed');
var diagnosticReads = 0;
var dynamicDiagnostic = {
    severity: 'warning', message: 'private', capabilityId: null,
    span: { start: 0, end: 1 }, recovery: 'preserve-target'
};
Object.defineProperty(dynamicDiagnostic, 'code', {
    enumerable: true,
    get: function() {
        diagnosticReads += 1;
        return diagnosticReads == 1 ? 'SAFE_CODE' : '/private/path.sql';
    }
});
assert.strictEqual(
    diagnostics.convertDiagnostic(dynamicDiagnostic, 'selection:1', 10, 8),
    null,
    'diagnostic accessors must fail closed before conversion'
);
assert.strictEqual(diagnosticReads, 0, 'diagnostic accessors must never execute');
assert.strictEqual(
    diagnostics.convertDiagnostic(new Proxy({
        code: 'SAFE_CODE', severity: 'warning', message: 'x', capabilityId: null,
        span: { start: 0, end: 1 }, recovery: 'preserve-target'
    }, {}), 'selection:1', 10, 8),
    null,
    'diagnostic proxies must fail closed'
);

var sorted = diagnostics.sortDiagnostics([
    Object.freeze(Object.assign({}, converted, { targetId: 'selection:2', span: { start: 1, end: 2 } })),
    Object.freeze(Object.assign({}, converted, { targetId: 'selection:1', span: { start: 5, end: 6 } })),
    Object.freeze(Object.assign({}, converted, { targetId: 'selection:1', span: { start: 2, end: 3 } }))
]);
assert.deepStrictEqual(sorted.map(function(item) {
    return item.targetId + ':' + item.span.start;
}), ['selection:1:2', 'selection:1:5', 'selection:2:1'],
'diagnostics must have stable target/span order');

var nested = presentation.diagnosticsForEditor([
    Object.freeze(Object.assign({}, converted, { span: { start: 0, end: 20 } })),
    Object.freeze(Object.assign({}, converted, { span: { start: 4, end: 8 } })),
    Object.freeze(Object.assign({}, converted, { span: { start: 5, end: 7 } })),
    Object.freeze(Object.assign({}, converted, { span: { start: 30, end: 35 } })),
    Object.freeze(Object.assign({}, converted, {
        capabilityId: 'other-capability', span: { start: 0, end: 20 }
    }))
]);
assert.deepStrictEqual(nested.map(function(item) {
    return [item.capabilityId, item.span.start, item.span.end];
}), [
    ['other-capability', 0, 20],
    ['hive-clause', 5, 7],
    ['hive-clause', 30, 35]
], 'editor presentation must retain the narrowest nested span per diagnostic identity');

var sourceRoot = path.resolve(__dirname, '../../src');
var diagnosticPrefixes = /^(?:ADAPTER|CFG|DDL|EXTRACT|FMT|INV|LAYOUT|LEX|METRICS|RENDER|STRUCT|SYN)_/;
var discovered = new Set();
function collectCodes(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(function(entry) {
        var absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collectCodes(absolute);
            return;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) {
            return;
        }
        var source = fs.readFileSync(absolute, 'utf8');
        var matches = source.match(/"[A-Z][A-Z0-9_]{1,119}"/g) || [];
        matches.forEach(function(match) {
            var code = match.slice(1, -1);
            if (diagnosticPrefixes.test(code)) {
                discovered.add(code);
            }
        });
    });
}
collectCodes(sourceRoot);
var missingSafeMessages = Array.from(discovered).filter(function(code) {
    return !safeMessages.hasKnownSafeDiagnosticMessage(code);
}).sort();
assert.deepStrictEqual(missingSafeMessages, [],
    'every production diagnostic code must have an explicit static safe message');
assert.strictEqual(
    safeMessages.safeDiagnosticMessage('FUTURE_SAFE_CODE', null),
    'Formatter reported a recoverable diagnostic',
    'well-formed future codes retain a safe generic fallback'
);

console.log('v2 Wave 4B cancellation and diagnostic tests passed');
