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
	'extension.case_when_then_wrap_length',
	'extension.keywordCase',
	'extension.commaStyle',
	'extension.indentStyle',
	'extension.maxAlignWidth'
].forEach(function(name) {
	assert.ok(!properties[name], 'breaking cleanup must remove legacy extension.* configuration from package.json: ' + name);
});

[
	'sqlBeautify.keywordCase',
	'sqlBeautify.commaStyle',
	'sqlBeautify.indentStyle',
	'sqlBeautify.maxAlignWidth',
	'sqlBeautify.caseWhenThenWrapLength',
	'sqlBeautify.caseLayout',
	'sqlBeautify.dialect',
	'sqlBeautify.unsupportedSyntaxPolicy',
	'sqlBeautify.debugDiagnostics'
].forEach(assert_property);

assert_source_contains(
	'VS Code config adapter must only read sqlBeautify configuration namespace',
	/getConfiguration\('sqlBeautify'/
);

assert_source_contains(
	'VS Code config adapter must read sqlBeautify configuration with document scope',
	/getConfiguration\('sqlBeautify',\s*document\s*&&\s*document\.uri\)/
);

assert_source_contains(
	'unsupported syntax policy must be read from sqlBeautify config',
	/has_configured_value\(scopedConfig, 'unsupportedSyntaxPolicy'\)/
);

assert_source_contains(
	'caseLayout must be read from sqlBeautify config',
	/has_configured_value\(scopedConfig, 'caseLayout'\)/
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

assert.ok(
	!/getConfiguration\('extension'\)/.test(configAdapterSource),
	'VS Code config adapter must no longer read legacy extension namespace'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		commaStyle: 'trailing'
	}, {
		commaStyle: true
	}).commaStyle,
	'trailing',
	'commaStyle must normalize directly from canonical sqlBeautify input'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		indentStyle: 'space'
	}, {
		indentStyle: true
	}).indentStyle,
	'space',
	'indentStyle must normalize directly from canonical sqlBeautify input'
);

assert.strictEqual(
	sqlRenderOptions.normalize({}, {}).indentStyle,
	'space',
	'indentStyle defaults to space'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		maxAlignWidth: 999
	}, {
		maxAlignWidth: true
	}).maxAlignWidth,
	500,
	'maxAlignWidth clamps to maximum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		maxAlignWidth: -2
	}, {
		maxAlignWidth: true
	}).maxAlignWidth,
	1,
	'maxAlignWidth clamps to minimum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		caseWhenThenWrapLength: 999
	}, {
		caseWhenThenWrapLength: true
	}).caseWhenThenWrapLength,
	300,
	'caseWhenThenWrapLength clamps to maximum'
);

assert.strictEqual(
	sqlRenderOptions.normalize({}, {}).caseLayout,
	'expanded',
	'caseLayout defaults to expanded'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		caseLayout: 'compactShort'
	}, {
		caseLayout: true
	}).caseLayout,
	'compactShort',
	'explicit sqlBeautify.caseLayout compactShort should flow into canonical options'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		caseLayout: 'unknown'
	}, {
		caseLayout: true
	}).caseLayout,
	'expanded',
	'invalid caseLayout values fall back to expanded'
);

assert.strictEqual(
	sqlRenderOptions.normalize({}, {}).dialect,
	'hive',
	'dialect defaults to hive'
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
		dialect: 'postgres'
	}, {
		dialect: true,
		languageMode: true
	}).dialect,
	'postgres',
	'explicit dialect must override language-mode default'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		unsupportedSyntaxPolicy: 'bail_out'
	}, {
		unsupportedSyntaxPolicy: true
	}).unsupportedSyntaxPolicy,
	'bail_out',
	'explicit sqlBeautify.unsupportedSyntaxPolicy should flow into canonical options'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		keywordCase: 'lower',
		commaStyle: 'trailing',
		indentStyle: 'space',
		maxAlignWidth: 88,
		caseWhenThenWrapLength: 33,
		caseLayout: 'compactShort',
		dialect: 'hive'
	}, {
		keywordCase: true,
		commaStyle: true,
		indentStyle: true,
		maxAlignWidth: true,
		caseWhenThenWrapLength: true,
		caseLayout: true,
		dialect: true
	}),
	{
		keywordCase: 'lower',
		commaStyle: 'trailing',
		indentStyle: 'space',
		maxAlignWidth: 88,
		caseWhenThenWrapLength: 33,
		caseLayout: 'compactShort',
		dialect: 'hive',
		languageMode: 'sql',
		unsupportedSyntaxPolicy: 'preserve'
	},
	'canonical adapter inputs must normalize to canonical formatter options without legacy fallback'
);

assert.strictEqual(
	properties['sqlBeautify.indentStyle'].default,
	'space',
	'sqlBeautify.indentStyle package default must be space'
);

assert.strictEqual(
	properties['sqlBeautify.dialect'].default,
	'hive',
	'sqlBeautify.dialect package default must be hive'
);
