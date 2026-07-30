'use strict';

var assert = require('assert');
var performance = require('perf_hooks').performance;
var ddl = require('../../.tmp/v2-core/experimental/ddl');
var hiveExecution = require('../../.tmp/v2-core/experimental/ddl/hive-ddl');
var cancellation = require('../../.tmp/v2-core/adapters/transaction/cancellation');
var transaction = require('../../.tmp/v2-core/adapters/transaction/experimental-ddl');
var displayWidth = require('../../.tmp/v2-core/core/renderer/display-width');
var limits = require('../../.tmp/v2-core/core/api/limits');

function snapshot(source, version, identity) {
    return Object.freeze({
        identity: identity,
        source: source,
        version: version
    });
}

function target(source, id, start, end) {
    return Object.freeze({
        id: id || 'ddl',
        start: start === undefined ? 0 : start,
        end: end === undefined ? source.length : end
    });
}

async function runOperation(source, operation, overrides, targets) {
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
    var transactionOperation = operation === ddl.formatHiveDdl ||
        operation === ddl.extractDdl
        ? function(value) { return operation(value); }
        : operation;
    var result = await transaction.runExperimentalDdlTransaction({
        document: document,
        targets: targets || [target(source)],
        newline: options.newline,
        tabSize: options.tabSize,
        debugEnabled: options.debugEnabled,
        cancellation: options.cancellation
    }, transactionOperation, commit);
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
            source: 'CREATE TABLE t (a STRING) STORED AS JSONFILE',
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
    assert.strictEqual(thrown.result.diagnostics[0].message,
        'The experimental DDL operation failed safely',
        'hostile operation text must not escape through the public DDL transaction diagnostic');
    assert.strictEqual(thrown.applied.length, 0);

    var thrownDebug = await runOperation(formattedSource, function() {
        throw new Error('private DDL operation payload');
    }, { debugEnabled: true });
    assert.strictEqual(thrownDebug.result.status, 'rejected');
    assert.strictEqual(thrownDebug.result.diagnostics[0].message,
        'The experimental DDL operation failed safely');
    assert.strictEqual(thrownDebug.result.diagnostics[0].message.indexOf('private'), -1);
    assert.strictEqual(thrownDebug.result.debugEvents.length, 1);
    assert.strictEqual(thrownDebug.result.debugEvents[0].message,
        'private DDL operation payload');

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

    var batchSource = 'CREATE TABLE a (x INT);\nCREATE TABLE b (y INT);';
    var firstEnd = batchSource.indexOf(';') + 1;
    var secondStart = firstEnd + 1;
    var batchCalls = [];
    var batch = await runOperation(batchSource, function(source) {
        batchCalls.push(source);
        return Object.freeze({
            status: 'formatted',
            source: source,
            text: source.toLowerCase(),
            diagnostics: Object.freeze([])
        });
    }, undefined, [
        target(batchSource, 'second', secondStart, batchSource.length),
        target(batchSource, 'first', 0, firstEnd)
    ]);
    assert.deepStrictEqual(batchCalls, [
        batchSource.slice(0, firstEnd),
        batchSource.slice(secondStart)
    ], 'batch operations must run in source order');
    assert.strictEqual(batch.result.status, 'ready');
    assert.deepStrictEqual(batch.result.edits.map(function(item) { return item.targetId; }), [
        'first', 'second'
    ], 'batch edits must be sorted in source order');
    assert.strictEqual(batch.applied.length, 1, 'batch edits must apply exactly once');

    var failedBatchCalls = [];
    var failedBatch = await runOperation(batchSource, function(source) {
        failedBatchCalls.push(source);
        if (source === batchSource.slice(secondStart)) {
            return Object.freeze({
                status: 'unsupported',
                source: source,
                text: source,
                diagnostics: Object.freeze([Object.freeze({
                    code: 'DDL_UNSUPPORTED',
                    severity: 'warning',
                    message: 'unsupported',
                    capabilityId: null,
                    span: Object.freeze({ start: 0, end: source.length }),
                    recovery: 'preserve-target'
                })])
            });
        }
        return Object.freeze({
            status: 'formatted',
            source: source,
            text: source.toLowerCase(),
            diagnostics: Object.freeze([])
        });
    }, undefined, [
        target(batchSource, 'first', 0, firstEnd),
        target(batchSource, 'second', secondStart, batchSource.length)
    ]);
    assert.strictEqual(failedBatch.result.status, 'rejected');
    assert.strictEqual(failedBatch.applied.length, 0,
        'any non-editable/diagnostic target must prevent the entire batch commit');
    assert.strictEqual(failedBatchCalls.length, 2,
        'each target must be evaluated before the batch can commit');

    var allUnchanged = await runOperation(batchSource, function(source) {
        return Object.freeze({
            status: 'unchanged',
            source: source,
            text: source,
            diagnostics: Object.freeze([])
        });
    }, undefined, [
        target(batchSource, 'first', 0, firstEnd),
        target(batchSource, 'second', secondStart, batchSource.length)
    ]);
    assert.strictEqual(allUnchanged.result.status, 'unchanged');
    assert.deepStrictEqual(allUnchanged.result.edits, []);
    assert.strictEqual(allUnchanged.applied.length, 0,
        'all unchanged targets must not invoke host commit');

    var debugDdlLines = [];
    var debugDdlTargets = [];
    var debugDdlOffset = 0;
    for (var debugDdlIndex = 0; debugDdlIndex < 65; debugDdlIndex++) {
        var debugDdlLine = 'CREATE TABLE d' + debugDdlIndex + ' (a INT);';
        debugDdlLines.push(debugDdlLine);
        debugDdlTargets.push(target(
            '',
            'debug-ddl-' + debugDdlIndex,
            debugDdlOffset,
            debugDdlOffset + debugDdlLine.length
        ));
        debugDdlOffset += debugDdlLine.length + 1;
    }
    var debugDdlSource = debugDdlLines.join('\n');
    var debugDdlBatch = await runOperation(debugDdlSource, function(source) {
        return Object.freeze({
            status: 'unchanged', source: source, text: source,
            diagnostics: Object.freeze([]),
            debugEvents: Object.freeze([Object.freeze({
                phase: 'analysis', code: 'DDL_INTERNAL', errorName: 'Error',
                message: 'bounded DDL debug event', frames: Object.freeze([])
            })])
        });
    }, undefined, debugDdlTargets);
    assert.strictEqual(debugDdlBatch.result.status, 'unchanged');
    assert.strictEqual(debugDdlBatch.result.debugEvents.length, 64);
    assert.strictEqual(debugDdlBatch.result.debugEvents[63].code,
        'ADAPTER_DEBUG_EVENTS_TRUNCATED',
        'multi-target DDL debug evidence must truncate at the shared cap');

    var overlapping = await runOperation(batchSource, function(source) {
        return Object.freeze({
            status: 'formatted',
            source: source,
            text: source.toLowerCase(),
            diagnostics: Object.freeze([])
        });
    }, undefined, [
        target(batchSource, 'left', 0, firstEnd),
        target(batchSource, 'right', firstEnd - 1, batchSource.length)
    ]);
    assert.strictEqual(overlapping.result.status, 'rejected');
    assert.strictEqual(overlapping.applied.length, 0,
        'overlapping targets must fail closed before operation or commit');

    var emptyBatch = await runOperation(batchSource, function() {
        throw new Error('empty DDL batch must not execute');
    }, undefined, []);
    assert.strictEqual(emptyBatch.result.status, 'rejected');
    assert.strictEqual(emptyBatch.applied.length, 0,
        'empty DDL batch must fail closed without host commit');

    var protectedSource = "SELECT 'create table t (a int);' AS payload";
    var protectedStart = protectedSource.indexOf('create table');
    var protectedEnd = protectedSource.indexOf("' AS payload");
    var protectedCalls = 0;
    var protectedTarget = await runOperation(protectedSource, function(source) {
        protectedCalls += 1;
        return ddl.formatHiveDdl(source);
    }, undefined, [target(
        protectedSource,
        'inside-string',
        protectedStart,
        protectedEnd
    )]);
    assert.strictEqual(protectedTarget.result.status, 'rejected');
    assert.strictEqual(protectedTarget.result.diagnostics[0].code, 'ADAPTER_DDL_RANGE');
    assert.strictEqual(protectedCalls, 0,
        'DDL transaction must reject protected-content targets before operation');
    assert.strictEqual(protectedTarget.applied.length, 0);

    var partialLine = await runOperation(
        'prefix CREATE TABLE t (a INT); suffix',
        ddl.formatHiveDdl,
        undefined,
        [target('prefix CREATE TABLE t (a INT); suffix', 'partial-line', 7, 30)]
    );
    assert.strictEqual(partialLine.result.status, 'rejected');
    assert.strictEqual(partialLine.result.diagnostics[0].code, 'ADAPTER_DDL_RANGE');
    assert.strictEqual(partialLine.applied.length, 0,
        'DDL transaction must reject non-line-complete selections');

    var crlfSource = 'CREATE TABLE t (a INT);\r\nSELECT 1';
    var crlfMidpoint = crlfSource.indexOf('\n');
    var crlfCalls = 0;
    var crlfOperation = function(source) {
        crlfCalls += 1;
        return ddl.formatHiveDdl(source);
    };
    var crlfEndTarget = await runOperation(
        crlfSource,
        crlfOperation,
        undefined,
        [target(crlfSource, 'crlf-midpoint', 0, crlfMidpoint)]
    );
    assert.strictEqual(crlfEndTarget.result.status, 'rejected');
    assert.strictEqual(crlfEndTarget.result.diagnostics[0].code, 'ADAPTER_DDL_RANGE');
    assert.strictEqual(crlfEndTarget.applied.length, 0,
        'DDL target must not end between CR and LF code units');

    var crlfStartTarget = await runOperation(
        crlfSource,
        crlfOperation,
        undefined,
        [target(crlfSource, 'crlf-midpoint-start', crlfMidpoint, crlfSource.length)]
    );
    assert.strictEqual(crlfStartTarget.result.status, 'rejected');
    assert.strictEqual(crlfStartTarget.result.diagnostics[0].code, 'ADAPTER_DDL_RANGE');
    assert.strictEqual(crlfStartTarget.applied.length, 0,
        'DDL target must not start between CR and LF code units');
    assert.strictEqual(crlfCalls, 0,
        'CRLF midpoint targets must fail before the DDL operation runs');

    function applyPrepared(source, result) {
        return result.edits.slice().sort(function(left, right) {
            return right.start - left.start;
        }).reduce(function(value, edit) {
            return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
        }, source);
    }

    var indentedLfSource = 'SELECT 1;\n    create table t (a int);   \nSELECT 2;';
    var indentedLfStart = indentedLfSource.indexOf('create table');
    var indentedLfEnd = indentedLfSource.indexOf(';', indentedLfStart) + 1;
    var indentedLf = await runOperation(
        indentedLfSource,
        ddl.formatHiveDdl,
        { newline: '\n' },
        [target(indentedLfSource, 'indented-lf', indentedLfStart, indentedLfEnd)]
    );
    assert.strictEqual(indentedLf.result.status, 'ready');
    assert.strictEqual(applyPrepared(indentedLfSource, indentedLf.result), [
        'SELECT 1;',
        '    CREATE TABLE t',
        '    (',
        '         a INT',
        '    );',
        'SELECT 2;'
    ].join('\n'), 'LF DDL replacement must inherit indentation and consume trailing whitespace');
    assert.strictEqual(indentedLf.result.edits[0].end,
        indentedLfSource.indexOf('SELECT 2;'),
        'LF replacement must consume exactly the validated trailing line boundary');

    var indentedCrlfSource = 'SELECT 1;\r\n\tcreate table t (a int);\t \r\nSELECT 2;';
    var indentedCrlfStart = indentedCrlfSource.indexOf('create table');
    var indentedCrlfEnd = indentedCrlfSource.indexOf(';', indentedCrlfStart) + 1;
    var indentedCrlf = await runOperation(
        indentedCrlfSource,
        ddl.formatHiveDdl,
        { newline: '\r\n' },
        [target(
            indentedCrlfSource,
            'indented-crlf',
            indentedCrlfStart,
            indentedCrlfEnd
        )]
    );
    assert.strictEqual(indentedCrlf.result.status, 'ready');
    assert.strictEqual(applyPrepared(indentedCrlfSource, indentedCrlf.result), [
        'SELECT 1;',
        '\tCREATE TABLE t',
        '\t(',
        '\t     a INT',
        '\t);',
        'SELECT 2;'
    ].join('\r\n'), 'CRLF DDL replacement must retain CRLF and tab indentation');
    assert.strictEqual(indentedCrlf.result.edits[0].text.indexOf('\n') >= 0, true);
    assert.strictEqual(/(^|[^\r])\n/.test(indentedCrlf.result.edits[0].text), false,
        'CRLF replacement must not contain lone LF');

    var displayColumnSource =
        '  CREATE TABLE t (`a\tb` STRING, ascii STRING, `中` STRING)\n';
    var displayColumnStart = displayColumnSource.indexOf('CREATE TABLE');
    var displayColumnEnd = displayColumnSource.indexOf('\n');
    var displayColumnResult = await runOperation(
        displayColumnSource,
        function(source, context) {
            return hiveExecution.executeFormatHiveDdl(
                source,
                { indentStyle: 'space' },
                false,
                context.tabSize,
                context.startColumn
            );
        },
        { newline: '\n', tabSize: 8 },
        [target(
            displayColumnSource,
            'display-column',
            displayColumnStart,
            displayColumnEnd
        )]
    );
    assert.strictEqual(displayColumnResult.result.status, 'ready');
    var renderedTypeColumns = displayColumnResult.result.edits[0].text
        .split('\n')
        .filter(function(line) { return line.indexOf(' STRING') >= 0; })
        .map(function(line) {
            return displayWidth.displayWidth(
                line.slice(0, line.lastIndexOf('STRING')),
                0,
                8
            );
        });
    assert.strictEqual(new Set(renderedTypeColumns).size, 1,
        'indented transaction edits must align using the target start column');

    var contextSource = [
        '  CREATE TABLE a (x INT)',
        '\tCREATE TABLE b (y INT)'
    ].join('\n');
    var contextSecondStart = contextSource.indexOf('CREATE TABLE b');
    var contexts = [];
    var contextResult = await runOperation(
        contextSource,
        function(source, context) {
            contexts.push(context);
            return {
                status: 'unchanged',
                source: source,
                text: source,
                diagnostics: []
            };
        },
        { tabSize: 8 },
        [
            target(contextSource, 'spaces', 2, contextSource.indexOf('\n')),
            target(contextSource, 'tab', contextSecondStart, contextSource.length)
        ]
    );
    assert.strictEqual(contextResult.result.status, 'unchanged');
    assert.deepStrictEqual(contexts.map(function(context) {
        return [context.tabSize, context.startColumn];
    }), [[8, 2], [8, 8]],
    'multi-target transactions must derive an independent immutable context');
    assert.ok(contexts.every(Object.isFrozen),
        'per-target DDL execution contexts must be immutable');
    var invalidTabTransaction = await runOperation(
        'CREATE TABLE t (a INT)',
        function() {
            throw new Error('invalid tabSize must reject before DDL execution');
        },
        { tabSize: 0 }
    );
    assert.strictEqual(invalidTabTransaction.result.status, 'rejected');
    assert.strictEqual(
        invalidTabTransaction.result.diagnostics[0].code,
        'ADAPTER_DDL_TRANSACTION'
    );
    assert.strictEqual(invalidTabTransaction.applied.length, 0);
    var transactionLimitPrefix = 'CREATE TABLE limit_probe (a INT)';
    var overLimitTransactionSource = transactionLimitPrefix + ' '.repeat(
        limits.MAX_FORMAT_SOURCE_CODE_UNITS + 1 - transactionLimitPrefix.length
    );
    var overLimitOperationCalls = 0;
    var overLimitTransaction = await runOperation(
        overLimitTransactionSource,
        function() {
            overLimitOperationCalls += 1;
            throw new Error('over-limit transaction must reject before operation');
        }
    );
    assert.strictEqual(overLimitTransaction.result.status, 'rejected');
    assert.strictEqual(
        overLimitTransaction.result.diagnostics[0].code,
        'ADAPTER_DDL_INPUT_LIMIT'
    );
    assert.strictEqual(overLimitOperationCalls, 0);
    assert.strictEqual(overLimitTransaction.applied.length, 0,
        'over-limit experimental DDL documents must never reach host commit');

    var literalQuote = String.fromCharCode(39);
    var literalSpaceSource = 'CREATE TABLE t (a STRING COMMENT ' +
        literalQuote + 'x  \ny' + literalQuote + ')';
    var literalSpace = await runOperation(
        literalSpaceSource,
        ddl.formatHiveDdl,
        { newline: '\n' }
    );
    assert.strictEqual(literalSpace.result.status, 'ready');
    assert.ok(literalSpace.result.edits[0].text.indexOf(
        literalQuote + 'x  \ny' + literalQuote
    ) >= 0, 'DDL transaction must preserve line-end spaces inside string literals');

    var literalLfSource = 'CREATE TABLE t (a STRING COMMENT ' +
        literalQuote + 'x\ny' + literalQuote + ')';
    var literalCrlf = await runOperation(
        literalLfSource,
        ddl.formatHiveDdl,
        { newline: '\r\n' }
    );
    assert.strictEqual(literalCrlf.result.status, 'ready');
    assert.ok(literalCrlf.result.edits[0].text.indexOf(
        literalQuote + 'x\ny' + literalQuote
    ) >= 0, 'document CRLF normalization must not rewrite literal LF bytes');

    var indentedLiteralSource = '    ' + literalLfSource;
    var indentedLiteral = await runOperation(
        indentedLiteralSource,
        ddl.formatHiveDdl,
        { newline: '\n' },
        [target(
            indentedLiteralSource,
            'indented-literal',
            4,
            indentedLiteralSource.length
        )]
    );
    assert.strictEqual(indentedLiteral.result.status, 'ready');
    assert.ok(indentedLiteral.result.edits[0].text.indexOf(
        literalQuote + 'x\ny' + literalQuote
    ) >= 0, 'selection indentation must not be injected inside string literals');

    var protectedLeafSource = 'CREATE TABLE t (a INT)';
    var protectedLeafOutput = 'CREATE TABLE t\n(\n `a\nb` INT /*x  \ny*/\n)\n';
    var protectedLeafResult = await runOperation(
        protectedLeafSource,
        function(source) {
            return Object.freeze({
                status: 'formatted',
                source: source,
                text: protectedLeafOutput,
                diagnostics: Object.freeze([])
            });
        },
        { newline: '\r\n' }
    );
    assert.strictEqual(protectedLeafResult.result.status, 'ready');
    assert.ok(protectedLeafResult.result.edits[0].text.indexOf('`a\nb`') >= 0,
        'quoted identifier EOL must remain protected from document normalization');
    assert.ok(protectedLeafResult.result.edits[0].text.indexOf('/*x  \ny*/') >= 0,
        'block comment EOL and trailing spaces must remain protected');

    var largeValues = [];
    var largeTargets = [];
    var largeOffset = 0;
    var largePadding = new Array(390).join('x');
    for (var largeIndex = 0; largeIndex < 1200; largeIndex++) {
        var statement = 'CREATE TABLE t' + largeIndex +
            " (c INT COMMENT '" + largePadding + "');";
        largeValues.push(statement);
        largeTargets.push(target(
            '',
            'large-' + largeIndex,
            largeOffset,
            largeOffset + statement.length
        ));
        largeOffset += statement.length + 1;
    }
    var largeSource = largeValues.join('\n');
    var largeStarted = performance.now();
    var largeBatch = await runOperation(largeSource, function(source) {
        return Object.freeze({
            status: 'unchanged',
            source: source,
            text: source,
            diagnostics: Object.freeze([])
        });
    }, undefined, largeTargets);
    var largeElapsed = performance.now() - largeStarted;
    assert.strictEqual(largeBatch.result.status, 'unchanged');
    assert.ok(largeSource.length > 500000,
        'DDL host performance fixture must exercise a production-sized document');
    assert.ok(largeElapsed < 1000,
        '1200-target DDL validation must remain below 1000ms, got ' + largeElapsed + 'ms');

    var cancelledLargeController = cancellation.createCancellationController();
    cancelledLargeController.cancel();
    var cancelledLargeCalls = 0;
    var cancelledLargeStarted = performance.now();
    var cancelledLarge = await runOperation(largeSource, function(source) {
        cancelledLargeCalls += 1;
        return Object.freeze({
            status: 'unchanged',
            source: source,
            text: source,
            diagnostics: Object.freeze([])
        });
    }, { cancellation: cancelledLargeController.token }, largeTargets);
    var cancelledLargeElapsed = performance.now() - cancelledLargeStarted;
    assert.strictEqual(cancelledLarge.result.status, 'cancelled');
    assert.strictEqual(cancelledLargeCalls, 0);
    assert.ok(cancelledLargeElapsed < 250,
        'pre-cancelled DDL must bypass target validation, got ' + cancelledLargeElapsed + 'ms');

    console.log('v2 Wave 4D experimental DDL transaction tests passed');
}

main().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
