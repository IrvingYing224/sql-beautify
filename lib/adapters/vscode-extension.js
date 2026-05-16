var sqlFormatter = require('../core/sql-formatter');
var ddlFormatter = require('../experimental/ddl');
var vscodeConfig = require('./vscode-config');

function create_extension(vscode, dependencies) {
    var deps = dependencies || {};
    var activeSqlFormatter = deps.sqlFormatter || sqlFormatter;
    var activeDdlFormatter = deps.ddlFormatter || ddlFormatter;

    function get_target_ranges(editor) {
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

    function show_formatter_error(error) {
        var message = error && error.message ? error.message : String(error);
        vscode.window.showErrorMessage('SQL Beautify failed: ' + message);
    }

    function try_format(formatter, text) {
        try {
            return formatter(text);
        } catch (error) {
            show_formatter_error(error);
            return null;
        }
    }

    function replace_target_ranges(formatter) {
        var editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        var ranges = get_target_ranges(editor);
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
                var formatted = try_format(formatter, text);
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

    function format_sql(text, document) {
        return activeSqlFormatter.format_sql(text, vscodeConfig.get_sql_formatter_config(vscode, document));
    }

    function get_full_document_range(document) {
        return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    }

    function register_sql_formatting_providers(context) {
        var selector = ['sql', 'hive-sql'];

        var documentFormatter = vscode.languages.registerDocumentFormattingEditProvider(selector, {
            provideDocumentFormattingEdits: function(document) {
                var formatted = try_format(function(text) {
                    return format_sql(text, document);
                }, document.getText());
                if (formatted === null) {
                    return [];
                }

                return [
                    vscode.TextEdit.replace(get_full_document_range(document), formatted)
                ];
            }
        });

        var rangeFormatter = vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
            provideDocumentRangeFormattingEdits: function(document, range) {
                var formatted = try_format(function(text) {
                    return format_sql(text, document);
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

    function activate(context) {
        console.log('Congratulations, your extension "sql-beautify" is now active!');

        function run_format_sql() {
            replace_target_ranges(function(text) {
                var editor = vscode.window.activeTextEditor;
                return format_sql(text, editor && editor.document);
            });
        }

        function run_format_hive_ddl() {
            replace_target_ranges(function(text) {
                return activeDdlFormatter.ddl(text);
            });
        }

        function run_extract_hive_ddl() {
            replace_target_ranges(function(text) {
                return activeDdlFormatter.extractddl(text);
            });
        }

        var disposable = vscode.commands.registerCommand('extension.beautifySql', run_format_sql);
        var disposableAlias = vscode.commands.registerCommand('sqlBeautify.formatSql', run_format_sql);

        var disposable2 = vscode.commands.registerCommand('extension.beautifySqlddl', run_format_hive_ddl);
        var disposable2Alias = vscode.commands.registerCommand('sqlBeautify.formatHiveDdl', run_format_hive_ddl);

        var disposable3 = vscode.commands.registerCommand('extension.extractDdl', run_extract_hive_ddl);
        var disposable3Alias = vscode.commands.registerCommand('sqlBeautify.extractHiveDdl', run_extract_hive_ddl);

        context.subscriptions.push(disposable);
        context.subscriptions.push(disposableAlias);
        context.subscriptions.push(disposable2);
        context.subscriptions.push(disposable2Alias);
        context.subscriptions.push(disposable3);
        context.subscriptions.push(disposable3Alias);
        register_sql_formatting_providers(context);
    }

    function deactivate() {
    }

    return {
        activate: activate,
        deactivate: deactivate
    };
}

exports.create_extension = create_extension;
