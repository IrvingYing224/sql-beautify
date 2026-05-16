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

function note_unsupported(context, kind, text) {
    if (!context) {
        return;
    }

    if (!context.unsupportedSegments) {
        context.unsupportedSegments = [];
    }

    context.unsupportedSegments.push({
        kind: kind,
        text: text
    });
}

function has_unsupported(context) {
    return !!(context && context.unsupportedSegments && context.unsupportedSegments.length > 0);
}

function enforce_policy(context, policy) {
    var normalized = normalize_policy(policy);

    if (normalized == 'bail_out' && has_unsupported(context)) {
        throw new Error('Unsupported SQL fragment detected under bail_out policy.');
    }

    return normalized;
}

exports.normalize_policy = normalize_policy;
exports.note_unsupported = note_unsupported;
exports.has_unsupported = has_unsupported;
exports.enforce_policy = enforce_policy;
