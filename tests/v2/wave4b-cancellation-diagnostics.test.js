var assert = require('assert');
var cancellation = require('../../.tmp/v2-core/adapters/transaction/cancellation');
var diagnostics = require('../../.tmp/v2-core/adapters/diagnostics/convert');

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

console.log('v2 Wave 4B cancellation and diagnostic tests passed');
