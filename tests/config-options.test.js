var assert = require('assert');
var fs = require('fs');
var path = require('path');

var packageJson = require('../package.json');
var sqlRenderOptions = require('../lib/sql-render-options');
var configAdapterSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adapters', 'vscode-config.js'), 'utf8');
var properties = packageJson.contributes.configuration.properties;

function assert_property(name) {
	assert.ok(properties[name], 'missing configuration property: ' + name);
}

function assert_source_contains(name, pattern) {
	assert.ok(pattern.test(configAdapterSource), name + '\n--- pattern ---\n' + pattern + '\n--- source ---\n' + configAdapterSource);
}

[
	'extension.uppercase',
	'extension.comma_location',
	'extension.bracket_char',
	'extension.as_loc_cnt',
	'extension.case_when_then_wrap_length'
].forEach(assert_property);

[
	'extension.keywordCase',
	'extension.commaStyle',
	'extension.indentStyle',
	'extension.maxAlignWidth'
].forEach(assert_property);

[
	'sqlBeautify.keywordCase',
	'sqlBeautify.commaStyle',
	'sqlBeautify.indentStyle',
	'sqlBeautify.maxAlignWidth',
	'sqlBeautify.caseWhenThenWrapLength',
	'sqlBeautify.dialect'
].forEach(assert_property);

assert.deepStrictEqual(
	properties['extension.keywordCase'].enum,
	['upper', 'lower'],
	'keywordCase must expose explicit keyword casing choices'
);

assert.deepStrictEqual(
	properties['extension.commaStyle'].enum,
	['leading', 'trailing'],
	'commaStyle must expose explicit comma placement choices'
);

assert.deepStrictEqual(
	properties['extension.indentStyle'].enum,
	['tab', 'space'],
	'indentStyle must expose explicit indentation choices'
);

assert_source_contains(
	'scoped sqlBeautify config must be read separately from legacy extension config',
	/getConfiguration\('sqlBeautify'\)[\s\S]+getConfiguration\('extension'\)/
);

assert_source_contains(
	'new config defaults must not silently override legacy user settings',
	/has_configured_value\(scopedConfig, 'keywordCase'\)[\s\S]+has_configured_value\(legacyConfig, 'keywordCase'\)/
);

assert_source_contains(
	'explicit config detection must use VS Code inspect metadata',
	/config\.inspect\(key\)/
);

assert_source_contains(
	'default language value must not count as explicit user configuration',
	/typeof inspected\.globalValue[\s\S]+workspaceFolderLanguageValue[\s\S]+;/
);

assert.ok(
	!/defaultLanguageValue/.test(configAdapterSource),
	'defaultLanguageValue must not count as explicit user configuration'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		sqlKeywordCase: 'lower',
		keywordCase: 'upper',
		uppercase: true
	}, {
		sqlKeywordCase: true,
		keywordCase: true
	}).keywordCase,
	'lower',
	'sqlBeautify.keywordCase explicit overrides legacy keywordCase and uppercase'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		keywordCase: 'lower',
		uppercase: true
	}, {
		keywordCase: true
	}).keywordCase,
	'lower',
	'extension.keywordCase explicit overrides extension.uppercase'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		uppercase: false
	}, {}).keywordCase,
	'lower',
	'extension.uppercase fallback still works'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlCommaStyle: 'trailing',
		commaStyle: 'leading',
		comma_location: false
	}, {
		sqlCommaStyle: true,
		commaStyle: true
	}).commaStyle,
	'trailing',
	'sqlBeautify.commaStyle explicit overrides legacy comma config'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlIndentStyle: 'space',
		indentStyle: 'tab',
		bracket_char: false
	}, {
		sqlIndentStyle: true,
		indentStyle: true
	}).indentStyle,
	'space',
	'sqlBeautify.indentStyle explicit overrides legacy indent config'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlMaxAlignWidth: 999
	}, {
		sqlMaxAlignWidth: true
	}).maxAlignWidth,
	500,
	'maxAlignWidth clamps to maximum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlMaxAlignWidth: -2
	}, {
		sqlMaxAlignWidth: true
	}).maxAlignWidth,
	1,
	'maxAlignWidth clamps to minimum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlCaseWhenThenWrapLength: 999
	}, {
		sqlCaseWhenThenWrapLength: true
	}).caseWhenThenWrapLength,
	300,
	'caseWhenThenWrapLength clamps to maximum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({}, {}).dialect,
	'generic',
	'dialect defaults to generic'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		documentLanguageId: 'hive-sql'
	}, {
		languageMode: true
	}).dialect,
	'hive',
	'hive-sql language mode should default to hive dialect'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		documentLanguageId: 'hive-sql',
		sqlDialect: 'postgres'
	}, {
		sqlDialect: true,
		languageMode: true
	}).dialect,
	'postgres',
	'explicit dialect must override language-mode default'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		uppercase: false,
		comma_location: true,
		bracket_char: true,
		as_loc_cnt: 88,
		case_when_then_wrap_length: 33,
		dialect: 'hive'
	}, {
		dialect: true
	}),
	{
		keywordCase: 'lower',
		commaStyle: 'trailing',
		indentStyle: 'space',
		maxAlignWidth: 88,
		caseWhenThenWrapLength: 33,
		dialect: 'hive',
		languageMode: 'sql',
		unsupportedSyntaxPolicy: 'preserve'
	},
	'legacy adapter inputs must normalize to canonical formatter options'
);
