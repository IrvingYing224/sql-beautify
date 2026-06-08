var packageJson = require('../../package.json');
var sqlFormatter = require('../core/sql-formatter');
var sqlSafeDiagnosticReport = require('../core/sql-safe-diagnostic-report');
var vscodeConfig = require('./vscode-config');

function get_selected_text(vscode, editor) {
    var selections = editor && editor.selections ? editor.selections : [];
    var selected = [];
    var i;
    var selection;
    var range;
    var text;

    for (i = 0; i < selections.length; i++) {
        selection = selections[i];
        if (!selection || selection.start.isEqual(selection.end)) {
            continue;
        }

        range = new vscode.Range(selection.start, selection.end);
        text = editor.document.getText(range).toString();
        if (text.length > 0) {
            selected.push(text);
        }
    }

    if (selected.length > 0) {
        return selected.join('\n');
    }

    return editor.document.getText().toString();
}

function error_message(error) {
    return error && error.message ? String(error.message) : String(error || '');
}

function create_error_result(error) {
    return {
        diagnostics: error && error.sqlBeautifyDiagnostics ? error.sqlBeautifyDiagnostics : [],
        telemetry: error && error.sqlBeautifyTelemetry ? error.sqlBeautifyTelemetry : null,
        error: error
    };
}

function create_report_from_error(activeSafeReport, text, config, extensionVersion, error) {
    return activeSafeReport.create_report({
        text: text,
        phase: 'command_format',
        options: config,
        result: create_error_result(error),
        error: error,
        failureType: error && error.sqlBeautifyClassification,
        extensionVersion: extensionVersion
    });
}

function create_copy_safe_diagnostic_report_command(vscode, dependencies) {
    var deps = dependencies || {};
    var activeSqlFormatter = deps.sqlFormatter || sqlFormatter;
    var activeSafeReport = deps.safeReport || sqlSafeDiagnosticReport;
    var extensionVersion = deps.extensionVersion || packageJson.version;

    return function run_copy_safe_diagnostic_report() {
        var editor = vscode.window.activeTextEditor;
        var text;
        var config;
        var detailed;
        var report;
        var markdown;

        if (!editor) {
            vscode.window.showErrorMessage('SQL Beautify failed: no active editor.');
            return Promise.resolve(false);
        }

        text = get_selected_text(vscode, editor);
        config = vscodeConfig.get_sql_formatter_config(vscode, editor.document);
        config.includeTelemetry = true;
        config.phase = 'command_format';

        try {
            detailed = activeSqlFormatter.format_sql_detailed(text, config);
            report = detailed && detailed.safeReport ? detailed.safeReport : activeSafeReport.create_report({
                text: text,
                phase: 'command_format',
                options: config,
                result: detailed,
                extensionVersion: extensionVersion
            });
        } catch (error) {
            report = create_report_from_error(activeSafeReport, text, config, extensionVersion, error);
        }

        report.extensionVersion = extensionVersion;
        markdown = activeSafeReport.render_markdown(report);

        return vscode.env.clipboard.writeText(markdown).then(function() {
            vscode.window.showInformationMessage('SQL Beautify safe diagnostic report copied.');
            return true;
        }, function(error) {
            vscode.window.showErrorMessage(
                'SQL Beautify failed: could not copy safe diagnostic report. ' + error_message(error)
            );
            return false;
        });
    };
}

exports.get_selected_text = get_selected_text;
exports.create_copy_safe_diagnostic_report_command = create_copy_safe_diagnostic_report_command;
