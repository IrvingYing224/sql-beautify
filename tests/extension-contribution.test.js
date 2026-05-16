var assert = require('assert');
var fs = require('fs');
var path = require('path');

var packageJson = require('../package.json');
var extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function command_ids() {
	return packageJson.contributes.commands.map(function(command) {
		return command.command;
	});
}

function command_by_id(commandId) {
	for (var i = 0; i < packageJson.contributes.commands.length; i++) {
		if (packageJson.contributes.commands[i].command == commandId) {
			return packageJson.contributes.commands[i];
		}
	}

	return null;
}

function assert_includes(name, values, expected) {
	assert.ok(
		values.indexOf(expected) >= 0,
		name + '\n--- expected ---\n' + expected + '\n--- actual ---\n' + values.join('\n')
	);
}

function activation_events() {
	return packageJson.activationEvents || [];
}

assert_includes(
	'package.json contributes beautify SQL command',
	command_ids(),
	'extension.beautifySql'
);

assert_includes(
	'package.json contributes beautify SQL DDL command',
	command_ids(),
	'extension.beautifySqlddl'
);

assert_includes(
	'package.json contributes extract DDL command',
	command_ids(),
	'extension.extractDdl'
);

assert.ok(
	/experimental/i.test(command_by_id('extension.beautifySqlddl').title),
	'Beautify SQL DDL command title must mark the DDL formatter as experimental'
);

assert.ok(
	/experimental/i.test(command_by_id('extension.extractDdl').title),
	'Extract DDL command title must mark Extract DDL as experimental'
);

assert.ok(
	/registerDocumentFormattingEditProvider/.test(extensionSource),
	'extension.js must register a standard document formatter'
);

assert.ok(
	/registerDocumentRangeFormattingEditProvider/.test(extensionSource),
	'extension.js must register a standard range formatter'
);

assert.ok(
	/showErrorMessage/.test(extensionSource),
	'formatter failures must show an error message without replacing source text'
);

command_ids().forEach(function(commandId) {
	assert_includes(
		'package.json activationEvents must include onCommand for contributed command ' + commandId,
		activation_events(),
		'onCommand:' + commandId
	);
});
