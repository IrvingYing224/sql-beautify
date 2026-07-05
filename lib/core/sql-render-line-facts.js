var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatUtils = require('./sql-format-utils');
var sqlLineModel = require('./sql-line-model');
var sqlRenderIndent = require('./sql-render-indent');
var sqlRenderLine = require('./sql-render-line');
var sqlRenderMoveState = require('./sql-render-move-state');

var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function create_line_facts_context(document, nodes, mutations, config) {
    var plan = mutations || sqlFormatMutations.create();
    var moveState = sqlRenderMoveState.build_move_state(nodes || {}, plan);
    var closeIndentByLine = sqlRenderIndent.build_close_indent_by_line(document, plan, moveState);
    var bodyIndentByLine = sqlRenderIndent.build_body_indent_by_line(document, plan, moveState);
    var cache = {};
    var alignmentWidthCache = {};

    function tokenizer_options_key(options) {
        var source = options || {};
        var keys = Object.keys(source).sort();
        var copy = {};
        for (var i = 0; i < keys.length; i++) {
            if (typeof source[keys[i]] != 'function') {
                copy[keys[i]] = source[keys[i]];
            }
        }
        return JSON.stringify(copy);
    }

    function cached_alignment_width_for_code(code) {
        var key = tokenizer_options_key(document && document.tokenizerOptions) + '\0' + String(code || '');
        if (Object.prototype.hasOwnProperty.call(alignmentWidthCache, key)) {
            return alignmentWidthCache[key];
        }
        var width = get_alignment_width_for_code(code, document.tokenizerOptions).width;
        alignmentWidthCache[key] = width;
        return width;
    }

    function render_line_before_alignment(lineIndex) {
        var key = String(lineIndex);
        if (Object.prototype.hasOwnProperty.call(cache, key)) {
            return cache[key];
        }

        var line = document.lines[lineIndex];
        if (!line) {
            cache[key] = {
                lineText: '',
                codeSegment: '',
                codeWidth: 0,
                alignmentWidth: 0,
                unjoinedCodeWidth: 0,
                lastCodeWidth: 0,
                outputLastCodeSegment: '',
                outputLastCodeWidth: 0,
                joinPrefixWidth: 0
            };
            return cache[key];
        }

        var lineMutations = sqlFormatMutations.get_for_line(plan, lineIndex);
        var rendered = sqlRenderLine.render_line_from_tokens(document, line, plan, moveState, config);

        if (!lineMutations.indent) {
            rendered = sqlRenderIndent.apply_scope_body_indent(rendered, bodyIndentByLine[key]);
        }
        rendered = sqlRenderIndent.apply_scope_close_indent(rendered, closeIndentByLine[key]);
        rendered = sqlRenderIndent.apply_indent(rendered, lineMutations.indent);
        rendered = sqlRenderIndent.apply_line_prefix(rendered, moveState.prefixesByLine[key]);

        var currentFacts = code_comment_segments(rendered);
        var useMaxSegmentFacts = currentFacts.segmentCount > 1
            && is_case_branch_value_comment_line(lineIndex)
            && !is_bare_case_branch_keyword(currentFacts.lastCodeSegment);
        var unjoinedCodeWidth = useMaxSegmentFacts ? currentFacts.maxCodeWidth : currentFacts.lastCodeWidth;
        var codeSegment = currentFacts.lastCodeSegment;
        var codeWidth = unjoinedCodeWidth;
        var alignmentWidth = useMaxSegmentFacts ? currentFacts.maxAlignmentWidth : currentFacts.lastAlignmentWidth;
        var outputLastCodeSegment = currentFacts.lastCodeSegment;
        var outputLastCodeWidth = currentFacts.lastCodeWidth;
        var joinPrefixWidth = 0;

        if (lineMutations.lineJoin && lineIndex > 0) {
            var previousFact = render_line_before_alignment(previous_rendered_line_index(lineIndex));
            var joinSeparator = typeof lineMutations.lineJoin.separatorText == 'string'
                ? lineMutations.lineJoin.separatorText
                : ' ';
            var joinedFirstSegment = previousFact.outputLastCodeSegment.replace(/[ \t]+$/g, '')
                + joinSeparator
                + currentFacts.firstCodeSegment.replace(/^\s+/g, '');
            var joinedFirstWidth = expand_tabs_for_width(joinedFirstSegment).length;
            var joinedFirstAlignmentWidth = cached_alignment_width_for_code(joinedFirstSegment);

            joinPrefixWidth = previousFact.outputLastCodeWidth
                + String(joinSeparator || '').length
                - currentFacts.firstLeadingWidth;
            if (currentFacts.commentSegmentIndex > 0) {
                joinPrefixWidth = 0;
            }
            if (currentFacts.segmentCount > 1) {
                codeSegment = currentFacts.lastCodeSegment;
                codeWidth = useMaxSegmentFacts ? max_width(joinedFirstWidth, currentFacts.maxCodeWidthAfterFirst) : currentFacts.lastCodeWidth;
                alignmentWidth = useMaxSegmentFacts ? max_width(joinedFirstAlignmentWidth, currentFacts.maxAlignmentWidthAfterFirst) : currentFacts.lastAlignmentWidth;
                outputLastCodeSegment = currentFacts.lastCodeSegment;
                outputLastCodeWidth = currentFacts.lastCodeWidth;
            } else {
                codeSegment = joinedFirstSegment;
                codeWidth = joinedFirstWidth;
                alignmentWidth = joinedFirstAlignmentWidth;
                outputLastCodeSegment = joinedFirstSegment;
                outputLastCodeWidth = joinedFirstWidth;
            }
        }

        cache[key] = {
            lineText: rendered,
            codeSegment: codeSegment,
            codeWidth: codeWidth,
            alignmentWidth: alignmentWidth,
            unjoinedCodeWidth: unjoinedCodeWidth,
            lastCodeWidth: currentFacts.lastCodeWidth,
            outputLastCodeSegment: outputLastCodeSegment,
            outputLastCodeWidth: outputLastCodeWidth,
            joinPrefixWidth: joinPrefixWidth
        };
        return cache[key];
    }

    function previous_rendered_line_index(lineIndex) {
        for (var i = lineIndex - 1; i >= 0; i--) {
            if (!plan.lineOmissions[String(i)]) {
                return i;
            }
        }
        return -1;
    }

    function code_comment_segments(rendered) {
        var segments = String(rendered || '').split('\n');
        var firstCodeSegment = '';
        var firstCodeWidth = 0;
        var firstAlignmentWidth = 0;
        var firstLeadingWidth = 0;
        var lastCodeSegment = '';
        var lastCodeWidth = 0;
        var lastAlignmentWidth = 0;
        var maxCodeWidth = 0;
        var maxAlignmentWidth = 0;
        var maxCodeWidthAfterFirst = 0;
        var maxAlignmentWidthAfterFirst = 0;
        var commentSegmentIndex = -1;

        for (var i = 0; i < segments.length; i++) {
            var parts = sqlLineModel.split_code_and_comment(segments[i], document.tokenizerOptions);
            var code = String(parts.code || '').replace(/[ \t]+$/g, '');
            var codeWidth = expand_tabs_for_width(code).length;
            var alignmentWidth = cached_alignment_width_for_code(code);

            if (i == 0) {
                firstCodeSegment = code;
                firstCodeWidth = codeWidth;
                firstAlignmentWidth = alignmentWidth;
                firstLeadingWidth = expand_tabs_for_width(code.match(/^\s*/)[0]).length;
            }
            lastCodeSegment = code;
            lastCodeWidth = codeWidth;
            lastAlignmentWidth = alignmentWidth;
            if (codeWidth > maxCodeWidth) {
                maxCodeWidth = codeWidth;
            }
            if (alignmentWidth > maxAlignmentWidth) {
                maxAlignmentWidth = alignmentWidth;
            }
            if (i > 0 && codeWidth > maxCodeWidthAfterFirst) {
                maxCodeWidthAfterFirst = codeWidth;
            }
            if (i > 0 && alignmentWidth > maxAlignmentWidthAfterFirst) {
                maxAlignmentWidthAfterFirst = alignmentWidth;
            }
            if (parts.comment != '') {
                commentSegmentIndex = i;
            }
        }

        return {
            firstCodeSegment: firstCodeSegment,
            firstCodeWidth: firstCodeWidth,
            firstAlignmentWidth: firstAlignmentWidth,
            firstLeadingWidth: firstLeadingWidth,
            lastCodeSegment: lastCodeSegment,
            lastCodeWidth: lastCodeWidth,
            lastAlignmentWidth: lastAlignmentWidth,
            maxCodeWidth: maxCodeWidth,
            maxAlignmentWidth: maxAlignmentWidth,
            maxCodeWidthAfterFirst: maxCodeWidthAfterFirst,
            maxAlignmentWidthAfterFirst: maxAlignmentWidthAfterFirst,
            commentSegmentIndex: commentSegmentIndex,
            segmentCount: segments.length
        };
    }

    function is_bare_case_branch_keyword(code) {
        return /^(WHEN|THEN|ELSE)$/i.test(String(code || '').replace(/^\s+|\s+$/g, ''));
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

    function max_width(left, right) {
        return left > right ? left : right;
    }

    function code_width_before_comment(lineIndex) {
        return render_line_before_alignment(lineIndex).codeWidth;
    }

    function unjoined_code_width_before_comment(lineIndex) {
        return render_line_before_alignment(lineIndex).unjoinedCodeWidth;
    }

    function join_prefix_width(lineIndex) {
        return render_line_before_alignment(lineIndex).joinPrefixWidth;
    }

    function code_segment_before_comment(lineIndex) {
        return render_line_before_alignment(lineIndex).codeSegment;
    }

    function alignment_width_before_comment(lineIndex) {
        return render_line_before_alignment(lineIndex).alignmentWidth;
    }

    return {
        code_width_before_comment: code_width_before_comment,
        unjoined_code_width_before_comment: unjoined_code_width_before_comment,
        join_prefix_width: join_prefix_width,
        code_segment_before_comment: code_segment_before_comment,
        alignment_width_before_comment: alignment_width_before_comment
    };
}

exports.create_line_facts_context = create_line_facts_context;
