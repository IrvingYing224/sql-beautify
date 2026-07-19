'use strict';

var assert = require('assert');
var ddl = require('../../.tmp/v2-core/experimental/ddl');
var cancellation = require('../../.tmp/v2-core/adapters/transaction/cancellation');
var transaction = require('../../.tmp/v2-core/adapters/transaction/experimental-ddl');

function snapshot(source, version, identity) {
    return Object.freeze({
        identity: identity,
        source: source,
        version: version
    });
}

function target(source) {
    return Object.freeze({ id: 'ddl', start: 0, end: source.length });
}

async function runOperation(source, operation, overrides) {
    var identity = {};
    var document = snapshot(source, 7, identity);
    var applied = [];
    var options = overrides || {};
    var commit = {
        currentDocument: function() {
            return options.currentDocument || document;
        },
        apply: async function(result, expected) {
            applied.push({ result: result, expected: expected });
            return options.applyResult === undefined ? true : options.applyResult;
        }
    };
    var result = await transaction.runExperimentalDdlTransaction({
        document: document,
        target: target(source),
        cancellation: options.cancellation
    }, operation, commit);
    return { result: result, applied: applied, document: document, identity: identity };
}

async function main() {
    var formattedSource = 'create table t (a int);';
    var formatted = await runOperation(formattedSource, ddl.formatHiveDdl);
    assert.strictEqual(formatted.result.status, 'ready');
    assert.strictEqual(formatted.result.edits.length, 1);
    assert.strictEqual(formatted.result.edits[0].text.endsWith(');\n'), true,
        'DDL transaction must retain the statement terminator');
    assert.strictEqual(formatted.applied.length, 1, 'formatted DDL commits exactly once');

    var extractedSource = 'SELECT a FROM t';
    var extracted = await runOperation(extractedSource, ddl.extractDdl);
    assert.strictEqual(extracted.result.status, 'ready');
    assert.strictEqual(extracted.result.edits.length, 1);
    assert.ok(extracted.result.edits[0].text.indexOf('__TYPE_REQUIRED__') >= 0);
    assert.strictEqual(extracted.applied.length, 1, 'extracted DDL commits exactly once');

    var unchangedSource = 'CREATE TABLE t\n(\n     a INT\n)\n';
    var unchanged = await runOperation(unchangedSource, ddl.formatHiveDdl);
    assert.strictEqual(unchanged.result.status, 'unchanged');
    assert.deepStrictEqual(unchanged.result.edits, []);
    assert.strictEqual(unchanged.applied.length, 0, 'unchanged DDL must not commit');

    var blocked = [
        {
            source: 'CREATE TABLE t (a STRING) STORED AS ORC',
            operation: ddl.formatHiveDdl,
            status: 'preserved'
        },
        {
            source: 'SELECT * FROM t',
            operation: ddl.extractDdl,
            status: 'ambiguous'
        },
        {
            source: '',
            operation: ddl.extractDdl,
            status: 'empty'
        },
        {
            source: 'CREATE TABLE t (a STRING)',
            operation: ddl.extractDdl,
            status: 'unsupported'
        },
        {
            source: "SELECT 'unterminated",
            operation: ddl.extractDdl,
            status: 'failed'
        }
    ];
    for (var index = 0; index < blocked.length; index++) {
        var fixture = blocked[index];
        assert.strictEqual(fixture.operation(fixture.source).status, fixture.status);
        var blockedResult = await runOperation(fixture.source, fixture.operation);
        assert.strictEqual(blockedResult.result.status, 'rejected',
            fixture.status + ' result must reject atomically');
        assert.strictEqual(blockedResult.applied.length, 0,
            fixture.status + ' result must not reach host commit');
    }

    var staleIdentity = {};
    var stale = await runOperation(formattedSource, ddl.formatHiveDdl, {
        currentDocument: snapshot(formattedSource, 8, staleIdentity)
    });
    assert.strictEqual(stale.result.status, 'rejected');
    assert.strictEqual(stale.result.diagnostics[0].code, 'ADAPTER_STALE_DOCUMENT');
    assert.strictEqual(stale.applied.length, 0, 'stale documents must not commit');

    var controller = cancellation.createCancellationController();
    controller.cancel();
    var cancelled = await runOperation(formattedSource, ddl.formatHiveDdl, {
        cancellation: controller.token
    });
    assert.strictEqual(cancelled.result.status, 'cancelled');
    assert.strictEqual(cancelled.applied.length, 0, 'cancelled DDL must not commit');

    var rejectedCommit = await runOperation(formattedSource, ddl.formatHiveDdl, {
        applyResult: false
    });
    assert.strictEqual(rejectedCommit.result.status, 'rejected');
    assert.strictEqual(rejectedCommit.result.diagnostics[0].code, 'ADAPTER_EDIT_REJECTED');
    assert.strictEqual(rejectedCommit.applied.length, 1, 'host rejection is attempted once');

    var thrown = await runOperation(formattedSource, function() {
        throw new Error('operation failure');
    });
    assert.strictEqual(thrown.result.status, 'rejected');
    assert.strictEqual(thrown.result.diagnostics[0].code, 'ADAPTER_DDL_OPERATION');
    assert.strictEqual(thrown.applied.length, 0);

    var emptyEditable = await runOperation(extractedSource, function(source) {
        return Object.freeze({
            status: 'extracted',
            source: source,
            text: '',
            diagnostics: Object.freeze([])
        });
    });
    assert.strictEqual(emptyEditable.result.status, 'rejected');
    assert.strictEqual(emptyEditable.result.diagnostics[0].code, 'ADAPTER_DDL_RESULT');
    assert.strictEqual(emptyEditable.applied.length, 0);

    var unsafePreserved = await runOperation(extractedSource, function(source) {
        return Object.freeze({
            status: 'ambiguous',
            source: source,
            text: 'partial schema',
            diagnostics: Object.freeze([])
        });
    });
    assert.strictEqual(unsafePreserved.result.status, 'rejected');
    assert.strictEqual(unsafePreserved.result.diagnostics[0].code, 'ADAPTER_DDL_RESULT');
    assert.strictEqual(unsafePreserved.applied.length, 0);

    var warningEditable = await runOperation(extractedSource, function(source) {
        return Object.freeze({
            status: 'formatted',
            source: source,
            text: 'CHANGED',
            diagnostics: Object.freeze([Object.freeze({
                code: 'DDL_WARNING',
                severity: 'warning',
                message: 'preserve this target',
                capabilityId: null,
                span: Object.freeze({ start: 0, end: source.length }),
                recovery: 'preserve-target'
            })])
        });
    });
    assert.strictEqual(warningEditable.result.status, 'rejected');
    assert.ok(warningEditable.result.diagnostics.some(function(item) {
        return item.code === 'ADAPTER_DDL_RESULT';
    }));
    assert.strictEqual(warningEditable.applied.length, 0,
        'editable results with diagnostics must never reach host commit');

    console.log('v2 Wave 4D experimental DDL transaction tests passed');
}

main().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
