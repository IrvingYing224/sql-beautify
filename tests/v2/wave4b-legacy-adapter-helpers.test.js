var assert = require('assert');
var configAdapter = require('../../lib/adapters/vscode-config');
var diagnosticAdapter = require('../../lib/adapters/formatter-diagnostics');

function vscodeConfig(explicitIndent, indentStyle) {
    return {
        workspace: {
            getConfiguration: function() {
                return {
                    get: function(key) {
                        var values = {
                            keywordCase: 'upper', commaStyle: 'leading', indentStyle: indentStyle,
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
        { languageId: 'hive-sql', uri: {} }
    ).indentStyle,
    'space',
    'unset sqlBeautify.indentStyle uses the canonical default'
);
assert.strictEqual(
    configAdapter.get_sql_formatter_config(
        vscodeConfig(true, 'tab'),
        { languageId: 'hive-sql', uri: {} }
    ).indentStyle,
    'tab',
    'explicit sqlBeautify.indentStyle is preserved'
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
