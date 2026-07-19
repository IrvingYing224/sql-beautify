var assert = require('assert');
var configAdapter = require('../../lib/adapters/vscode-config');
var diagnosticAdapter = require('../../lib/adapters/formatter-diagnostics');

function vscodeConfig(explicitIndent) {
    return {
        workspace: {
            getConfiguration: function() {
                return {
                    get: function(key) {
                        var values = {
                            keywordCase: 'upper', commaStyle: 'leading', indentStyle: 'space',
                            maxAlignWidth: 150, caseWhenThenWrapLength: 50,
                            caseLayout: 'expanded', dialect: 'hive',
                            unsupportedSyntaxPolicy: 'preserve'
                        };
                        return values[key];
                    },
                    inspect: function(key) {
                        return key == 'indentStyle' && explicitIndent
                            ? { workspaceValue: 'space' }
                            : {};
                    }
                };
            }
        }
    };
}

assert.strictEqual(
    configAdapter.get_sql_formatter_config(
        vscodeConfig(false),
        { languageId: 'hive-sql', uri: {} },
        { insertSpaces: false }
    ).indentStyle,
    'tab',
    'FormattingOptions.insertSpaces applies when indentStyle is not explicit'
);
assert.strictEqual(
    configAdapter.get_sql_formatter_config(
        vscodeConfig(true),
        { languageId: 'hive-sql', uri: {} },
        { insertSpaces: false }
    ).indentStyle,
    'space',
    'explicit sqlBeautify.indentStyle has priority over FormattingOptions'
);

var warnings = [];
var vscodeDiagnostics = {
    workspace: {
        getConfiguration: function() {
            return { get: function() { return false; } };
        }
    },
    window: {
        showWarningMessage: function(message) { warnings.push(message); }
    }
};
var diagnostics = diagnosticAdapter.create_diagnostics(vscodeDiagnostics);
diagnostics.runtime_diagnostics([
    { level: 'warning', message: 'first warning' },
    { level: 'error', message: 'ignored error' }
], 'document_format');
assert.deepStrictEqual(warnings, ['SQL Beautify warning: first warning'],
    'legacy warning diagnostics remain unchanged');

console.log('v2 Wave 4B legacy adapter helper tests passed');
