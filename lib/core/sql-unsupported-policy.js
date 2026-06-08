var sqlDiagnostics = require('./sql-diagnostics');

var SUPPORTED_POLICIES = {
    preserve: true,
    warn: true,
    bail_out: true
};

function normalize_policy(value) {
    var normalized = String(value || 'preserve').toLowerCase();
    if (!SUPPORTED_POLICIES[normalized]) {
        return 'preserve';
    }
    return normalized;
}

function note_unsupported(context, kind, segment) {
    if (!context) {
        return;
    }

    if (!context.unsupportedSegments) {
        context.unsupportedSegments = [];
    }

    var normalized = sqlDiagnostics.normalize_unsupported_segment(kind, segment);

    for (var i = 0; i < context.unsupportedSegments.length; i++) {
        if (context.unsupportedSegments[i].kind == normalized.kind
            && context.unsupportedSegments[i].text == normalized.text
            && context.unsupportedSegments[i].source == normalized.source
            && context.unsupportedSegments[i].range
            && normalized.range
            && context.unsupportedSegments[i].range.start == normalized.range.start
            && context.unsupportedSegments[i].range.end == normalized.range.end) {
            return;
        }
    }

    context.unsupportedSegments.push(normalized);
}

function has_unsupported(context) {
    return !!(context && context.unsupportedSegments && context.unsupportedSegments.length > 0);
}

function enforce_policy(context, policy) {
    var normalized = normalize_policy(policy);

    if (normalized == 'bail_out' && has_unsupported(context)) {
        throw new Error([
            'Unsupported SQL fragment detected under bail_out policy.',
            sqlDiagnostics.unsupported_summary(context.unsupportedSegments || []),
            sqlDiagnostics.unsupported_action(context.unsupportedSegments || [])
        ].join(' '));
    }

    return normalized;
}

exports.normalize_policy = normalize_policy;
exports.note_unsupported = note_unsupported;
exports.has_unsupported = has_unsupported;
exports.enforce_policy = enforce_policy;
