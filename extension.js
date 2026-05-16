// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var vkbeautify = require('./vkbeautify');
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

    editor.edit(function(builder) {
        for (var i = 0; i < ranges.length; i++) {
            var range = ranges[i];
            var text = editor.document.getText(range).toString();
            var formatted = tryFormat(formatter, text);
            if (formatted !== null) {
                builder.replace(range, formatted);
            }
        }
    });
}

function getSqlFormatterConfig() {
    var config = vscode.workspace.getConfiguration('extension');
    var raw = {
        keywordCase: config.get('keywordCase'),
        commaStyle: config.get('commaStyle'),
        indentStyle: config.get('indentStyle'),
        maxAlignWidth: config.get('maxAlignWidth'),
        uppercase: config.get('uppercase'),
        comma_location: config.get('comma_location'),
        bracket_char: config.get('bracket_char'),
        as_loc_cnt: config.get('as_loc_cnt'),
        case_when_then_wrap_length: config.get('case_when_then_wrap_length')
    };
    var explicit = {
        keywordCase: hasConfiguredValue(config, 'keywordCase'),
        commaStyle: hasConfiguredValue(config, 'commaStyle'),
        indentStyle: hasConfiguredValue(config, 'indentStyle'),
        maxAlignWidth: hasConfiguredValue(config, 'maxAlignWidth')
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
        || typeof inspected.defaultLanguageValue !== 'undefined'
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

function formatSql(text) {
    var config = getSqlFormatterConfig();
    return vkbeautify.sql(
        text,
        config.uppercase,
        config.comma_location,
        config.bracket_char,
        config.as_loc_cnt,
        config.case_when_then_wrap_length
    );
}

function getFullDocumentRange(document) {
    return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function registerSqlFormattingProviders(context) {
    var selector = ['sql', 'hive-sql'];

    var documentFormatter = vscode.languages.registerDocumentFormattingEditProvider(selector, {
        provideDocumentFormattingEdits: function(document) {
            var formatted = tryFormat(formatSql, document.getText());
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
            var formatted = tryFormat(formatSql, document.getText(range));
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
    var disposable = vscode.commands.registerCommand('extension.beautifySql', function () {
        replaceTargetRanges(formatSql);
    });

    var disposable2 = vscode.commands.registerCommand('extension.beautifySqlddl', function () {
        replaceTargetRanges(function(text) {
            return vkbeautify.sqlddl(text);
        });
    });

    var disposable3 = vscode.commands.registerCommand('extension.extractDdl', function () {
        replaceTargetRanges(function(text) {
            return vkbeautify.extractddl(text);
        });
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(disposable2);
    context.subscriptions.push(disposable3);
    registerSqlFormattingProviders(context);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;
