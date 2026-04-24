// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var vkbeautify = require('./vkbeautify');

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
            builder.replace(range, formatter(text));
        }
    });
}

function getSqlFormatterConfig() {
    var config = vscode.workspace.getConfiguration('extension');

    return {
        uppercase: config.get('uppercase'),
        comma_location: config.get('comma_location'),
        bracket_char: config.get('bracket_char'),
        as_loc_cnt: config.get('as_loc_cnt'),
        case_when_then_wrap_length: config.get('case_when_then_wrap_length')
    };
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
        replaceTargetRanges(function(text) {
            var config = getSqlFormatterConfig();
            return vkbeautify.sql(
                text,
                config.uppercase,
                config.comma_location,
                config.bracket_char,
                config.as_loc_cnt,
                config.case_when_then_wrap_length
            );
        });
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
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;
