'use strict';

// The executor and worker (plan §5.4, §5.5): direct and worker give the same result, the worker is
// created lazily and rebuilt after a failure, and cancellation and dispose settle every request.

var assert = require('assert');
var EventEmitter = require('events');
var fs = require('fs');
var path = require('path');
var test = require('node:test');
var src = require('./helpers/src');
var m = src({ executor: 'edits/executor', compute: 'edits/compute', config: 'core/config/resolve-options' });
var WORKER = src.entry('edits/worker.ts', 'unit-worker.cjs');
var EditExecutor = m.executor.EditExecutor;
var Worker = require('worker_threads').Worker;

var THRESHOLD = 32768;

function options(extra) {
    return m.config.resolveFormatOptions(Object.assign({ dialect: 'hive', unsupportedSyntaxPolicy: 'preserve' }, extra)).options;
}

function request(source, extra) {
    return Object.assign({
        op: 'format',
        source: source,
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }],
        selections: [],
        options: options(),
        newline: '\n',
        tabSize: 4
    }, extra);
}

function large(statements, tag) {
    return Array.from({ length: statements }, function(_, index) {
        return 'select ' + (tag || 'col') + '_' + index + ',other from table_' + index + ';';
    }).join('\n');
}

function direct() {
    return new EditExecutor(function() { throw new Error('direct executors create no worker'); }, Infinity);
}

/** Every request goes to a real worker; `scripts` lists the worker scripts to start, in order. */
function viaWorker(scripts) {
    return new EditExecutor(function() {
        return new Worker(scripts === undefined ? WORKER : scripts.shift());
    }, 0);
}

/** Fake workers that record messages and reply only when told to. */
function fakeWorkers() {
    var created = [];
    return {
        created: created,
        factory: function() {
            var worker = new EventEmitter();
            worker.posted = [];
            worker.terminated = 0;
            worker.postMessage = function(message) { worker.posted.push(message); };
            worker.terminate = function() { worker.terminated += 1; return Promise.resolve(1); };
            worker.reply = function(index) {
                var message = worker.posted[index];
                worker.emit('message', { id: message.id, result: m.compute.computeEdits(message.request) });
            };
            created.push(worker);
            return worker;
        }
    };
}

function cancellation() {
    var listeners = [];
    return {
        isCancellationRequested: false,
        onCancellationRequested: function(listener) {
            listeners.push(listener);
            return { dispose: function() { listeners = listeners.filter(function(value) { return value !== listener; }); } };
        },
        cancel: function() {
            this.isCancellationRequested = true;
            listeners.slice().forEach(function(listener) { listener(); });
        },
        listeners: function() { return listeners.length; }
    };
}

function codes(result) {
    return result.diagnostics.map(function(item) { return item.code; });
}

function crashed(source) {
    return {
        status: 'rejected', edits: [], selections: [], debugEvents: [],
        diagnostics: [{
            code: 'ADAPTER_WORKER_CRASH', severity: 'error', message: 'The formatter worker stopped unexpectedly',
            capabilityId: null, span: { start: 0, end: source.length }, recovery: 'preserve-target', targetId: null
        }]
    };
}

var CANCELLED = { status: 'cancelled', edits: [], selections: [], diagnostics: [], debugEvents: [] };

test('W1 W2: the worker returns exactly what direct computation returns', async function() {
    var tabSource = 'select `a\tb` as x,\n       `abcdef` as y\nfrom t';
    var batch = 'select a,b\nfrom t\n';
    var requests = [
        request('select a from t'),
        request('select a, b from t where a = 1'),
        request('with x as (select 1 as a) select a from x'),
        request('select `Case`, array(1, 2) from t -- comment\n'),
        request('select a,b\r\nfrom t'),
        request(tabSource),
        request(tabSource, { tabSize: 8 }),
        request('select a,b from t', { newline: '\r\n' }),
        request('select a,b from t;\n\nselect c,d from u;', {
            targets: [{ id: 'second', start: 20, end: 38, mode: 'fragment' }, { id: 'first', start: 0, end: 18, mode: 'fragment' }],
            selections: [{ targetId: 'first', anchor: 8, active: 8 }, { targetId: null, anchor: 38, active: 19 }]
        }),
        request(batch, {
            targets: [{ id: 'select', start: 0, end: 10, mode: 'fragment' }, { id: 'from', start: 11, end: 17, mode: 'fragment' }]
        }),
        request('create table t (a int, bb string);\n', { op: 'hive-ddl', options: undefined, selections: [{ targetId: null, anchor: 3, active: 3 }] }),
        request('select a, b as c from t;\n', { op: 'extract', options: undefined }),
        request('select a from t', { selections: [{ targetId: null, anchor: 999, active: 999 }] })
    ];
    var executor = viaWorker();
    try {
        var results = [];
        // Stack frames name the bundle they ran in, so debug events compare by code.
        var comparable = function(result) {
            return Object.assign({}, result, { debugEvents: result.debugEvents.map(function(event) { return event.code; }) });
        };
        for (var value of requests) {
            var expected = await direct().run(value);
            var actual = await executor.run(value);
            assert.deepStrictEqual(comparable(actual), comparable(expected), value.source);
            results.push(actual);
        }
        assert.strictEqual(results[6].edits[0].text, 'SELECT\n      `a\tb` AS x\n    , `abcdef`     AS y\nFROM t');
        assert.strictEqual(results[5].edits[0].text.split('\n')[2], '    , `abcdef` AS y');
        assert.strictEqual(results[7].edits[0].text, 'SELECT\r\n      a\r\n    , b\r\nFROM t');
        assert.deepStrictEqual(results[8].edits.map(function(edit) { return edit.targetId; }), ['first', 'second']);
        assert.deepStrictEqual(results[8].selections, [{ anchor: 14, active: 14 }, { anchor: 62, active: 31 }]);
        assert.strictEqual(results[9].status, 'rejected');
        assert.deepStrictEqual(results[9].diagnostics.map(function(item) { return [item.targetId, item.code]; }),
            [['from', 'SYN_UNMODELED_CONSTRUCT']]);
        assert.strictEqual(results[10].status, 'ready');
        assert.strictEqual(results[11].edits[0].text, '     a __TYPE_REQUIRED__\n    ,c __TYPE_REQUIRED__\n');
    } finally {
        executor.dispose();
    }
});

test('W3 W4: only sources of 32 Ki code units or more reach the worker, which starts once', async function() {
    var workers = fakeWorkers();
    var executor = new EditExecutor(workers.factory);
    var below = 'select a from t;' + ' '.repeat(THRESHOLD - 1 - 16);
    var at = below + ' ';
    assert.strictEqual(workers.created.length, 0, 'construction starts no worker');
    assert.deepStrictEqual(await executor.run(request(below)), m.compute.computeEdits(request(below)));
    assert.strictEqual(workers.created.length, 0, 'below the threshold runs direct');

    var first = executor.run(request(at));
    assert.strictEqual(workers.created.length, 1);
    workers.created[0].reply(0);
    assert.deepStrictEqual(await first, m.compute.computeEdits(request(at)));
    var second = executor.run(request(at + '\n'));
    assert.strictEqual(workers.created.length, 1, 'the next request reuses the worker');
    workers.created[0].reply(1);
    assert.strictEqual((await second).status, 'ready');
    assert.deepStrictEqual(workers.created[0].posted.map(function(message) { return message.id; }), [1, 2]);
    executor.dispose();
});

test('W5: concurrent requests each get their own result', async function() {
    var workers = fakeWorkers();
    var executor = new EditExecutor(workers.factory, 0);
    var sources = ['select a from t', 'select b from u', 'select c from v'];
    var pending = sources.map(function(source) { return executor.run(request(source)); });
    [2, 0, 1].forEach(function(index) { workers.created[0].reply(index); });
    var results = await Promise.all(pending);
    results.forEach(function(result, index) {
        assert.deepStrictEqual(result, m.compute.computeEdits(request(sources[index])));
    });
    executor.dispose();

    var real = viaWorker();
    try {
        var bigSources = [large(1000, 'x'), large(1000, 'y'), large(1001, 'z')];
        results = await Promise.all(bigSources.map(function(source) { return real.run(request(source)); }));
        results.forEach(function(result, index) {
            assert.strictEqual(result.status, 'ready');
            assert.deepStrictEqual(result, m.compute.computeEdits(request(bigSources[index])));
        });
    } finally {
        real.dispose();
    }
});

test('W6: a worker error or exit fails every pending request, and the next request starts a new worker', async function() {
    for (var event of [['error', new Error('boom')], ['exit', 1]]) {
        var workers = fakeWorkers();
        var executor = new EditExecutor(workers.factory, 0);
        var first = executor.run(request('select a from t'));
        var second = executor.run(request('select b from u;'));
        workers.created[0].emit(event[0], event[1]);
        workers.created[0].emit('exit', 1);
        assert.deepStrictEqual(await first, crashed('select a from t'));
        assert.deepStrictEqual(await second, crashed('select b from u;'));
        var next = executor.run(request('select c from v'));
        assert.strictEqual(workers.created.length, 2);
        workers.created[1].reply(0);
        assert.strictEqual((await next).status, 'ready');
        executor.dispose();
    }

    var dir = path.join(__dirname, '..', '..', '.tmp', 'tests');
    var throwing = path.join(dir, 'unit-worker-throws.cjs');
    var exiting = path.join(dir, 'unit-worker-exits.cjs');
    fs.writeFileSync(throwing, 'throw new Error("boom");\n');
    fs.writeFileSync(exiting, 'process.exit(3);\n');
    var real = viaWorker([throwing, exiting, WORKER]);
    try {
        var source = large(600);
        assert.deepStrictEqual(await real.run(request(source)), crashed(source), 'a worker that throws on load');
        assert.deepStrictEqual(await real.run(request(source)), crashed(source), 'a worker that exits');
        assert.deepStrictEqual(await real.run(request(source)), m.compute.computeEdits(request(source)), 'rebuilt');
    } finally {
        real.dispose();
    }
});

test('W7: cancelling a request settles it at once; the only pending request also stops the worker', async function() {
    var workers = fakeWorkers();
    var executor = new EditExecutor(workers.factory, 0);
    var token = cancellation();
    var pending = executor.run(request('select a from t'), token);
    token.cancel();
    assert.deepStrictEqual(await pending, CANCELLED);
    assert.strictEqual(workers.created[0].terminated, 1);
    workers.created[0].reply(0);
    workers.created[0].emit('exit', 1);
    var next = executor.run(request('select b from u'));
    assert.strictEqual(workers.created.length, 2, 'the next request starts a new worker');
    workers.created[1].reply(0);
    assert.strictEqual((await next).status, 'ready');

    // With other requests pending, only the cancelled one settles and the worker keeps running.
    var other = executor.run(request('select c from v'));
    token = cancellation();
    pending = executor.run(request('select d from w'), token);
    token.cancel();
    assert.deepStrictEqual(await pending, CANCELLED);
    assert.strictEqual(workers.created[1].terminated, 0);
    workers.created[1].reply(2);
    workers.created[1].reply(1);
    assert.deepStrictEqual(await other, m.compute.computeEdits(request('select c from v')));

    token = cancellation();
    token.cancel();
    var fresh = fakeWorkers();
    var idle = new EditExecutor(fresh.factory, 0);
    assert.deepStrictEqual(await idle.run(request('select a from t'), token), CANCELLED);
    assert.strictEqual(fresh.created.length, 0, 'a cancelled token posts nothing');
    executor.dispose();

    var real = viaWorker();
    try {
        var source = large(3000);
        token = cancellation();
        pending = real.run(request(source), token);
        await new Promise(function(resolve) { setImmediate(resolve); });
        token.cancel();
        assert.deepStrictEqual(await pending, CANCELLED);
        assert.strictEqual((await real.run(request('select a from t'))).status, 'ready');
    } finally {
        real.dispose();
    }
});

test('W8: a completed request leaves no listener on its token', async function() {
    var workers = fakeWorkers();
    var executor = new EditExecutor(workers.factory, 0);
    var token = cancellation();
    var done = executor.run(request('select a from t'), token);
    assert.strictEqual(token.listeners(), 1);
    workers.created[0].reply(0);
    await done;
    assert.strictEqual(token.listeners(), 0);
    var later = executor.run(request('select b from u'));
    token.cancel();
    assert.strictEqual(workers.created[0].terminated, 0);
    workers.created[0].reply(1);
    assert.strictEqual((await later).status, 'ready');
    executor.dispose();
});

test('W9: dispose settles every pending request as cancelled and stops the worker', async function() {
    var workers = fakeWorkers();
    var executor = new EditExecutor(workers.factory, 0);
    var token = cancellation();
    var pending = [executor.run(request('select a from t'), token), executor.run(request('select b from u'))];
    executor.dispose();
    assert.deepStrictEqual(await Promise.all(pending), [CANCELLED, CANCELLED]);
    assert.strictEqual(workers.created[0].terminated, 1);
    assert.strictEqual(token.listeners(), 0);
    workers.created[0].emit('exit', 1);
});

test('W10: an internal error rejects the request with no edits, in the worker too', async function() {
    var value = request('select a from t', { selections: [{ targetId: null, anchor: 999, active: 999 }] });
    var result = m.compute.computeEdits(value);
    assert.strictEqual(result.status, 'rejected');
    assert.deepStrictEqual(result.edits, []);
    assert.deepStrictEqual(codes(result), ['ADAPTER_EXECUTOR_FAILED']);
    assert.deepStrictEqual(result.debugEvents.map(function(event) { return event.code; }), ['ADAPTER_EXECUTOR_FAILED']);
    var executor = viaWorker();
    try {
        var viaWorkerResult = await executor.run(value);
        // Stack frames name the bundle they ran in; everything else matches.
        assert.deepStrictEqual(Object.assign({}, viaWorkerResult, { debugEvents: [] }), Object.assign({}, result, { debugEvents: [] }));
        assert.deepStrictEqual(viaWorkerResult.debugEvents.map(function(event) { return event.code; }), ['ADAPTER_EXECUTOR_FAILED']);
    } finally {
        executor.dispose();
    }
});

test('R1: input over 512 Ki code units is rejected before formatting', function() {
    var over = 'select ' + 'a'.repeat(524282);
    assert.strictEqual(over.length, 524289);
    var result = m.compute.computeEdits(request(over));
    assert.strictEqual(result.status, 'rejected');
    assert.deepStrictEqual(result.diagnostics.map(function(item) { return [item.code, item.severity, item.span]; }),
        [['ADAPTER_INPUT_LIMIT', 'error', { start: 0, end: 524289 }]]);
    result = m.compute.computeEdits(request('create table t (a int);\n' + '-- '.padEnd(524289 - 24, 'x'), { op: 'hive-ddl', options: undefined }));
    assert.deepStrictEqual(result.diagnostics.map(function(item) { return [item.code, item.severity]; }),
        [['ADAPTER_DDL_INPUT_LIMIT', 'warning']]);
    assert.strictEqual(m.compute.computeEdits(request('select ' + 'a'.repeat(524281))).status, 'ready');
});
