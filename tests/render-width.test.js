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
assert.strictEqual(width.planned_code_width(plain.document.lines[0]), 'select a as col'.length, 'plain planned code width ignores trailing comment');
assert.strictEqual(width.planned_alignment_width(plain.document.lines[0]), 'select a'.length, 'alignment width stops before top-level AS');
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
assert.strictEqual(width.planned_code_width(indented.document.lines[0]), 4 + 'select a as col'.length, 'line indent mutation contributes to code width');
assert.strictEqual(width.planned_code_segment(indented.document.lines[0]), '    select a as col', 'planned code segment includes effective indent');

var joined = build_context('select a as col -- first\nwhere b = 1 -- second\n');
mutations.add_line_join(joined.mutations, 1, ' ');
width = renderWidth.create_width_context(joined.document, joined.nodes, joined.mutations, joined.config);
assert.strictEqual(width.planned_join_prefix_width(joined.document.lines[1]), 'select a as col '.length, 'joined line reports non-zero join prefix width');

compare_width_and_facts('plain line', plain, 0);
compare_width_and_facts('inline comma spacing', comma, 0);
compare_width_and_facts('indented line', indented, 0);
compare_width_and_facts('joined line', joined, 1);

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

console.log('render width tests passed');
