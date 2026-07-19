var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var directModule = require('../../.tmp/v2-core/adapters/executor/direct');
var persistentModule = require('../../.tmp/v2-core/adapters/executor/persistent-worker');
var connectionModule = require('../../.tmp/v2-core/adapters/executor/worker-connection');
var routedModule = require('../../.tmp/v2-core/adapters/executor/routed');

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function request(source) {
    return {
        source: source,
        options: { dialect: 'hive', unsupportedSyntaxPolicy: 'preserve' },
        mode: 'document',
        documentVersion: 7,
        targetId: 'document'
    };
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
    var runtimePath = path.join(root, 'dist', 'v2-core.cjs');
    var workerPath = path.join(root, 'dist', 'v2-worker.cjs');
    assert.ok(fs.existsSync(workerPath), 'production worker bundle must be built');
    var runtimeDigest = digest(runtimePath);
    var direct = new directModule.DirectFormatterExecutor();
    var persistent = new persistentModule.PersistentWorkerExecutor({
        workerFactory: connectionModule.createNodeWorkerFactory(workerPath, runtimePath),
        runtimeDigest: runtimeDigest
    });
    var cases = [
        'select a from t',
        'select a, b from t where a = 1',
        'with x as (select 1 as a) select a from x',
        'select `Case`, array(1, 2) from t -- comment\n'
    ];
    for (var index = 0; index < cases.length; index++) {
        var directResult = await direct.format(request(cases[index]));
        var workerResult = await persistent.format(request(cases[index]));
        assert.deepStrictEqual(workerResult, directResult,
            'direct and worker must use the same formatter artifact: case ' + index);
    }
    var stats = persistent.statistics();
    assert.strictEqual(stats.requests, cases.length);
    assert.ok(stats.lastFormattingMs >= 0);
    assert.ok(stats.lastRoundTripMs >= stats.lastFormattingMs);
    assert.ok(stats.lastTransferMs >= 0);

    var directCounter = countingExecutor('DIRECT');
    var workerCounter = countingExecutor('WORKER');
    var routed = new routedModule.RoutedFormatterExecutor(
        directCounter, workerCounter, { sourceCodeUnits: 100, leafCount: 20 }
    );
    var directRequest = request('select 1');
    await routed.format(directRequest);
    assert.strictEqual(routed.lastRoute(), 'direct');
    assert.notStrictEqual(directCounter.requests[0], directRequest,
        'router must pass a stable request snapshot to the selected executor');
    directRequest.source = 'select mutated';
    assert.strictEqual(directCounter.requests[0].source, 'select 1',
        'router snapshot must not observe later request mutation');
    await routed.format(request('select ' + new Array(150).join('a')));
    assert.strictEqual(routed.lastRoute(), 'worker');
    assert.strictEqual(directCounter.calls, 1);
    assert.strictEqual(workerCounter.calls, 1);

    var defaultRouteDirect = countingExecutor('DEFAULT_DIRECT');
    var defaultRouteWorker = countingExecutor('DEFAULT_WORKER');
    var defaultRouted = new routedModule.RoutedFormatterExecutor(
        defaultRouteDirect, defaultRouteWorker
    );
    await defaultRouted.format(request(new Array(65_537).join('a')));
    assert.strictEqual(defaultRouted.lastRoute(), 'worker',
        'default source code-unit threshold must route to worker');
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

    await routed.dispose();
    await persistent.dispose();
    await direct.dispose();
    console.log('v2 Wave 4C executor tests passed');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
