var assert = require('assert');
var sourceMapModule = require('../../.tmp/v2-core/core/source/source-map');
var cursorModule = require('../../.tmp/v2-core/adapters/transaction/cursor');

var map = {
    entries: [
        { source: { start: 0, end: 3 }, output: { start: 0, end: 3 } },
        { source: { start: 5, end: 8 }, output: { start: 6, end: 9 } }
    ]
};

assert.strictEqual(sourceMapModule.mapSourceOffset(map, 2, 10, 12, 'exact'), 2,
    'offset inside a mapped run must map exactly');
assert.strictEqual(sourceMapModule.mapSourceOffset(map, 4, 10, 12, 'left'), 3,
    'left affinity must choose the preceding mapped run');
assert.strictEqual(sourceMapModule.mapSourceOffset(map, 4, 10, 12, 'right'), 6,
    'right affinity must choose the following mapped run');
assert.strictEqual(sourceMapModule.mapSourceOffset(map, 4, 10, 12, 'exact'), null,
    'exact affinity must not guess inside an unmapped gap');
assert.strictEqual(sourceMapModule.mapSourceOffset(map, 5, 10, 12, 'left'), 3,
    'left affinity at a mapped boundary must remain before generated layout');
assert.strictEqual(sourceMapModule.mapSourceOffset(map, 5, 10, 12, 'right'), 6,
    'right affinity at a mapped boundary must remain with the following token');
assert.strictEqual(sourceMapModule.mapSourceOffset(map, 10, 10, 12, 'left'), 9,
    'left affinity after the last source run must use the last mapped end');
assert.strictEqual(sourceMapModule.mapSourceOffset(map, 10, 10, 12, 'right'), 12,
    'right affinity after the last source run requires the explicit output length');
assert.strictEqual(sourceMapModule.mapSourceOffset({
    entries: [{ source: { start: 0, end: 1 }, output: { start: 0, end: 1 } }]
}, 1, 1, 4, 'right'), 4,
    'right affinity at the source end must include a trailing generated gap');

var invalid = {
    entries: [
        { source: { start: 0, end: 3 }, output: { start: 0, end: 3 } },
        { source: { start: 2, end: 4 }, output: { start: 4, end: 6 } }
    ]
};
assert.strictEqual(sourceMapModule.mapSourceOffset(invalid, 1, 4, 6, 'exact'), null,
    'overlapping source map entries must fail closed');
assert.strictEqual(sourceMapModule.mapSourceOffset({ entries: [] }, 1, 1, 1, 'left'), null,
    'a non-empty target without mapping evidence must fail closed');
assert.strictEqual(sourceMapModule.mapSourceOffset({ entries: [] }, 0, 0, 0, 'exact'), 0,
    'the empty source/output cursor maps to zero');

var leadingGap = {
    entries: [{
        source: { start: 5, end: 8 },
        output: { start: 6, end: 9 }
    }]
};
assert.strictEqual(sourceMapModule.mapSourceOffset(leadingGap, 0, 10, 12, 'left'), 0,
    'left affinity before the first mapped run must clamp to output zero');
assert.strictEqual(sourceMapModule.mapSourceOffset(leadingGap, 0, 10, 12, 'right'), 6,
    'right affinity before the first mapped run must choose the first mapped start');
assert.strictEqual(sourceMapModule.mapSourceOffset(leadingGap, 0, 10, 12, 'exact'), null,
    'exact affinity before the first mapped run must not guess');
assert.strictEqual(sourceMapModule.mapSourceOffset(leadingGap, 5, 10, 12, 'left'), 0,
    'left affinity at the first mapped boundary must include the leading gap');

assert.deepStrictEqual(
    cursorModule.mapSelectionThroughSourceMap({ start: 0, end: 8 }, map, 10, 12),
    { start: 0, end: 9 },
    'selection endpoints must use left/right affinity'
);
assert.strictEqual(
    cursorModule.mapSelectionThroughSourceMap({ start: -1, end: 1 }, map, 10, 12),
    null,
    'invalid selections must fail closed'
);
assert.strictEqual(
    cursorModule.mapSelectionThroughSourceMap(null, map, 10, 12),
    null,
    'null selections must fail closed without throwing'
);
assert.strictEqual(sourceMapModule.mapSourceOffset({
    entries: [{ source: { start: 0, end: 0 }, output: { start: 0, end: 0 } }]
}, 0, 1, 1, 'exact'), null,
    'zero-length map entries must fail closed');

var changingEntriesReads = 0;
var changingEntriesMap = {};
Object.defineProperty(changingEntriesMap, 'entries', {
    enumerable: true,
    get: function() {
        changingEntriesReads += 1;
        return changingEntriesReads == 1
            ? [{ source: { start: 0, end: 3 }, output: { start: 0, end: 3 } }]
            : [{ source: { start: 99, end: 100 }, output: { start: 99, end: 100 } }];
    }
});
assert.strictEqual(sourceMapModule.mapSourceOffset(changingEntriesMap, 1, 3, 3, 'exact'), 1,
    'source-map mapping must consume one stable entries snapshot');
assert.strictEqual(changingEntriesReads, 1, 'source-map entries getter must be read once');

console.log('v2 Wave 4A source map tests passed');
