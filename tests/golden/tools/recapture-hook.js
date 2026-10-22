'use strict';

// P1 one-off (deleted with the old tests in P2): preloaded with `node -r` into an old test file,
// it records every formatter / DDL call with the full execution environment (mode, newline,
// tabSize, startColumn), and separately the calls whose output the test asserts verbatim. Only
// explicitly passed values are recorded, so an omitted newline stays "inferred" instead of being
// frozen to LF.

var assert = require('assert');
var fs = require('fs');
var Module = require('module');
var util = require('util');

var out = process.env.GOLDEN_RECAPTURE_OUT;
var CALLS = {
    formatSql: 'formatSql',
    formatSqlWithStatistics: 'formatSql',
    executeFormatSql: 'formatSql',
    formatHiveDdl: 'formatHiveDdl',
    executeFormatHiveDdl: 'formatHiveDdl',
    extractDdl: 'extractDdl',
    executeExtractDdl: 'extractDdl',
};
var MODULES = /[\\/](?:\.tmp[\\/]v2-core[\\/](?:core[\\/]api[\\/]format|experimental[\\/]ddl[\\/](?:index|hive-ddl|extract)|runtime[\\/](?:index|internal|experimental-ddl|formatter))\.js|dist[\\/](?:runtime|sql-formatter|hive-ddl)\.cjs)$/;
var byText = new Map();
var hits = new Map();
var calls = new Map();
var wrapped = new WeakMap();

function plainOptions(value) {
    if (value === undefined) {
        return { ok: true, value: undefined };
    }
    if (value === null || typeof value !== 'object' || util.types.isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        return { ok: false };
    }
    var names = Object.getOwnPropertyNames(value);
    if (names.some(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(value, name);
        return !('value' in descriptor) || (descriptor.value !== null && typeof descriptor.value === 'object');
    })) {
        return { ok: false };
    }
    var copy = {};
    names.sort().forEach(function(name) { copy[name] = value[name]; });
    return { ok: true, value: copy };
}

function environmentOf(name, args) {
    var env = {};
    if (CALLS[name] === 'formatSql') {
        if (args[2] !== undefined) {
            env.mode = args[2];
        }
        var value = args[3];
        if (typeof value === 'string') {
            env.newline = value;
        } else if (value !== undefined && value !== null && typeof value === 'object') {
            env.newline = value.newline;
            env.tabSize = value.tabSize;
        }
        if (name === 'executeFormatSql' && args[5] !== undefined) {
            env.tabSize = args[5];
        }
    } else {
        if (args[3] !== undefined) {
            env.tabSize = args[3];
        }
        if (args[4] !== undefined) {
            env.startColumn = args[4];
        }
    }
    return env;
}

function callKey(entry) {
    return JSON.stringify([entry.op, entry.source, entry.options, entry.mode, entry.newline,
        entry.tabSize, entry.startColumn]);
}

function record(name, args, returned) {
    var source = args[0];
    var result = returned && returned.result ? returned.result : returned;
    if (typeof source !== 'string' || source.length > 4000 || !result ||
        typeof result.text !== 'string') {
        return;
    }
    var options = plainOptions(args[1]);
    if (!options.ok) {
        return;
    }
    var env = environmentOf(name, args);
    if (typeof env.mode === 'string' && ['document', 'statement', 'fragment'].indexOf(env.mode) < 0) {
        return;
    }
    var entry = Object.assign({ op: CALLS[name], source: source, options: options.value }, env, {
        status: result.status,
        text: result.text,
    });
    var key = callKey(entry);
    if (!calls.has(key)) {
        calls.set(key, entry);
    }
    var previous = byText.get(result.text);
    // An identity call (text === source) must not shadow a formatting call with the same text.
    if (!(previous && previous.text !== previous.source && entry.text === entry.source)) {
        byText.set(result.text, entry);
    }
}

// One wrapper per original function keeps identity checks such as `facade.formatSql === runtime.formatSql`.
var wrappedFunctions = new WeakMap();
var wrappers = new WeakSet();
function wrapFunction(key, original) {
    if (wrappers.has(original)) {
        return original;
    }
    if (wrappedFunctions.has(original)) {
        return wrappedFunctions.get(original);
    }
    var wrapper = function() {
        var returned = original.apply(this, arguments);
        try {
            record(key, arguments, returned);
        } catch (error) {
            // Recording must never change the test's behaviour.
        }
        return returned;
    };
    Object.defineProperty(wrapper, 'length', { value: original.length });
    Object.defineProperty(wrapper, 'name', { value: original.name });
    wrappedFunctions.set(original, wrapper);
    wrappers.add(wrapper);
    return wrapper;
}

function wrap(exports) {
    if (exports === null || (typeof exports !== 'object' && typeof exports !== 'function')) {
        return exports;
    }
    if (wrapped.has(exports)) {
        return wrapped.get(exports);
    }
    var copy = Object.create(Object.getPrototypeOf(exports));
    Object.getOwnPropertyNames(exports).forEach(function(key) {
        var value;
        try {
            value = exports[key];
        } catch (error) {
            return;
        }
        var descriptor = Object.getOwnPropertyDescriptor(exports, key);
        if (CALLS[key] !== undefined && typeof value === 'function') {
            value = wrapFunction(key, value);
        }
        Object.defineProperty(copy, key, {
            value: value,
            enumerable: descriptor.enumerable,
            writable: true,
            configurable: true,
        });
    });
    wrapped.set(exports, copy);
    return copy;
}

var originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    var exports = originalLoad.apply(this, arguments);
    if (isMain) {
        return exports;
    }
    try {
        if (MODULES.test(Module._resolveFilename(request, parent, isMain))) {
            return wrap(exports);
        }
    } catch (error) {
        return exports;
    }
    return exports;
};

function check(actual, expected) {
    var text = typeof actual === 'string' ? actual
        : actual && typeof actual === 'object' && typeof actual.text === 'string' ? actual.text
            : null;
    var other = typeof expected === 'string' ? expected
        : expected && typeof expected === 'object' && typeof expected.text === 'string' ? expected.text
            : null;
    if (text !== null && text === other && byText.has(text)) {
        var entry = byText.get(text);
        var key = callKey(entry);
        if (!hits.has(key)) {
            hits.set(key, entry);
        }
    }
}

['strictEqual', 'equal', 'deepStrictEqual', 'deepEqual'].forEach(function(name) {
    [assert, assert.strict].forEach(function(target) {
        var original = target[name];
        target[name] = function(actual, expected) {
            check(actual, expected);
            return original.apply(this, arguments);
        };
    });
});

process.on('exit', function() {
    fs.writeFileSync(out, JSON.stringify({
        asserted: Array.from(hits.values()),
        called: Array.from(calls.values()),
    }));
});
