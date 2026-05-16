var assert = require('assert');
var fs = require('fs');
var path = require('path');

var packageJson = require('../package.json');
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
	'keywordCase must be read before legacy uppercase',
	/config\.get\('keywordCase'\)[\s\S]+config\.get\('uppercase'\)/
);

assert_source_contains(
	'new config defaults must not silently override legacy user settings',
	/hasConfiguredValue\(config, 'keywordCase'\)[\s\S]+hasConfiguredValue\(config, 'commaStyle'\)[\s\S]+hasConfiguredValue\(config, 'indentStyle'\)[\s\S]+hasConfiguredValue\(config, 'maxAlignWidth'\)[\s\S]+config\.inspect\(key\)/
);

assert_source_contains(
	'commaStyle must be read before legacy comma_location',
	/config\.get\('commaStyle'\)[\s\S]+config\.get\('comma_location'\)/
);

assert_source_contains(
	'indentStyle must be read before legacy bracket_char',
	/config\.get\('indentStyle'\)[\s\S]+config\.get\('bracket_char'\)/
);

assert_source_contains(
	'maxAlignWidth must be read before legacy as_loc_cnt',
	/config\.get\('maxAlignWidth'\)[\s\S]+config\.get\('as_loc_cnt'\)/
);
