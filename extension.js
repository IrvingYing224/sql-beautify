// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var vkbeautify = require('./vkbeautify');
var sqlFormatter = require('./lib/sql-formatter');
var sqlRenderOptions = require('./lib/sql-render-options');

function getTargetRanges(editor) {
    var selections = [];

    for (var i = 0; i < editor.selections.length; i++) {
        var s = editor.selections[i];
        if (!s.start.isEqual(s.end)) {
            selections.push(new vscode.Range(s.start, s.end));
        }
    }

    if (selections.length === 0) {
        selections.push(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)));
    }

    return selections;
}

function replaceTargetRanges(formatter) {
    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    var ranges = getTargetRanges(editor);
    ranges.sort(function(a, b) {
        if (a.start.isBefore(b.start)) {
            return -1;
        }
        if (b.start.isBefore(a.start)) {
            return 1;
        }
        return 0;
    });

    for (var i = 1; i < ranges.length; i++) {
        if (ranges[i - 1].end.isAfter(ranges[i].start)) {
            vscode.window.showErrorMessage('SQL Beautify failed: overlapping selections are not supported.');
            return;
        }
    }

    editor.edit(function(builder) {
        for (var j = 0; j < ranges.length; j++) {
            var range = ranges[j];
            var text = editor.document.getText(range).toString();
            var formatted = tryFormat(formatter, text);
            if (formatted !== null) {
                builder.replace(range, formatted);
            }
        }
    }).then(function(success) {
        if (!success) {
            vscode.window.showErrorMessage('SQL Beautify failed: VS Code rejected the edit.');
        }
    });
}

function getDocumentLanguageId(document) {
    return document && document.languageId ? document.languageId : 'sql';
}

function getSqlFormatterConfig(document) {
    var scopedConfig = vscode.workspace.getConfiguration('sqlBeautify');
    var legacyConfig = vscode.workspace.getConfiguration('extension');
    var raw = {
        sqlKeywordCase: scopedConfig.get('keywordCase'),
        sqlCommaStyle: scopedConfig.get('commaStyle'),
        sqlIndentStyle: scopedConfig.get('indentStyle'),
        sqlMaxAlignWidth: scopedConfig.get('maxAlignWidth'),
        sqlCaseWhenThenWrapLength: scopedConfig.get('caseWhenThenWrapLength'),
        sqlDialect: scopedConfig.get('dialect'),
        keywordCase: legacyConfig.get('keywordCase'),
        commaStyle: legacyConfig.get('commaStyle'),
        indentStyle: legacyConfig.get('indentStyle'),
        maxAlignWidth: legacyConfig.get('maxAlignWidth'),
        uppercase: legacyConfig.get('uppercase'),
        comma_location: legacyConfig.get('comma_location'),
        bracket_char: legacyConfig.get('bracket_char'),
        as_loc_cnt: legacyConfig.get('as_loc_cnt'),
        case_when_then_wrap_length: legacyConfig.get('case_when_then_wrap_length'),
        documentLanguageId: getDocumentLanguageId(document)
    };
    var explicit = {
        sqlKeywordCase: hasConfiguredValue(scopedConfig, 'keywordCase'),
        sqlCommaStyle: hasConfiguredValue(scopedConfig, 'commaStyle'),
        sqlIndentStyle: hasConfiguredValue(scopedConfig, 'indentStyle'),
        sqlMaxAlignWidth: hasConfiguredValue(scopedConfig, 'maxAlignWidth'),
        sqlCaseWhenThenWrapLength: hasConfiguredValue(scopedConfig, 'caseWhenThenWrapLength'),
        sqlDialect: hasConfiguredValue(scopedConfig, 'dialect'),
        keywordCase: hasConfiguredValue(legacyConfig, 'keywordCase'),
        commaStyle: hasConfiguredValue(legacyConfig, 'commaStyle'),
        indentStyle: hasConfiguredValue(legacyConfig, 'indentStyle'),
        maxAlignWidth: hasConfiguredValue(legacyConfig, 'maxAlignWidth'),
        languageMode: true
    };

    return sqlRenderOptions.normalize(raw, explicit);
}

function hasConfiguredValue(config, key) {
    if (!config.inspect) {
        return false;
    }

    var inspected = config.inspect(key);
    if (!inspected) {
        return false;
    }

    return typeof inspected.globalValue !== 'undefined'
        || typeof inspected.workspaceValue !== 'undefined'
        || typeof inspected.workspaceFolderValue !== 'undefined'
        || typeof inspected.globalLanguageValue !== 'undefined'
        || typeof inspected.workspaceLanguageValue !== 'undefined'
        || typeof inspected.workspaceFolderLanguageValue !== 'undefined';
}

function showFormatterError(error) {
    var message = error && error.message ? error.message : String(error);
    vscode.window.showErrorMessage('SQL Beautify failed: ' + message);
}

function tryFormat(formatter, text) {
    try {
        return formatter(text);
    } catch (error) {
        showFormatterError(error);
        return null;
    }
}

function formatSql(text, document) {
    return sqlFormatter.format_sql(text, getSqlFormatterConfig(document));
}

function getFullDocumentRange(document) {
    return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function registerSqlFormattingProviders(context) {
    var selector = ['sql', 'hive-sql'];

    var documentFormatter = vscode.languages.registerDocumentFormattingEditProvider(selector, {
        provideDocumentFormattingEdits: function(document) {
            var formatted = tryFormat(function(text) {
                return formatSql(text, document);
            }, document.getText());
            if (formatted === null) {
                return [];
            }

            return [
                vscode.TextEdit.replace(getFullDocumentRange(document), formatted)
            ];
        }
    });

    var rangeFormatter = vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
        provideDocumentRangeFormattingEdits: function(document, range) {
            var formatted = tryFormat(function(text) {
                return formatSql(text, document);
            }, document.getText(range));
            if (formatted === null) {
                return [];
            }

            return [
                vscode.TextEdit.replace(range, formatted)
            ];
        }
    });

    context.subscriptions.push(documentFormatter);
    context.subscriptions.push(rangeFormatter);
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "sql-beautify" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    function runFormatSql() {
        replaceTargetRanges(function(text) {
            var editor = vscode.window.activeTextEditor;
            return formatSql(text, editor && editor.document);
        });
    }

    function runFormatHiveDdl() {
        replaceTargetRanges(function(text) {
            return vkbeautify.sqlddl(text);
        });
    }

    function runExtractHiveDdl() {
        replaceTargetRanges(function(text) {
            return vkbeautify.extractddl(text);
        });
    }

    var disposable = vscode.commands.registerCommand('extension.beautifySql', runFormatSql);
    var disposableAlias = vscode.commands.registerCommand('sqlBeautify.formatSql', runFormatSql);

    var disposable2 = vscode.commands.registerCommand('extension.beautifySqlddl', runFormatHiveDdl);
    var disposable2Alias = vscode.commands.registerCommand('sqlBeautify.formatHiveDdl', runFormatHiveDdl);

    var disposable3 = vscode.commands.registerCommand('extension.extractDdl', runExtractHiveDdl);
    var disposable3Alias = vscode.commands.registerCommand('sqlBeautify.extractHiveDdl', runExtractHiveDdl);

    context.subscriptions.push(disposable);
    context.subscriptions.push(disposableAlias);
    context.subscriptions.push(disposable2);
    context.subscriptions.push(disposable2Alias);
    context.subscriptions.push(disposable3);
    context.subscriptions.push(disposable3Alias);
    registerSqlFormattingProviders(context);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;
