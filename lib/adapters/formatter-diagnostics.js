function create_diagnostics(vscode) {
    function is_debug_enabled() {
        var config = vscode.workspace && vscode.workspace.getConfiguration
            ? vscode.workspace.getConfiguration('sqlBeautify')
            : null;
        return !!(config && config.get && config.get('debugDiagnostics'));
    }

    function log_debug(payload) {
        if (!is_debug_enabled()) {
            return;
        }
        console.error('[sql-beautify]', JSON.stringify(payload));
    }

    function show_user_error(message, payload) {
        log_debug(payload);
        vscode.window.showErrorMessage(message);
    }

    function show_user_warning(message, payload) {
        log_debug(payload);
        if (vscode.window.showWarningMessage) {
            vscode.window.showWarningMessage(message);
            return;
        }
        vscode.window.showErrorMessage(message);
    }

    function diagnostic_message(item) {
        if (item && item.action) {
            return item.message + ' ' + item.action;
        }

        return item && item.message ? item.message : '';
    }

    return {
        formatter_failed: function(error, phase) {
            var message = error && error.message ? error.message : String(error);
            show_user_error('SQL Beautify failed: ' + message, {
                type: 'formatter_throw',
                phase: phase || 'format',
                message: message
            });
        },
        unsafe_fragment: function(reason, phase) {
            show_user_error('SQL Beautify failed: ' + reason, {
                type: 'unsafe_fragment',
                phase: phase || 'range_format',
                reason: reason
            });
        },
        rejected_edit: function() {
            show_user_error('SQL Beautify failed: VS Code rejected the edit.', {
                type: 'vscode_reject_edit',
                phase: 'editor_edit'
            });
        },
        overlapping_selection: function() {
            show_user_error('SQL Beautify failed: overlapping selections are not supported.', {
                type: 'overlapping_selection',
                phase: 'editor_edit'
            });
        },
        runtime_diagnostics: function(items, phase) {
            var list = items || [];

            for (var i = 0; i < list.length; i++) {
                if (list[i].level != 'warning') {
                    continue;
                }

                show_user_warning('SQL Beautify warning: ' + diagnostic_message(list[i]), {
                    type: list[i].code || 'runtime_warning',
                    phase: phase || 'format',
                    level: list[i].level,
                    unsupportedSegments: list[i].unsupportedSegments || []
                });
            }
        }
    };
}

exports.create_diagnostics = create_diagnostics;
