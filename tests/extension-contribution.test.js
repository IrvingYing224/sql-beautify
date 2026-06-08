var assert = require('assert');
var fs = require('fs');
var Module = require('module');
var path = require('path');

var packageJson = require('../package.json');
var sqlFormatter = require('../lib/sql-formatter');
var extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
var extensionAdapterSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adapters', 'vscode-extension.js'), 'utf8');

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

assert_includes(
    'package.json contributes safe diagnostic report command',
    command_ids(),
    'sqlBeautify.copySafeDiagnosticReport'
);

assert.strictEqual(
    command_by_id('sqlBeautify.copySafeDiagnosticReport').title,
    'SQL Beautify: Copy Safe Diagnostic Report',
    'safe diagnostic report command title must match the public command label'
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
	/registerDocumentFormattingEditProvider/.test(extensionAdapterSource),
	'VS Code extension adapter must register a standard document formatter'
);

assert.ok(
	/registerDocumentRangeFormattingEditProvider/.test(extensionAdapterSource),
	'VS Code extension adapter must register a standard range formatter'
);

assert.ok(
	/create_diagnostics/.test(extensionAdapterSource),
	'formatter failures must route through diagnostics so errors remain visible without replacing source text'
);

assert.ok(
	/diagnostics\.overlapping_selection\(\)/.test(extensionAdapterSource),
	'overlapping selections must be rejected'
);

assert.ok(
	/diagnostics\.rejected_edit\(\)/.test(extensionAdapterSource),
	'editor edit failures must be reported'
);

assert.ok(
	/sqlBeautify/.test(extensionAdapterSource),
	'VS Code extension adapter must register sqlBeautify command aliases and configuration'
);

assert.ok(
	/create_extension\(vscode\)/.test(extensionSource),
	'extension.js must stay a thin shell over the VS Code adapter'
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
	var defaults = {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 50,
		dialect: 'hive',
		unsupportedSyntaxPolicy: 'preserve',
		debugDiagnostics: false,
		uppercase: true,
		comma_location: false,
		bracket_char: false,
		as_loc_cnt: 150,
		case_when_then_wrap_length: 50
	};
	var mock = {
		commandsById: {},
		documentProvider: null,
		rangeProvider: null,
		configValues: {},
		configuredKeys: {},
		configScopes: [],
		errors: [],
		warnings: [],
        infos: [],
        clipboardWrites: [],
		editCalls: 0,
		window: {
			activeTextEditor: null,
			showErrorMessage: function(message) {
				mock.errors.push(message);
			},
			showWarningMessage: function(message) {
				mock.warnings.push(message);
			},
			showInformationMessage: function(message) {
				mock.infos.push(message);
			}
		},
        env: {
            clipboard: {
                writeText: function(text) {
                    mock.clipboardWrites.push(text);
                    return Promise.resolve();
                }
            }
        },
		workspace: {
			getConfiguration: function(section, scope) {
				mock.configScopes.push({ section: section, scope: scope });
				return {
					get: function(key) {
						if (Object.prototype.hasOwnProperty.call(mock.configValues, key)) {
							return mock.configValues[key];
						}
						return defaults[key];
					},
					inspect: function(key) {
						if (!mock.configuredKeys[key]) {
							return {};
						}
						return {
							workspaceValue: mock.configValues[key]
						};
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
	mock.setConfig = function(key, value) {
		mock.configValues[key] = value;
		mock.configuredKeys[key] = true;
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
    assert.strictEqual(typeof vscodeMock.commandsById['sqlBeautify.copySafeDiagnosticReport'], 'function', 'activate must register safe diagnostic report command');

	var ddlFormatter = require('../lib/experimental/ddl');
	var originalFormatSql = sqlFormatter.format_sql;
	var originalFormatSqlDetailed = sqlFormatter.format_sql_detailed;
	var originalDdl = ddlFormatter.ddl;
	var originalExtract = ddlFormatter.extractddl;
	var sqlCalls = [];
	var ddlCalls = 0;
	var extractCalls = 0;
	sqlFormatter.format_sql = function(text, options) {
		sqlCalls.push({
			text: text,
			options: options
		});
		return originalFormatSql(text, options);
	};
	sqlFormatter.format_sql_detailed = function(text, options) {
		sqlCalls.push({
			text: text,
			options: options
		});
		return originalFormatSqlDetailed(text, options);
	};
	ddlFormatter.ddl = function(text) {
		ddlCalls += 1;
		return originalDdl(text);
	};
	ddlFormatter.extractddl = function(text) {
		extractCalls += 1;
		return originalExtract(text);
	};

	var hiveDocument = create_document('select a from t');
	hiveDocument.languageId = 'hive-sql';
	hiveDocument.uri = { fsPath: '/workspace/a.sql' };
	vscodeMock.documentProvider.provideDocumentFormattingEdits(hiveDocument);
	assert.strictEqual(sqlCalls[0].options.dialect, 'hive', 'hive-sql document formatter must use hive dialect by default');
	assert.ok(
		vscodeMock.configScopes.some(function(item) {
			return item.section == 'sqlBeautify' && item.scope == hiveDocument.uri;
		}),
		'VS Code config must be read with document.uri scope'
	);

	var sqlEditor = create_editor('select a from t', [
		new vscodeMock.Range(create_position(0), create_position(15))
	], true);
	sqlEditor.document.languageId = 'hive-sql';
	vscodeMock.window.activeTextEditor = sqlEditor;
	vscodeMock.commandsById['extension.beautifySql']();
	await Promise.resolve();
	assert.strictEqual(sqlCalls[1].options.dialect, 'hive', 'beautifySql command path must match provider hive dialect default');

    var diagnosticReportEditor = create_editor([
        "select private_column, 'secret-value' as literal_value",
        'from private_table -- private comment'
    ].join('\n'), [
        new vscodeMock.Range(create_position(0), create_position(80))
    ], true);
    diagnosticReportEditor.document.languageId = 'hive-sql';
    diagnosticReportEditor.document.uri = { fsPath: '/workspace/private.sql' };
    vscodeMock.window.activeTextEditor = diagnosticReportEditor;
    await vscodeMock.commandsById['sqlBeautify.copySafeDiagnosticReport']();
    assert.strictEqual(vscodeMock.clipboardWrites.length, 1, 'safe diagnostic command must write one report to clipboard');
    assert.ok(/^# SQL Beautify Safe Diagnostic Report/m.test(vscodeMock.clipboardWrites[0]), 'safe diagnostic report must render a markdown title');
    assert.ok(!/private_column/.test(vscodeMock.clipboardWrites[0]), 'safe diagnostic report must not leak private column names');
    assert.ok(!/secret-value/.test(vscodeMock.clipboardWrites[0]), 'safe diagnostic report must not leak private string literals');
    assert.ok(!/literal_value/.test(vscodeMock.clipboardWrites[0]), 'safe diagnostic report must not leak private aliases');
    assert.ok(!/private_table/.test(vscodeMock.clipboardWrites[0]), 'safe diagnostic report must not leak private table names');
    assert.ok(!/private comment/.test(vscodeMock.clipboardWrites[0]), 'safe diagnostic report must not leak private comments');
    assert.ok(!/\/workspace\/private\.sql/.test(vscodeMock.clipboardWrites[0]), 'safe diagnostic report must not leak file paths');
    assert.ok(vscodeMock.infos.some(function(message) {
        return /safe diagnostic report copied/.test(message);
    }), 'safe diagnostic command must show a success message');
    assert.ok(sqlCalls.some(function(call) {
        return call.options && call.options.includeTelemetry === true && call.options.phase == 'command_format';
    }), 'safe diagnostic command must request command telemetry from the formatter');

    vscodeMock.errors = [];
    vscodeMock.env.clipboard.writeText = function() {
        return Promise.reject(new Error('/workspace/private.sql select private_column secret-value'));
    };
    var failedClipboardEditor = create_editor([
        "select private_column, 'secret-value' as literal_value",
        'from private_table -- private comment'
    ].join('\n'), [
        new vscodeMock.Range(create_position(0), create_position(80))
    ], true);
    failedClipboardEditor.document.languageId = 'hive-sql';
    failedClipboardEditor.document.uri = { fsPath: '/workspace/private.sql' };
    vscodeMock.window.activeTextEditor = failedClipboardEditor;
    var failedClipboardResult = await vscodeMock.commandsById['sqlBeautify.copySafeDiagnosticReport']();
    var failedClipboardErrors = vscodeMock.errors.join('\n');
    assert.strictEqual(failedClipboardResult, false, 'safe diagnostic command must report clipboard copy failure');
    assert.ok(vscodeMock.errors.some(function(message) {
        return /SQL Beautify failed: could not copy safe diagnostic report\./.test(message);
    }), 'clipboard failure must show a generic safe error message');
    assert.ok(!/\/workspace\/private\.sql/.test(failedClipboardErrors), 'clipboard failure error must not leak file paths');
    assert.ok(!/private_column/.test(failedClipboardErrors), 'clipboard failure error must not leak private column names');
    assert.ok(!/secret-value/.test(failedClipboardErrors), 'clipboard failure error must not leak private string literals');
    assert.ok(!/select private_column/.test(failedClipboardErrors), 'clipboard failure error must not leak SQL fragments');
    assert.ok(vscodeMock.errors.some(function(message) {
        return message == 'SQL Beautify failed: could not copy safe diagnostic report.';
    }), 'clipboard failure must use the fixed safe error message');

	var ddlEditor = create_editor('create table t (id bigint)', [
		new vscodeMock.Range(create_position(0), create_position(26))
	], true);
	vscodeMock.window.activeTextEditor = ddlEditor;
	vscodeMock.commandsById['extension.beautifySqlddl']();
	await Promise.resolve();
	assert.strictEqual(ddlCalls, 1, 'DDL command path must invoke the same sqlddl formatter entry');

	var extractEditor = create_editor('select a as id from t', [
		new vscodeMock.Range(create_position(0), create_position(21))
	], true);
	vscodeMock.window.activeTextEditor = extractEditor;
	vscodeMock.commandsById['extension.extractDdl']();
	await Promise.resolve();
	assert.strictEqual(extractCalls, 1, 'Extract DDL command path must invoke the same extractddl formatter entry');

	var unsafeRangeDocument = create_document('select a,\n b\nfrom t');
	unsafeRangeDocument.languageId = 'sql';
	var unsafeRangeEdits = vscodeMock.rangeProvider.provideDocumentRangeFormattingEdits(
		unsafeRangeDocument,
		new vscodeMock.Range(create_position(1), create_position(11))
	);
	assert.deepStrictEqual(unsafeRangeEdits, [], 'unsafe range fragment must be rejected');
	assert.ok(vscodeMock.errors.some(function(message) {
		return /unsafe range formatting fragment/.test(message);
	}), 'unsafe range fragment must show an error message');

	var cteDocument = create_document('with s as (select a from t)\nselect a from s\n');
	cteDocument.languageId = 'sql';
	var cteEdits = vscodeMock.rangeProvider.provideDocumentRangeFormattingEdits(
		cteDocument,
		new vscodeMock.Range(create_position(0), create_position(cteDocument.text.length))
	);
	assert.strictEqual(cteEdits.length, 1, 'complete CTE range should be accepted by VS Code range formatter');

	vscodeMock.errors = [];
	var unsafeCommandEditor = create_editor('select a,\n b\nfrom t', [
		new vscodeMock.Range(create_position(1), create_position(11))
	], true);
	unsafeCommandEditor.document.languageId = 'sql';
	vscodeMock.window.activeTextEditor = unsafeCommandEditor;
	vscodeMock.commandsById['extension.beautifySql']();
	await Promise.resolve();
	assert.strictEqual(unsafeCommandEditor.editCalls, 0, 'command-format unsafe range fragment must be rejected before editor.edit');
	assert.ok(vscodeMock.errors.some(function(message) {
		return /unsafe range formatting fragment/.test(message);
	}), 'command-format unsafe range fragment must show an error message');

	sqlFormatter.format_sql = function() {
		throw new Error('mock formatter failure');
	};
	sqlFormatter.format_sql_detailed = function() {
		throw new Error('mock formatter failure');
	};
	var edits = vscodeMock.documentProvider.provideDocumentFormattingEdits(create_document('select a'));
	assert.deepStrictEqual(edits, [], 'formatter failure must return empty document edits');
	assert.ok(vscodeMock.errors.some(function(message) {
		return /mock formatter failure/.test(message);
	}), 'formatter failure must call showErrorMessage');
	sqlFormatter.format_sql = originalFormatSql;
	sqlFormatter.format_sql_detailed = originalFormatSqlDetailed;
	ddlFormatter.ddl = originalDdl;
	ddlFormatter.extractddl = originalExtract;

	vscodeMock.warnings = [];
	sqlFormatter.format_sql_detailed = function(text, options) {
		return {
			text: originalFormatSql(text, options),
			diagnostics: [
				{
					level: 'warning',
					code: 'unsupported_syntax',
					message: 'Unsupported SQL fragments were preserved without reformatting.'
				}
			]
		};
	};
	var warningEdits = vscodeMock.documentProvider.provideDocumentFormattingEdits(create_document('select a from t'));
	assert.strictEqual(warningEdits.length, 1, 'document formatting should still return edits under warn diagnostics');
	assert.ok(vscodeMock.warnings.some(function(message) {
		return /Unsupported SQL fragments were preserved/.test(message);
	}), 'warn diagnostics must surface through VS Code warning UI');
	sqlFormatter.format_sql_detailed = originalFormatSqlDetailed;

	vscodeMock.warnings = [];
	vscodeMock.setConfig('dialect', 'generic');
	vscodeMock.setConfig('unsupportedSyntaxPolicy', 'warn');
	vscodeMock.setConfig('debugDiagnostics', false);
	var matchRecognizeDocument = create_document(
		'select * from t match_recognize (partition by a order by b measures match_number() as mn)'
	);
	matchRecognizeDocument.languageId = 'sql';
	var matchRecognizeEdits = vscodeMock.documentProvider.provideDocumentFormattingEdits(matchRecognizeDocument);
	assert.strictEqual(matchRecognizeEdits.length, 1, 'document formatting should still return edits for unsupported warn policy');
	assert.ok(vscodeMock.warnings.some(function(message) {
		return /MATCH_RECOGNIZE/.test(message) && /bail_out/.test(message);
	}), 'unsupported warning must name MATCH_RECOGNIZE and suggest bail_out');

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
	sqlFormatter.format_sql = originalFormatSql;
	sqlFormatter.format_sql_detailed = originalFormatSqlDetailed;
}

run_mock_tests().then(function() {
	console.log('extension contribution tests passed');
}).catch(function(error) {
	setTimeout(function() {
		throw error;
	}, 0);
});
