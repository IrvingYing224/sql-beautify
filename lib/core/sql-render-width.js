var sqlRenderLineFacts = require('./sql-render-line-facts');

function create_width_context(document, nodes, mutations, config) {
    var lineFacts = sqlRenderLineFacts.create_line_facts_context(document, nodes, mutations, config);

    function planned_prefix_width(lineIndex) {
        var line = document.lines[lineIndex];
        if (!line) {
            return 0;
        }
        return lineFacts.code_width_before_comment(lineIndex)
            - lineFacts.unjoined_code_width_before_comment(lineIndex);
    }

    function planned_code_width(line) {
        return lineFacts.code_width_before_comment(line.index);
    }

    function planned_join_prefix_width(line) {
        return lineFacts.join_prefix_width(line.index);
    }

    function planned_code_segment(line) {
        return lineFacts.code_segment_before_comment(line.index);
    }

    function planned_alignment_width(line) {
        return lineFacts.alignment_width_before_comment(line.index);
    }

    function token_after_case_end_on_same_line(caseNode, lineIndex, value) {
        if (!caseNode || !caseNode.endKeywordToken || caseNode.endKeywordToken.line != lineIndex) {
            return null;
        }

        var line = document.lines[lineIndex];
        for (var i = caseNode.endKeywordToken.index + 1; i < document.tokens.length; i++) {
            var token = document.tokens[i];
            if (!token || token.line != lineIndex) {
                break;
            }
            if (!token.isCode) {
                continue;
            }
            if (line && line.commentStart >= 0 && token.column >= line.commentStart) {
                break;
            }
            if (token.type == 'word' && token.value.toUpperCase() == value) {
                return token;
            }
        }

        return null;
    }

    function is_case_end_alias_comment_line(lineIndex) {
        var line = document.lines[lineIndex];
        if (!line || !line.hasTrailingComment) {
            return false;
        }

        var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
        for (var i = 0; i < cases.length; i++) {
            if (token_after_case_end_on_same_line(cases[i], lineIndex, 'AS')) {
                return true;
            }
        }

        return false;
    }

    function is_case_branch_value_comment_line(lineIndex) {
        var line = document.lines[lineIndex];
        if (!line || !line.hasTrailingComment || is_case_end_alias_comment_line(lineIndex)) {
            return false;
        }

        var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
        for (var i = 0; i < cases.length; i++) {
            var caseNode = cases[i];
            for (var b = 0; b < (caseNode.branches || []).length; b++) {
                var branch = caseNode.branches[b];
                if (branch.thenKeywordToken && branch.thenKeywordToken.line == lineIndex) {
                    return true;
                }
            }
            if (caseNode.elseKeywordToken && caseNode.elseKeywordToken.line == lineIndex) {
                return true;
            }
        }

        return false;
    }

    return {
        planned_prefix_width: planned_prefix_width,
        planned_code_width: planned_code_width,
        planned_join_prefix_width: planned_join_prefix_width,
        planned_code_segment: planned_code_segment,
        planned_alignment_width: planned_alignment_width,
        is_case_end_alias_comment_line: is_case_end_alias_comment_line,
        is_case_branch_value_comment_line: is_case_branch_value_comment_line
    };
}

exports.create_width_context = create_width_context;
