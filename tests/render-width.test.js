var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var formatNodes = require('../lib/core/sql-format-nodes');
var navigation = require('../lib/core/sql-format-navigation');
var mutations = require('../lib/core/sql-format-mutations');
var renderWidth = require('../lib/core/sql-render-width');
var renderLineFacts = require('../lib/core/sql-render-line-facts');

function build_context(sql) {
	var config = {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	};
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	navigation.attach_scope_index(doc);
	var nodes = formatNodes.extract(doc, config);
	doc.nodes = nodes;
	return {
		document: doc,
		nodes: nodes,
		mutations: mutations.create(),
		config: config
	};
}

function compare_width_and_facts(label, context, lineIndex) {
	var width = renderWidth.create_width_context(context.document, context.nodes, context.mutations, context.config);
	var facts = renderLineFacts.create_line_facts_context(context.document, context.nodes, context.mutations, context.config);
	assert.strictEqual(
		width.planned_code_width(context.document.lines[lineIndex]),
		facts.code_width_before_comment(lineIndex),
		label + ': planned code width must match renderer facts'
	);
	assert.strictEqual(
		width.planned_code_segment(context.document.lines[lineIndex]),
		facts.code_segment_before_comment(lineIndex),
		label + ': planned code segment must match renderer facts'
	);
	assert.strictEqual(
		width.planned_join_prefix_width(context.document.lines[lineIndex]),
		facts.join_prefix_width(lineIndex),
		label + ': planned join prefix width must match renderer facts'
	);
}

var plain = build_context('select a as col -- first\nfrom t\n');
var width = renderWidth.create_width_context(plain.document, plain.nodes, plain.mutations, plain.config);
assert.strictEqual(width.planned_code_width(plain.document.lines[0]), 'select  a as col'.length, 'plain planned code width ignores trailing comment');
assert.strictEqual(width.planned_alignment_width(plain.document.lines[0]), 'select  a'.length, 'alignment width stops before top-level AS');
assert.strictEqual(width.planned_join_prefix_width(plain.document.lines[0]), 0, 'unjoined line has no join prefix width');

var comma = build_context("select coalesce(phone,email,'unknown') as contact_info -- c\nfrom users\n");
width = renderWidth.create_width_context(comma.document, comma.nodes, comma.mutations, comma.config);
assert.strictEqual(
	width.planned_code_segment(comma.document.lines[0]),
	"select  coalesce(phone, email, 'unknown') as contact_info",
	'planned code segment uses final inline comma spacing'
);

var indented = build_context('select a as col -- first\nfrom t\n');
mutations.add_line_indent(indented.mutations, 0, '    ');
width = renderWidth.create_width_context(indented.document, indented.nodes, indented.mutations, indented.config);
assert.strictEqual(width.planned_code_width(indented.document.lines[0]), 4 + 'select  a as col'.length, 'line indent mutation contributes to code width');
assert.strictEqual(width.planned_code_segment(indented.document.lines[0]), '    select  a as col', 'planned code segment includes effective indent');

var joined = build_context('select a as col -- first\nwhere b = 1 -- second\n');
mutations.add_line_join(joined.mutations, 1, ' ');
width = renderWidth.create_width_context(joined.document, joined.nodes, joined.mutations, joined.config);
assert.strictEqual(width.planned_join_prefix_width(joined.document.lines[1]), 'select  a as col '.length, 'joined line reports non-zero join prefix width');

compare_width_and_facts('plain line', plain, 0);
compare_width_and_facts('inline comma spacing', comma, 0);
compare_width_and_facts('indented line', indented, 0);
compare_width_and_facts('joined line', joined, 1);

var continuousJoined = build_context('select a\nwhere b = 1\nand c = 2\n');
mutations.add_line_join(continuousJoined.mutations, 1, ' ');
mutations.add_line_join(continuousJoined.mutations, 2, ' ');
width = renderWidth.create_width_context(continuousJoined.document, continuousJoined.nodes, continuousJoined.mutations, continuousJoined.config);
assert.strictEqual(
	width.planned_join_prefix_width(continuousJoined.document.lines[2]),
	'select  a where b = 1 '.length,
	'continuous line join prefix uses accumulated renderer last physical segment width'
);
assert.strictEqual(
	width.planned_code_segment(continuousJoined.document.lines[2]),
	'select  a where b = 1 and c = 2',
	'continuous line join segment matches accumulated renderer output'
);
compare_width_and_facts('continuous joined line', continuousJoined, 2);

var selectDistinctComment = build_context('select distinct a as a, b as b -- cb\nfrom t\n');
mutations.add_line_break_before_token(selectDistinctComment.mutations, first_word_token(selectDistinctComment, 0, 'A').id, '        ', '');
mutations.add_line_break_before_token(selectDistinctComment.mutations, first_word_token(selectDistinctComment, 0, 'B').id, '       ', ',');
width = renderWidth.create_width_context(selectDistinctComment.document, selectDistinctComment.nodes, selectDistinctComment.mutations, selectDistinctComment.config);
assert.strictEqual(
	width.planned_code_width(selectDistinctComment.document.lines[0]),
	'       ,b as b'.length,
	'select modifier trailing item comment uses final rendered field segment width'
);
compare_width_and_facts('select modifier trailing item comment', selectDistinctComment, 0);

var movedComma = build_context('select a as a,\nb as b -- second\nfrom t\n');
var firstSeparator = movedComma.nodes.separators.filter(function(separator) {
	return separator.ownerKind == 'selectList';
})[0];
mutations.add_separator_move(movedComma.mutations, firstSeparator.id, {
	lineIndex: 1,
	placement: 'linePrefix',
	text: ',',
	indentText: '       '
});
compare_width_and_facts('moved comma prefix', movedComma, 1);

function first_word_token(context, lineIndex, value) {
	var tokens = context.document.lines[lineIndex].codeTokens || [];
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'word' && tokens[i].value.toUpperCase() == value) {
			return tokens[i];
		}
	}
	return null;
}

var splitThenValue = build_context("select case when name = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz' then 123 -- c1\nfrom t\n");
mutations.add_line_break_before_token(splitThenValue.mutations, first_word_token(splitThenValue, 0, 'THEN').id, '    ', '');
width = renderWidth.create_width_context(splitThenValue.document, splitThenValue.nodes, splitThenValue.mutations, splitThenValue.config);
assert.strictEqual(
	width.planned_code_width(splitThenValue.document.lines[0]),
	"select  case when name = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz'".length,
	'multisegment branch value comment uses widest rendered physical segment'
);
compare_width_and_facts('multisegment branch value comment', splitThenValue, 0);

var joinedAfterMultisegment = build_context("select case when name = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz' then 123 -- c1\nfrom t\n");
mutations.add_line_break_before_token(joinedAfterMultisegment.mutations, first_word_token(joinedAfterMultisegment, 0, 'THEN').id, '    ', '');
mutations.add_line_join(joinedAfterMultisegment.mutations, 1, ' ');
width = renderWidth.create_width_context(joinedAfterMultisegment.document, joinedAfterMultisegment.nodes, joinedAfterMultisegment.mutations, joinedAfterMultisegment.config);
assert.strictEqual(
	width.planned_join_prefix_width(joinedAfterMultisegment.document.lines[1]),
	'    then 123 '.length,
	'line join prefix uses previous renderer last physical segment width'
);
compare_width_and_facts('joined after multisegment line', joinedAfterMultisegment, 1);

var splitBareThen = build_context("select case when name = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz' then -- c1\n    123 -- c2\nfrom t\n");
mutations.add_line_break_before_token(splitBareThen.mutations, first_word_token(splitBareThen, 0, 'THEN').id, '    ', '');
width = renderWidth.create_width_context(splitBareThen.document, splitBareThen.nodes, splitBareThen.mutations, splitBareThen.config);
assert.strictEqual(
	width.planned_code_width(splitBareThen.document.lines[0]),
	'    then'.length,
	'multisegment bare THEN comment uses its own rendered physical segment'
);
compare_width_and_facts('multisegment bare THEN comment', splitBareThen, 0);

console.log('render width tests passed');
