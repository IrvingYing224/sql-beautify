var assert = require('assert');
var fs = require('fs');
var path = require('path');

var packageJson = require('../package.json');
var sqlRenderOptions = require('../lib/sql-render-options');
var extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
var properties = packageJson.contributes.configuration.properties;

function assert_property(name) {
	assert.ok(properties[name], 'missing configuration property: ' + name);
}

function assert_source_contains(name, pattern) {
	assert.ok(pattern.test(extensionSource), name + '\n--- pattern ---\n' + pattern + '\n--- source ---\n' + extensionSource);
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
	/hasConfiguredValue\(scopedConfig, 'keywordCase'\)[\s\S]+hasConfiguredValue\(legacyConfig, 'keywordCase'\)[\s\S]+config\.inspect\(key\)/
);

assert_source_contains(
	'default language value must not count as explicit user configuration',
	/typeof inspected\.globalValue[\s\S]+workspaceFolderLanguageValue[\s\S]+;/
);

assert.ok(
	!/defaultLanguageValue/.test(extensionSource),
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
	}).uppercase,
	false,
	'sqlBeautify.keywordCase explicit overrides legacy keywordCase and uppercase'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		keywordCase: 'lower',
		uppercase: true
	}, {
		keywordCase: true
	}).uppercase,
	false,
	'extension.keywordCase explicit overrides extension.uppercase'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		uppercase: false
	}, {}).uppercase,
	false,
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
	}).comma_location,
	true,
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
	}).bracket_char,
	true,
	'sqlBeautify.indentStyle explicit overrides legacy indent config'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlMaxAlignWidth: 999
	}, {
		sqlMaxAlignWidth: true
	}).as_loc_cnt,
	500,
	'maxAlignWidth clamps to maximum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlMaxAlignWidth: -2
	}, {
		sqlMaxAlignWidth: true
	}).as_loc_cnt,
	1,
	'maxAlignWidth clamps to minimum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		sqlCaseWhenThenWrapLength: 999
	}, {
		sqlCaseWhenThenWrapLength: true
	}).case_when_then_wrap_length,
	300,
	'caseWhenThenWrapLength clamps to maximum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({}, {}).dialect,
	'generic',
	'dialect defaults to generic'
);
