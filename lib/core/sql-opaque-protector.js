var sqlTokenizer = require('./sql-tokenizer');
var sqlClauseContext = require('./sql-clause-context');
var sqlUnsupportedPolicy = require('./sql-unsupported-policy');

function note_opaque_segment(context, range) {
    var protectedSource = !(range && range.complete === false);
    sqlUnsupportedPolicy.note_unsupported(context, 'opaque_clause', {
        kind: 'opaque_clause',
        label: 'MATCH_RECOGNIZE',
        text: range.text,
        snippet: range.text,
        range: {
            start: range.start,
            end: range.end
        },
        source: protectedSource ? 'opaque_protection' : 'syntax_risk_detector',
        confidence: 'known_low_confidence'
    });
}

function protect_opaque_segments(text, dialect, context, options) {
    var behavior = options || {};
    var recordUnsupported = behavior.recordUnsupported !== false;
    var tokens = sqlTokenizer.tokenize(text, dialect);
    var result = '';
    var cursor = 0;
    var range;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type != 'word') {
            continue;
        }

        range = sqlClauseContext.match_recognize_range(text, tokens, i);
        if (!range) {
            continue;
        }
        if (range.complete === false) {
            if (recordUnsupported) {
                note_opaque_segment(context, range);
            }
            continue;
        }

        if (recordUnsupported) {
            note_opaque_segment(context, range);
        }
        result += text.slice(cursor, range.start);
        result += context.store('opaque_clause', range.text);
        cursor = range.end;
        i = range.endIndex;
    }

    result += text.slice(cursor);
    return result;
}

function restore_opaque_segments(text, context) {
    return context.restore('opaque_clause', text);
}

exports.protect_opaque_segments = protect_opaque_segments;
exports.restore_opaque_segments = restore_opaque_segments;
