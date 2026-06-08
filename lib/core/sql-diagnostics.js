function normalize_kind(kind) {
    return String(kind || 'unknown')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase() || 'unknown';
}

function normalize_snippet(text) {
    var snippet = String(text || '').replace(/\r\n|\r/g, '\n');

    if (snippet.length > 180) {
        return snippet.slice(0, 180) + '...';
    }

    return snippet;
}

function infer_label(kind, text, explicitLabel) {
    var haystack = String(text || '');

    if (explicitLabel) {
        return String(explicitLabel).toUpperCase();
    }

    if (/\bMATCH\s*_?\s*RECOGNIZE\b/i.test(haystack)) {
        return 'MATCH_RECOGNIZE';
    }
    if (/\bUNPIVOT\b/i.test(haystack)) {
        return 'UNPIVOT';
    }
    if (/\bPIVOT\b/i.test(haystack)) {
        return 'PIVOT';
    }
    if (/\bMERGE\b/i.test(haystack)) {
        return 'MERGE';
    }
    if (/\bQUALIFY\b/i.test(haystack)) {
        return 'QUALIFY';
    }

    return normalize_kind(kind).toUpperCase();
}

function normalize_range(segment) {
    var range = segment && segment.range ? segment.range : segment || {};
    var start = typeof range.start == 'number' ? range.start : -1;
    var end = typeof range.end == 'number' ? range.end : -1;

    return {
        start: start,
        end: end
    };
}

function default_source(kind) {
    return normalize_kind(kind) == 'opaque_clause' ? 'opaque_protection' : 'syntax_risk_detector';
}

function segment_action(segment) {
    if (segment.source == 'opaque_protection') {
        return 'Review the preserved ' + segment.label + ' fragment, or set sqlBeautify.unsupportedSyntaxPolicy to bail_out to reject it.';
    }

    return 'Review the ' + segment.label + ' fragment manually, or set sqlBeautify.unsupportedSyntaxPolicy to bail_out to reject low-confidence SQL.';
}

function normalize_unsupported_segment(kind, segment) {
    var normalizedKind = normalize_kind(kind || (segment && segment.kind));
    var record = typeof segment == 'object' && segment !== null ? segment : {
        text: segment
    };
    var text = typeof record.text != 'undefined' && record.text !== null
        ? String(record.text)
        : typeof record.snippet != 'undefined' && record.snippet !== null
            ? String(record.snippet)
            : '';
    var snippet = normalize_snippet(
        typeof record.snippet != 'undefined' && record.snippet !== null
            ? record.snippet
            : text
    );
    var label = infer_label(normalizedKind, text || snippet, record.label);
    var source = record.source || default_source(normalizedKind);
    var normalized = {
        kind: normalizedKind,
        code: 'unsupported_' + normalizedKind,
        label: label,
        text: text,
        snippet: snippet,
        range: normalize_range(record),
        source: source,
        confidence: record.confidence || 'known_low_confidence',
        action: record.action || ''
    };

    if (!normalized.action) {
        normalized.action = segment_action(normalized);
    }

    return normalized;
}

function unique_labels(segments) {
    var labels = [];
    var seen = {};

    for (var i = 0; i < segments.length; i++) {
        if (!segments[i] || !segments[i].label || seen[segments[i].label]) {
            continue;
        }
        seen[segments[i].label] = true;
        labels.push(segments[i].label);
    }

    return labels;
}

function unsupported_summary(segments) {
    var normalizedSegments = segments || [];
    var labels = unique_labels(normalizedSegments);

    if (labels.length == 0) {
        return 'Unsupported or low-confidence SQL syntax was detected.';
    }

    return 'Unsupported or low-confidence SQL syntax was detected: ' + labels.join(', ') + '.';
}

function unsupported_action(segments) {
    var normalizedSegments = segments || [];

    if (normalizedSegments.length == 1 && normalizedSegments[0] && normalizedSegments[0].action) {
        return normalizedSegments[0].action;
    }

    return 'Review the reported SQL fragments manually, or set sqlBeautify.unsupportedSyntaxPolicy to bail_out to reject low-confidence SQL.';
}

function normalize_segments(segments) {
    var normalized = [];

    for (var i = 0; i < (segments || []).length; i++) {
        normalized.push(normalize_unsupported_segment(segments[i].kind, segments[i]));
    }

    return normalized;
}

function create_unsupported_runtime_diagnostic(segments) {
    var unsupportedSegments = normalize_segments(segments);

    return {
        level: 'warning',
        code: 'unsupported_syntax',
        message: unsupported_summary(unsupportedSegments),
        action: unsupported_action(unsupportedSegments),
        unsupportedSegments: unsupportedSegments
    };
}

exports.normalize_unsupported_segment = normalize_unsupported_segment;
exports.create_unsupported_runtime_diagnostic = create_unsupported_runtime_diagnostic;
exports.unsupported_summary = unsupported_summary;
exports.unsupported_action = unsupported_action;
