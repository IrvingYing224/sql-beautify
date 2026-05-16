var sqlTokenizer = require('../core/sql-tokenizer');
var sqlClauseRegistry = require('../core/sql-clause-registry');

function get_offset(document, position) {
    if (document && typeof document.offsetAt == 'function') {
        return document.offsetAt(position);
    }
    return position && typeof position.offset == 'number' ? position.offset : 0;
}

function is_line_boundary(text, offset, side) {
    if (side == 'start') {
        return offset <= 0 || text[offset - 1] == '\n' || text[offset - 1] == '\r';
    }
    return offset >= text.length || text[offset] == '\n' || text[offset] == '\r';
}

function get_first_meaningful_token(tokens) {
    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type != 'whitespace' && tokens[i].type != 'newline') {
            return tokens[i];
        }
    }
    return null;
}

function has_balanced_structure(tokens) {
    var parenDepth = 0;
    var caseDepth = 0;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
            parenDepth += 1;
        } else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
            parenDepth -= 1;
            if (parenDepth < 0) {
                return false;
            }
        } else if (tokens[i].type == 'word' && /^CASE$/i.exec(tokens[i].value)) {
            caseDepth += 1;
        } else if (tokens[i].type == 'word' && /^END$/i.exec(tokens[i].value)) {
            caseDepth -= 1;
            if (caseDepth < 0) {
                return false;
            }
        }
    }

    return parenDepth == 0 && caseDepth == 0;
}

function starts_with_safe_boundary(text, dialect) {
    var trimmed = String(text || '').replace(/^\s+/g, '');
    if (trimmed == '' || /^--/.test(trimmed)) {
        return true;
    }
    if (/^,/.test(trimmed) || /^(AND|OR|WHEN|THEN|ELSE|END)\b/i.test(trimmed)) {
        return false;
    }
    return sqlClauseRegistry.is_statement_start(trimmed, dialect)
        || sqlClauseRegistry.is_select_block_start(trimmed, dialect)
        || sqlClauseRegistry.is_condition_clause(trimmed, dialect)
        || /^(FROM|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|ORDER BY|SORT BY|CLUSTER BY|DISTRIBUTE BY|LIMIT|UNION|INTERSECT|EXCEPT|\()/.test(trimmed.toUpperCase());
}

function analyze_range(document, range, dialectCapabilities) {
    var dialect = dialectCapabilities && dialectCapabilities.dialect ? dialectCapabilities.dialect : 'generic';
    var fullText = document.getText();
    var startOffset = get_offset(document, range.start);
    var endOffset = get_offset(document, range.end);
    var selectedText = document.getText(range);
    var tokens = sqlTokenizer.tokenize(selectedText, dialectCapabilities);
    var firstToken = get_first_meaningful_token(tokens);

    if (!is_line_boundary(fullText, startOffset, 'start') || !is_line_boundary(fullText, endOffset, 'end')) {
        return {
            safe: false,
            reason: 'unsafe range formatting fragment: only whole-line selections are supported.'
        };
    }

    if (firstToken == null) {
        return {
            safe: true
        };
    }

    if (!starts_with_safe_boundary(selectedText, dialect)) {
        return {
            safe: false,
            reason: 'unsafe range formatting fragment: selection must start at a statement or clause boundary.'
        };
    }

    if (!has_balanced_structure(tokens)) {
        return {
            safe: false,
            reason: 'unsafe range formatting fragment: selection contains incomplete SQL structure.'
        };
    }

    return {
        safe: true
    };
}

exports.analyze_range = analyze_range;
