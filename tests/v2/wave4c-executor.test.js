var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var directModule = require('../../.tmp/v2-core/adapters/executor/direct');
var targetCore = require('../../.tmp/v2-core/core/api/format');
var persistentModule = require('../../.tmp/v2-core/adapters/executor/persistent-worker');
var connectionModule = require('../../.tmp/v2-core/adapters/executor/worker-connection');
var routedModule = require('../../.tmp/v2-core/adapters/executor/routed');

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function request(source, newline) {
    var value = {
        source: source,
        options: { dialect: 'hive', unsupportedSyntaxPolicy: 'preserve' },
        mode: 'document',
        documentVersion: 7,
        targetId: 'document'
    };
    if (newline !== undefined) {
        value.newline = newline;
    }
    return value;
}

function countingExecutor(label) {
    return {
        calls: 0,
        requests: [],
        format: async function(value) {
            this.calls += 1;
            this.requests.push(value);
            return {
                status: 'failed', text: value.source,
                diagnostics: [{
                    code: 'TEST_' + label, severity: 'warning', message: 'route',
                    capabilityId: null, span: { start: 0, end: value.source.length },
                    recovery: 'preserve-target'
                }]
            };
        },
        dispose: async function() {}
    };
}

async function run() {
    var runtimePath = path.join(root, 'dist', 'runtime.cjs');
    var workerPath = path.join(root, 'dist', 'formatter-worker.cjs');
    assert.ok(fs.existsSync(workerPath), 'production worker bundle must be built');
    var runtimeDigest = digest(runtimePath);
    var direct = new directModule.DirectFormatterExecutor(targetCore.formatSql);
    var persistent = new persistentModule.PersistentWorkerExecutor({
        workerFactory: connectionModule.createNodeWorkerFactory(workerPath, runtimePath),
        runtimeDigest: runtimeDigest
    });
    var cases = [
        'select a from t',
        'select a, b from t where a = 1',
        'with x as (select 1 as a) select a from x',
        'select `Case`, array(1, 2) from t -- comment\n',
        'select a,b\r\nfrom t'
    ];
    for (var index = 0; index < cases.length; index++) {
        var directResult = await direct.format(request(cases[index]));
        var workerResult = await persistent.format(request(cases[index]));
        assert.deepStrictEqual(workerResult, directResult,
            'direct and worker must use the same formatter artifact: case ' + index);
    }
    var batchSource = 'select a,b\nfrom t\n';
    var batchRequest = {
        source: batchSource,
        options: { dialect: 'hive' },
        documentVersion: 8,
        targets: [
            { id: 'select', start: 0, end: 10, mode: 'fragment' },
            { id: 'from', start: 11, end: 17, mode: 'fragment' }
        ]
    };
    var directBatch = await direct.validateAndFormat(batchRequest);
    var workerBatch = await persistent.validateAndFormat(batchRequest);
    assert.strictEqual(directBatch.status, 'completed');
    assert.deepStrictEqual(workerBatch, directBatch,
        'direct and worker batch execution must share validation and formatting semantics');
    assert.deepStrictEqual(
        workerBatch.results.map(function(value) { return value.targetId; }),
        ['select', 'from'],
        'batch execution must preserve normalized target identity and order'
    );
    var overLimitBatchSource = new Array(524290).join(' ');
    var overLimitBatch = await direct.validateAndFormat({
        source: overLimitBatchSource,
        options: { dialect: 'hive' },
        documentVersion: 9,
        targets: [{
            id: 'document', start: 0, end: overLimitBatchSource.length,
            mode: 'document'
        }]
    });
    assert.strictEqual(overLimitBatch.status, 'failed');
    assert.strictEqual(overLimitBatch.code, 'ADAPTER_INPUT_LIMIT');
    var stats = persistent.statistics();
    assert.strictEqual(stats.requests, cases.length + 1);
    assert.ok(stats.lastFormattingMs >= 0);
    assert.ok(stats.lastRoundTripMs >= stats.lastFormattingMs);
    assert.ok(stats.lastTransferMs >= 0);

    var directCounter = countingExecutor('DIRECT');
    var workerCounter = countingExecutor('WORKER');
    var routed = new routedModule.RoutedFormatterExecutor(
        directCounter, workerCounter, { sourceCodeUnits: 100, leafCount: 20 }
    );
    var directRequest = request('select 1');
    directRequest.newline = '\r\n';
    await routed.format(directRequest);
    assert.strictEqual(routed.lastRoute(), 'direct');
    assert.notStrictEqual(directCounter.requests[0], directRequest,
        'router must pass a stable request snapshot to the selected executor');
    directRequest.source = 'select mutated';
    assert.strictEqual(directCounter.requests[0].source, 'select 1',
        'router snapshot must not observe later request mutation');
    assert.strictEqual(directCounter.requests[0].newline, '\r\n',
        'router snapshot must preserve the canonical EOL environment');

    var fragmentRequest = request('select a,b from t', '\r\n');
    fragmentRequest.mode = 'fragment';
    fragmentRequest.targetId = 'fragment';
    var directFragment = await direct.format(fragmentRequest);
    var workerFragment = await persistent.format(fragmentRequest);
    assert.deepStrictEqual(workerFragment, directFragment,
        'direct and worker fragments must share the request EOL');
    assert.ok(directFragment.text.indexOf('\r\n') >= 0);
    assert.strictEqual(/(^|[^\r])\n/.test(directFragment.text), false,
        'fragment generated EOL must not fall back to LF');
    await routed.format(request('select ' + new Array(150).join('a')));
    assert.strictEqual(routed.lastRoute(), 'worker');
    assert.strictEqual(directCounter.calls, 1);
    assert.strictEqual(workerCounter.calls, 1);

    var defaultRouteDirect = countingExecutor('DEFAULT_DIRECT');
    var defaultRouteWorker = countingExecutor('DEFAULT_WORKER');
    var defaultRouted = new routedModule.RoutedFormatterExecutor(
        defaultRouteDirect, defaultRouteWorker
    );
    await defaultRouted.format(request(new Array(8192).join('a')));
    assert.strictEqual(defaultRouted.lastRoute(), 'direct',
        '8191 code units below both thresholds must remain direct');
    await defaultRouted.format(request(new Array(8193).join('a')));
    assert.strictEqual(defaultRouted.lastRoute(), 'worker',
        'default source code-unit threshold must route to worker');
    var compactUnknownRun = 'select ' + '中'.repeat(8184);
    assert.strictEqual(compactUnknownRun.length, 8191);
    await defaultRouted.format(request(compactUnknownRun));
    assert.strictEqual(defaultRouted.lastRoute(), 'direct',
        'merged unknown run below both thresholds may remain direct');
    var boundedUnknownRun = compactUnknownRun + '中';
    assert.strictEqual(boundedUnknownRun.length, 8192);
    await defaultRouted.format(request(boundedUnknownRun));
    assert.strictEqual(defaultRouted.lastRoute(), 'worker',
        'source threshold must bound merged unknown runs');
    var separatedUnknownRuns = new Array(1001).fill('中 ').join('');
    assert.ok(separatedUnknownRuns.length < 8192);
    await defaultRouted.format(request(separatedUnknownRuns));
    assert.strictEqual(defaultRouted.lastRoute(), 'worker',
        'leaf threshold must still bound separated unknown runs');
    for (var cjkDialect of ['postgresql', 'mysql']) {
        var cjkRequest = request('select ' + '字段'.repeat(1500));
        cjkRequest.options = { dialect: cjkDialect };
        await defaultRouted.format(cjkRequest);
        assert.strictEqual(defaultRouted.lastRoute(), 'direct',
            cjkDialect + ' Unicode identifier below both thresholds');
    }
    await defaultRouted.format(request(new Array(1001).join('a ')));
    assert.strictEqual(defaultRouted.lastRoute(), 'worker',
        'default leaf-count threshold must independently route to worker');
    var manyLeaves = new Array(1200).fill(
        'select a, b, c, d, e, f, g, h, i, j from t;'
    ).join('\n');
    await defaultRouted.format(request(manyLeaves));
    assert.strictEqual(defaultRouted.lastRoute(), 'worker',
        'default leaf-count threshold must route to worker');
    await defaultRouted.dispose();

    var reads = 0;
    var hostile = { mode: 'document', documentVersion: 1, targetId: 'document' };
    Object.defineProperty(hostile, 'source', {
        enumerable: true,
        get: function() { reads += 1; return 'select 1'; }
    });
    var hostileResult = await direct.format(hostile);
    assert.strictEqual(hostileResult.status, 'failed');
    assert.strictEqual(hostileResult.diagnostics[0].code, 'ADAPTER_EXECUTION_REQUEST');
    assert.strictEqual(reads, 0, 'executor request accessors must never execute');

    var invalidRequest = request('select preserve_me');
    invalidRequest.mode = 'invalid';
    var invalidResult = await direct.format(invalidRequest);
    assert.strictEqual(invalidResult.status, 'failed');
    assert.strictEqual(invalidResult.text, invalidRequest.source,
        'invalid request failure must preserve a safely snapshotted source');
    var invalidWorkerResult = await persistent.format(invalidRequest);
    assert.strictEqual(invalidWorkerResult.status, 'failed');
    assert.strictEqual(invalidWorkerResult.text, invalidRequest.source,
        'worker executor must preserve a safely snapshotted invalid source');

    var invalidNewlineRequest = request('select 1', '\r\r');
    var invalidNewlineResult = await direct.format(invalidNewlineRequest);
    assert.strictEqual(invalidNewlineResult.status, 'failed');
    assert.strictEqual(
        invalidNewlineResult.diagnostics[0].code,
        'ADAPTER_EXECUTION_REQUEST'
    );

    var privateFailure = 'select secret_value from private_table /private/path.sql';
    var throwingDirect = new directModule.DirectFormatterExecutor(function() {
        throw new Error(privateFailure);
    });
    var quietFailure = await throwingDirect.execute(Object.assign(
        request('select 1'),
        { debugEnabled: false }
    ));
    assert.deepStrictEqual(quietFailure.debugEvents, [],
        'debug events must not be collected when the opt-in flag is disabled');
    var debugFailure = await throwingDirect.execute(Object.assign(
        request('select 1'),
        { debugEnabled: true }
    ));
    assert.strictEqual(debugFailure.result.diagnostics[0].code,
        'ADAPTER_EXECUTOR_FAILED');
    assert.ok(debugFailure.result.diagnostics[0].message.indexOf('secret_value') < 0,
        'safe formatter diagnostics must not expose the internal exception');
    assert.strictEqual(debugFailure.debugEvents.length, 1);
    assert.ok(debugFailure.debugEvents[0].message.indexOf('secret_value') >= 0,
        'the opt-in internal channel must retain bounded troubleshooting context');
    assert.ok(debugFailure.debugEvents[0].message.length <= 512);
    assert.ok(debugFailure.debugEvents[0].frames.every(function(frame) {
        return /^at\s/.test(frame) && frame.length <= 512;
    }), 'debug stacks must contain only bounded call frames without the Error header');
    await throwingDirect.dispose();

    await routed.dispose();
    await persistent.dispose();
    await direct.dispose();
    console.log('v2 Wave 4C executor tests passed');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
