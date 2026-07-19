var assert = require('assert');
var core = require('../../.tmp/v2-core/core/index');
var directModule = require('../../.tmp/v2-core/adapters/executor/direct');
var languageRegistry = require('../../.tmp/v2-core/adapters/vscode/supported-languages');

assert.deepStrictEqual(Object.keys(core).sort(), ['formatSql', 'lexSql'],
    'Wave 4 core root must expose only the public formatter and lexer values');

var formatted = core.formatSql('select a from t', {
    dialect: 'hive',
    keywordCase: 'upper'
});
assert.ok(formatted.status == 'formatted' || formatted.status == 'unchanged',
    'two-argument public API must return a safe result');
assert.strictEqual(Object.isFrozen(formatted), true, 'public FormatResult must be frozen');
assert.strictEqual(Object.isFrozen(formatted.diagnostics), true, 'public diagnostics must be frozen');
assert.ok(formatted.sourceMap, 'safe public result must carry a source map');
assert.deepStrictEqual(
    core.formatSql('select 1; select 2', { dialect: 'hive' }, 'fragment'),
    core.formatSql('select 1; select 2', { dialect: 'hive' }),
    'an extra runtime argument must not change the document-only public API'
);

var malformed = core.formatSql('select (', { dialect: 'hive' });
assert.ok(malformed.status == 'preserved' || malformed.status == 'failed',
    'malformed public input must fail closed');
assert.strictEqual(malformed.text, 'select (', 'malformed public input must retain original text');
assert.strictEqual(malformed.sourceMap, undefined, 'original-text result must not expose a partial map');

assert.deepStrictEqual(
    languageRegistry.SUPPORTED_LANGUAGES.map(function(value) { return value.languageId; }),
    ['sql', 'hive-sql'],
    'supported language registry must be explicit and deterministic'
);
assert.strictEqual(languageRegistry.supportedLanguage('sql').supportsExperimentalDdl, true);
assert.strictEqual(languageRegistry.supportedLanguage('plsql'), null,
    'keyword-shaped language ids outside the registry must not be accepted');

async function run() {
    var executor = new directModule.DirectFormatterExecutor();
    var direct = await executor.format({
        source: 'select a from t',
        options: { dialect: 'hive' },
        mode: 'document',
        documentVersion: 1,
        targetId: 'document'
    });
    assert.deepStrictEqual(direct, core.formatSql('select a from t', { dialect: 'hive' }),
        'direct executor must call the same core pipeline as the public API');
    await executor.dispose();
    console.log('v2 Wave 4A public API tests passed');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
