var assert = require('assert');
var registry = require('../../.tmp/v2-core/adapters/vscode/supported-languages');
var adapter = require('../../.tmp/v2-core/adapters/vscode/adapter-contract');

assert.deepStrictEqual(registry.formatterSelector(), ['sql', 'hive-sql']);
assert.deepStrictEqual(registry.commandLanguageIds(false), ['sql', 'hive-sql']);
assert.deepStrictEqual(registry.commandLanguageIds(true), ['sql', 'hive-sql']);
assert.deepStrictEqual(adapter.FORMATTER_SELECTOR, ['sql', 'hive-sql']);
assert.strictEqual(registry.supportedLanguage('mysql'), null,
    'language registry must not use a broad sql substring match');
assert.deepStrictEqual(adapter.optionsForLanguage('hive-sql', { keywordCase: 'lower' }), {
    keywordCase: 'lower', dialect: 'hive'
});
assert.strictEqual(adapter.optionsForLanguage('javascript', {}), null);
var revokedOptions = Proxy.revocable({}, {});
revokedOptions.revoke();
assert.strictEqual(adapter.optionsForLanguage('sql', revokedOptions.proxy), null,
    'hostile option objects must fail closed');
assert.strictEqual(adapter.optionsForLanguage('sql', { unknownOption: true }), null,
    'unknown option keys must fail closed');
var optionReads = 0;
var accessorOptions = {};
Object.defineProperty(accessorOptions, 'dialect', {
    enumerable: true,
    get: function() { optionReads += 1; return 'hive'; }
});
assert.strictEqual(adapter.optionsForLanguage('sql', accessorOptions), null,
    'option accessors must fail closed');
assert.strictEqual(optionReads, 0, 'option accessors must never execute');
assert.strictEqual(adapter.optionsForLanguage('sql', { dialect: 'oracle' }), null,
    'invalid explicit dialects must fail closed');
assert.strictEqual(adapter.optionsForLanguage('sql', { dialect: null }), null,
    'explicit null dialect must not fall back to the language default');
assert.strictEqual(adapter.optionsForLanguage('sql', { dialect: undefined }), null,
    'explicit undefined dialect must not fall back to the language default');
assert.deepStrictEqual(adapter.createDocumentTarget(8), {
    id: 'document', start: 0, end: 8, mode: 'document'
});
assert.deepStrictEqual(adapter.createFragmentTargets([
    { start: 4, end: 8 }, { start: 0, end: 3 }
]), [
    { id: 'selection:0', start: 4, end: 8, mode: 'fragment' },
    { id: 'selection:1', start: 0, end: 3, mode: 'fragment' }
]);
assert.strictEqual(adapter.createFragmentTargets(new Proxy([{ start: 0, end: 3 }], {})), null,
    'range arrays must reject transparent proxies');
var rangeReads = 0;
var dynamicRange = { end: 3 };
Object.defineProperty(dynamicRange, 'start', {
    enumerable: true,
    get: function() { rangeReads += 1; return 0; }
});
assert.strictEqual(adapter.createFragmentTargets([dynamicRange]), null,
    'range accessors must fail closed');
assert.strictEqual(rangeReads, 0, 'range accessors must never execute');

console.log('v2 Wave 4B language registry tests passed');
