var assert = require('assert');
var crypto = require('crypto');
var persistentModule = require('../../.tmp/v2-core/adapters/executor/persistent-worker');
var cancellationModule = require('../../.tmp/v2-core/adapters/transaction/cancellation');

var RUNTIME_DIGEST = crypto.createHash('sha256').update('runtime').digest('hex');

function sourceMap(length) {
    return { entries: length === 0 ? [] : [{
        source: { start: 0, end: length }, output: { start: 0, end: length }
    }] };
}

function request(id, token) {
    return {
        source: 'select ' + id,
        options: { dialect: 'hive' },
        mode: 'document', documentVersion: id, targetId: 'target:' + id,
        cancellation: token
    };
}

function FakeWorker(generation, factory) {
    this.generation = generation;
    this.factory = factory;
    this.handlers = null;
    this.messages = [];
    this.terminated = 0;
}
FakeWorker.prototype.postMessage = function(value) {
    this.messages.push(value);
    this.factory.onPost(this, value);
};
FakeWorker.prototype.setHandlers = function(handlers) {
    this.handlers = handlers;
    var self = this;
    return function() { self.handlers = null; };
};
FakeWorker.prototype.terminate = async function() {
    this.terminated += 1;
    return 0;
};
FakeWorker.prototype.respond = function(message, overrides) {
    var response = Object.assign({
        kind: 'result',
        requestId: message.requestId,
        generation: message.generation,
        documentVersion: message.documentVersion,
        targetId: message.targetId,
        sourceDigest: message.sourceDigest,
        runtimeDigest: RUNTIME_DIGEST,
        formattingMs: 1,
        result: {
            status: 'unchanged', text: message.source, diagnostics: [],
            sourceMap: sourceMap(message.source.length)
        }
    }, overrides || {});
    this.handlers.message(response);
};
FakeWorker.prototype.crash = function() {
    var handlers = this.handlers;
    handlers.error(new Error('worker crash'));
    handlers.exit(1);
};

function fakeFactory(onPost) {
    var factory = {
        workers: [],
        onPost: onPost,
        create: function(generation) {
            var worker = new FakeWorker(generation, factory);
            factory.workers.push(worker);
            return worker;
        }
    };
    return factory;
}

async function tick() {
    await new Promise(function(resolve) { setImmediate(resolve); });
}

async function run() {
    var queuedFactory = fakeFactory(function() {});
    var queuedExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: queuedFactory.create, runtimeDigest: RUNTIME_DIGEST
    });
    var first = queuedExecutor.format(request(1));
    var queuedController = cancellationModule.createCancellationController();
    var queued = queuedExecutor.format(request(2, queuedController.token));
    queuedController.cancel();
    assert.strictEqual((await queued).diagnostics[0].code, 'ADAPTER_CANCELLED');
    assert.strictEqual(queuedFactory.workers[0].messages.length, 1,
        'queued cancellation must not terminate or dispatch the queued request');
    queuedFactory.workers[0].respond(queuedFactory.workers[0].messages[0]);
    assert.strictEqual((await first).status, 'unchanged');
    assert.strictEqual(queuedFactory.workers[0].terminated, 0);
    await queuedExecutor.dispose();

    var activeFactory = fakeFactory(function() {});
    var activeExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: activeFactory.create, runtimeDigest: RUNTIME_DIGEST
    });
    var activeController = cancellationModule.createCancellationController();
    var active = activeExecutor.format(request(3, activeController.token));
    activeController.cancel();
    assert.strictEqual((await active).diagnostics[0].code, 'ADAPTER_CANCELLED');
    await tick();
    assert.strictEqual(activeFactory.workers[0].terminated, 1,
        'active cancellation must terminate the worker');
    var afterCancel = activeExecutor.format(request(4));
    assert.strictEqual(activeFactory.workers.length, 2,
        'the next request after active cancellation must use a new generation');
    activeFactory.workers[1].respond(activeFactory.workers[1].messages[0]);
    assert.strictEqual((await afterCancel).status, 'unchanged');
    await activeExecutor.dispose();

    var crashFactory = fakeFactory(function() {});
    var crashExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: crashFactory.create, runtimeDigest: RUNTIME_DIGEST
    });
    var crashed = crashExecutor.format(request(5));
    var queuedAfterCrash = crashExecutor.format(request(6));
    crashFactory.workers[0].crash();
    assert.strictEqual((await crashed).diagnostics[0].code, 'ADAPTER_WORKER_CRASH');
    await tick();
    assert.strictEqual(crashFactory.workers.length, 2,
        'worker crash must restart for queued requests');
    crashFactory.workers[1].respond(crashFactory.workers[1].messages[0]);
    assert.strictEqual((await queuedAfterCrash).status, 'unchanged');
    await crashExecutor.dispose();

    var staleFactory = fakeFactory(function() {});
    var staleExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: staleFactory.create, runtimeDigest: RUNTIME_DIGEST
    });
    var stalePromise = staleExecutor.format(request(7));
    var staleMessage = staleFactory.workers[0].messages[0];
    staleFactory.workers[0].respond(staleMessage, { requestId: staleMessage.requestId + 99 });
    staleFactory.workers[0].respond(staleMessage, { generation: staleMessage.generation + 1 });
    staleFactory.workers[0].respond(staleMessage, {
        documentVersion: staleMessage.documentVersion + 1
    });
    staleFactory.workers[0].respond(staleMessage, {
        targetId: staleMessage.targetId + ':stale'
    });
    staleFactory.workers[0].respond(staleMessage, {
        sourceDigest: new Array(65).join('0')
    });
    staleFactory.workers[0].respond(staleMessage, {
        runtimeDigest: new Array(65).join('0')
    });
    var settled = false;
    stalePromise.then(function() { settled = true; });
    await tick();
    assert.strictEqual(settled, false, 'stale response must not resolve the active request');
    staleFactory.workers[0].respond(staleMessage);
    assert.strictEqual((await stalePromise).status, 'unchanged');
    assert.strictEqual(staleExecutor.statistics().staleResponses, 6);

    var timeoutFactory = fakeFactory(function() {});
    var timeoutExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: timeoutFactory.create,
        runtimeDigest: RUNTIME_DIGEST,
        requestTimeoutMs: 20
    });
    var timedOut = timeoutExecutor.format(request(11));
    var timeoutMessage = timeoutFactory.workers[0].messages[0];
    timeoutFactory.workers[0].respond(timeoutMessage, {
        sourceDigest: new Array(65).join('0')
    });
    assert.strictEqual((await timedOut).diagnostics[0].code,
        'ADAPTER_WORKER_TIMEOUT',
        'a lone stale response must not leave the request pending forever');
    await timeoutExecutor.dispose();

    var retirementFactory = fakeFactory(function() {});
    var retirementResolvers = [];
    retirementFactory.create = function(generation) {
        var worker = new FakeWorker(generation, retirementFactory);
        worker.terminate = function() {
            this.terminated += 1;
            return new Promise(function(resolve) {
                retirementResolvers.push(resolve);
            });
        };
        retirementFactory.workers.push(worker);
        return worker;
    };
    var retirementExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: retirementFactory.create,
        runtimeDigest: RUNTIME_DIGEST
    });
    var retirementController = cancellationModule.createCancellationController();
    var retiring = retirementExecutor.format(request(12, retirementController.token));
    retirementController.cancel();
    assert.strictEqual((await retiring).diagnostics[0].code, 'ADAPTER_CANCELLED');
    var afterRetirement = retirementExecutor.format(request(13));
    assert.strictEqual(retirementFactory.workers.length, 1,
        'a replacement worker must wait for active termination to finish');
    retirementResolvers.shift()(0);
    await tick();
    assert.strictEqual(retirementFactory.workers.length, 2);
    retirementFactory.workers[1].respond(retirementFactory.workers[1].messages[0]);
    assert.strictEqual((await afterRetirement).status, 'unchanged');

    var disposeController = cancellationModule.createCancellationController();
    var disposeActive = retirementExecutor.format(request(14, disposeController.token));
    disposeController.cancel();
    assert.strictEqual((await disposeActive).diagnostics[0].code, 'ADAPTER_CANCELLED');
    var disposeSettled = false;
    var retirementDispose = retirementExecutor.dispose().then(function() {
        disposeSettled = true;
    });
    var secondDisposeSettled = false;
    var secondRetirementDispose = retirementExecutor.dispose().then(function() {
        secondDisposeSettled = true;
    });
    await tick();
    assert.strictEqual(disposeSettled, false,
        'dispose must await termination already started by active cancellation');
    assert.strictEqual(secondDisposeSettled, false,
        'concurrent dispose calls must await the same termination');
    retirementResolvers.shift()(0);
    await Promise.all([retirementDispose, secondRetirementDispose]);
    assert.strictEqual(disposeSettled, true);
    assert.strictEqual(secondDisposeSettled, true);

    var synchronousFailureFactory = fakeFactory(function() {});
    var synchronousFailureResolvers = [];
    synchronousFailureFactory.create = function(generation) {
        var worker = new FakeWorker(generation, synchronousFailureFactory);
        worker.setHandlers = function(handlers) {
            this.handlers = handlers;
            handlers.message({ kind: 'result' });
            handlers.error(new Error('synchronous setup failure'));
            var self = this;
            return function() { self.handlers = null; };
        };
        worker.terminate = function() {
            this.terminated += 1;
            return new Promise(function(resolve) {
                synchronousFailureResolvers.push(resolve);
            });
        };
        synchronousFailureFactory.workers.push(worker);
        return worker;
    };
    var synchronousFailureExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: synchronousFailureFactory.create,
        runtimeDigest: RUNTIME_DIGEST,
        maxConsecutiveFailures: 1
    });
    var synchronousFailurePromise = synchronousFailureExecutor.format(request(10));
    var synchronousFailureQueued = synchronousFailureExecutor.format(request(11));
    var synchronousFailure = await synchronousFailurePromise;
    assert.strictEqual(synchronousFailure.diagnostics[0].code,
        'ADAPTER_WORKER_UNAVAILABLE');
    synchronousFailureResolvers.shift()(0);
    assert.strictEqual((await synchronousFailureQueued).diagnostics[0].code,
        'ADAPTER_WORKER_UNAVAILABLE',
        'initialization failure circuit must drain queued requests');
    assert.strictEqual(synchronousFailureFactory.workers.length, 1,
        'initialization failure must not bypass the failure threshold');
    await tick();
    assert.strictEqual(synchronousFailureFactory.workers[0].terminated, 1,
        'synchronous setup failure must clean up the partial worker');
    await synchronousFailureExecutor.dispose();

    var boundedFactory = fakeFactory(function() {});
    var boundedExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: boundedFactory.create,
        runtimeDigest: RUNTIME_DIGEST,
        maxQueueSize: 1,
        maxQueuedSourceCodeUnits: 1000
    });
    var boundedFirst = boundedExecutor.format(request(20));
    var boundedSecond = boundedExecutor.format(request(21));
    var alreadyCancelledController = cancellationModule.createCancellationController();
    alreadyCancelledController.cancel();
    var alreadyCancelled = await boundedExecutor.format(
        request(22, alreadyCancelledController.token)
    );
    assert.strictEqual(alreadyCancelled.diagnostics[0].code, 'ADAPTER_CANCELLED',
        'cancellation must win over queue backpressure');
    var boundedThird = await boundedExecutor.format(request(23));
    assert.strictEqual(boundedThird.diagnostics[0].code,
        'ADAPTER_WORKER_BACKPRESSURE');
    assert.strictEqual(boundedFactory.workers[0].messages.length, 1,
        'backpressure must not dispatch over the queue bound');
    boundedFactory.workers[0].respond(boundedFactory.workers[0].messages[0]);
    assert.strictEqual((await boundedFirst).status, 'unchanged');
    boundedFactory.workers[0].respond(boundedFactory.workers[0].messages[1]);
    assert.strictEqual((await boundedSecond).status, 'unchanged');
    await boundedExecutor.dispose();

    var lateCancellationFactory = fakeFactory(function() {});
    var lateCancellationExecutor = new persistentModule.PersistentWorkerExecutor({
        workerFactory: lateCancellationFactory.create,
        runtimeDigest: RUNTIME_DIGEST
    });
    var lateCancelled = false;
    var lateToken = {
        get isCancellationRequested() { return lateCancelled; },
        onCancellationRequested: function() { return function() {}; }
    };
    var lateCancellation = lateCancellationExecutor.format(request(23, lateToken));
    lateCancelled = true;
    lateCancellationFactory.workers[0].respond(
        lateCancellationFactory.workers[0].messages[0]
    );
    assert.strictEqual((await lateCancellation).diagnostics[0].code,
        'ADAPTER_CANCELLED',
        'response handling must re-check cancellation state');
    await tick();
    assert.strictEqual(lateCancellationFactory.workers[0].terminated, 1,
        'late active cancellation must retire the worker before reuse');
    await lateCancellationExecutor.dispose();

    var disposeFirst = staleExecutor.format(request(8));
    var disposeSecond = staleExecutor.format(request(9));
    await staleExecutor.dispose();
    assert.strictEqual((await disposeFirst).diagnostics[0].code, 'ADAPTER_CANCELLED');
    assert.strictEqual((await disposeSecond).diagnostics[0].code, 'ADAPTER_CANCELLED');
    console.log('v2 Wave 4C worker lifecycle tests passed');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
