var assert = require('assert');
var registry = require('../../.tmp/v2-core/adapters/vscode/supported-languages');

assert.deepStrictEqual(registry.formatterSelector(), ['sql', 'hive-sql']);
assert.deepStrictEqual(registry.commandLanguageIds(false), ['sql', 'hive-sql']);
assert.deepStrictEqual(registry.commandLanguageIds(true), ['sql', 'hive-sql']);
assert.strictEqual(registry.supportedLanguage('mysql'), null,
    'language registry must not use a broad sql substring match');
assert.deepStrictEqual(registry.SUPPORTED_LANGUAGES, [
    { languageId: 'sql', supportsQueryFormatting: true, supportsExperimentalDdl: true },
    { languageId: 'hive-sql', supportsQueryFormatting: true, supportsExperimentalDdl: true }
], 'language registry must not carry a second dialect authority');

console.log('v2 Wave 4B language registry tests passed');
