var assert = require('assert');
var fs = require('fs');
var Module = require('module');
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
	'package.json contributes sqlBeautify SQL command alias',
	command_ids(),
	'sqlBeautify.formatSql'
);

assert_includes(
	'package.json contributes beautify SQL DDL command',
	command_ids(),
	'extension.beautifySqlddl'
);

assert_includes(
	'package.json contributes sqlBeautify DDL command alias',
	command_ids(),
	'sqlBeautify.formatHiveDdl'
);

assert_includes(
	'package.json contributes extract DDL command',
	command_ids(),
	'extension.extractDdl'
);

assert_includes(
	'package.json contributes sqlBeautify Extract DDL command alias',
	command_ids(),
	'sqlBeautify.extractHiveDdl'
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

assert.ok(
	/overlapping selections are not supported/.test(extensionSource),
	'overlapping selections must be rejected'
);

assert.ok(
	/VS Code rejected the edit/.test(extensionSource),
	'editor edit failures must be reported'
);

assert.ok(
	/sqlBeautify/.test(extensionSource),
	'extension source must register sqlBeautify command aliases and configuration'
);

assert.strictEqual(
	packageJson.engines.vscode,
	'^1.90.0',
	'package.json must declare the supported VS Code engine baseline'
);

command_ids().forEach(function(commandId) {
	assert_includes(
		'package.json activationEvents must include onCommand for contributed command ' + commandId,
		activation_events(),
		'onCommand:' + commandId
	);
});

function create_position(offset) {
	return {
		offset: offset,
		isEqual: function(other) {
			return this.offset === other.offset;
		},
		isBefore: function(other) {
			return this.offset < other.offset;
		},
		isAfter: function(other) {
			return this.offset > other.offset;
		}
	};
}

function create_document(text) {
	return {
		text: text,
		getText: function(range) {
			if (!range) {
				return this.text;
			}
			return this.text.slice(range.start.offset, range.end.offset);
		},
		positionAt: function(offset) {
			return create_position(offset);
		}
	};
}

function create_vscode_mock() {
	var mock = {
		commandsById: {},
		documentProvider: null,
		rangeProvider: null,
		errors: [],
		editCalls: 0,
		window: {
			activeTextEditor: null,
			showErrorMessage: function(message) {
				mock.errors.push(message);
			}
		},
		workspace: {
			getConfiguration: function() {
				return {
					get: function(key) {
						var defaults = {
							keywordCase: 'upper',
							commaStyle: 'leading',
							indentStyle: 'tab',
							maxAlignWidth: 150,
							caseWhenThenWrapLength: 50,
							dialect: 'generic',
							uppercase: true,
							comma_location: false,
							bracket_char: false,
							as_loc_cnt: 150,
							case_when_then_wrap_length: 50
						};
						return defaults[key];
					},
					inspect: function() {
						return {};
					}
				};
			}
		},
		commands: {
			registerCommand: function(id, handler) {
				mock.commandsById[id] = handler;
				return { id: id };
			}
		},
		languages: {
			registerDocumentFormattingEditProvider: function(selector, provider) {
				mock.documentProvider = provider;
				return { selector: selector, kind: 'document' };
			},
			registerDocumentRangeFormattingEditProvider: function(selector, provider) {
				mock.rangeProvider = provider;
				return { selector: selector, kind: 'range' };
			}
		},
		Range: function(start, end) {
			this.start = start;
			this.end = end;
		},
		TextEdit: {
			replace: function(range, text) {
				return {
					range: range,
					newText: text
				};
			}
		}
	};

	return mock;
}

function load_extension_with_mock(vscodeMock) {
	var originalLoad = Module._load;
	var extensionPath = path.join(__dirname, '..', 'extension.js');
	delete require.cache[require.resolve(extensionPath)];
	Module._load = function(request, parent, isMain) {
		if (request === 'vscode') {
			return vscodeMock;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		return require(extensionPath);
	} finally {
		Module._load = originalLoad;
	}
}

function create_editor(text, selections, editResult) {
	var document = create_document(text);
	return {
		document: document,
		selections: selections,
		editCalls: 0,
		edit: function(callback) {
			this.editCalls += 1;
			callback({
				replacements: [],
				replace: function(range, value) {
					this.replacements.push({
						range: range,
						value: value
					});
				}
			});
			return Promise.resolve(editResult);
		}
	};
}

async function run_mock_tests() {
	var vscodeMock = create_vscode_mock();
	var extension = load_extension_with_mock(vscodeMock);
	var context = { subscriptions: [] };
	extension.activate(context);

	assert.ok(vscodeMock.documentProvider, 'activate must register document formatter');
	assert.ok(vscodeMock.rangeProvider, 'activate must register range formatter');
	assert.strictEqual(typeof vscodeMock.commandsById['extension.beautifySql'], 'function', 'activate must register old SQL command');
	assert.strictEqual(typeof vscodeMock.commandsById['sqlBeautify.formatSql'], 'function', 'activate must register new SQL command alias');
	assert.strictEqual(typeof vscodeMock.commandsById['extension.beautifySqlddl'], 'function', 'activate must register old DDL command');
	assert.strictEqual(typeof vscodeMock.commandsById['sqlBeautify.formatHiveDdl'], 'function', 'activate must register new DDL command alias');
	assert.strictEqual(typeof vscodeMock.commandsById['extension.extractDdl'], 'function', 'activate must register old Extract DDL command');
	assert.strictEqual(typeof vscodeMock.commandsById['sqlBeautify.extractHiveDdl'], 'function', 'activate must register new Extract DDL command alias');

	var vkbeautify = require('../vkbeautify');
	var originalSql = vkbeautify.sql;
	vkbeautify.sql = function() {
		throw new Error('mock formatter failure');
	};
	var edits = vscodeMock.documentProvider.provideDocumentFormattingEdits(create_document('select a'));
	assert.deepStrictEqual(edits, [], 'formatter failure must return empty document edits');
	assert.ok(vscodeMock.errors.some(function(message) {
		return /mock formatter failure/.test(message);
	}), 'formatter failure must call showErrorMessage');
	vkbeautify.sql = originalSql;

	vscodeMock.errors = [];
	var overlappingEditor = create_editor('select abc', [
		new vscodeMock.Range(create_position(0), create_position(6)),
		new vscodeMock.Range(create_position(3), create_position(9))
	], true);
	vscodeMock.window.activeTextEditor = overlappingEditor;
	vscodeMock.commandsById['extension.beautifySql']();
	assert.strictEqual(overlappingEditor.editCalls, 0, 'overlapping selections must not call editor.edit');
	assert.ok(vscodeMock.errors.some(function(message) {
		return /overlapping selections/.test(message);
	}), 'overlapping selections must show an error message');

	vscodeMock.errors = [];
	var rejectedEditor = create_editor('select a', [
		new vscodeMock.Range(create_position(0), create_position(8))
	], false);
	vscodeMock.window.activeTextEditor = rejectedEditor;
	vscodeMock.commandsById['extension.beautifySql']();
	await Promise.resolve();
	assert.strictEqual(rejectedEditor.editCalls, 1, 'non-overlapping selection must call editor.edit');
	assert.ok(vscodeMock.errors.some(function(message) {
		return /VS Code rejected the edit/.test(message);
	}), 'editor.edit false must show rejection message');
}

run_mock_tests().then(function() {
	console.log('extension contribution tests passed');
}).catch(function(error) {
	setTimeout(function() {
		throw error;
	}, 0);
});
