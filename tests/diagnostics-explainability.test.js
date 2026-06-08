var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');
var vkbeautify = require('../vkbeautify');

function detailed(sql, options) {
	return sqlFormatter.format_sql_detailed(sql, Object.assign({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'warn'
	}, options || {}));
}

var matchResult = detailed(
	'select * from t match_recognize (partition by a order by b measures match_number() as mn)'
);
var matchDiagnostic = matchResult.diagnostics.filter(function(item) {
	return item.code == 'unsupported_syntax';
})[0];

assert.ok(matchDiagnostic, 'warn policy must return unsupported_syntax diagnostic');
assert.ok(/unsupported/i.test(matchDiagnostic.message), 'diagnostic message must explain unsupported syntax');
assert.ok(matchDiagnostic.action, 'diagnostic must include user action');
assert.ok(matchDiagnostic.unsupportedSegments.length > 0, 'diagnostic must include unsupported segments');

var matchSegment = matchDiagnostic.unsupportedSegments[0];
assert.strictEqual(matchSegment.kind, 'opaque_clause', 'MATCH_RECOGNIZE segment kind must be opaque_clause');
assert.strictEqual(matchSegment.code, 'unsupported_opaque_clause', 'MATCH_RECOGNIZE segment code must be stable');
assert.strictEqual(matchSegment.label, 'MATCH_RECOGNIZE', 'MATCH_RECOGNIZE segment label must be explicit');
assert.strictEqual(matchSegment.source, 'opaque_protection', 'MATCH_RECOGNIZE segment source must explain preservation path');
assert.strictEqual(matchSegment.confidence, 'known_low_confidence', 'segment confidence must be explicit');
assert.ok(matchSegment.text.indexOf('match_recognize') >= 0, 'segment must retain original text');
assert.ok(matchSegment.snippet.indexOf('match_recognize') >= 0, 'segment must include readable snippet');
assert.ok(matchSegment.range && typeof matchSegment.range.start == 'number', 'segment must include numeric range.start');
assert.ok(matchSegment.range && typeof matchSegment.range.end == 'number', 'segment must include numeric range.end');
assert.ok(matchSegment.action, 'segment must include actionable guidance');

var pivotResult = detailed('select * from t pivot (sum(x) for y in (1))');
var pivotSegment = pivotResult.diagnostics[0].unsupportedSegments.filter(function(item) {
	return item.label == 'PIVOT';
})[0];
assert.ok(pivotSegment, 'PIVOT table construct must produce a labeled diagnostic segment');
assert.strictEqual(pivotSegment.kind, 'known_unmodeled_construct', 'PIVOT segment kind must remain known_unmodeled_construct');
assert.strictEqual(pivotSegment.source, 'syntax_risk_detector', 'PIVOT segment source must explain detector path');

var duplicatePivotResult = detailed([
	'select * from t pivot (sum(x) for y in (1))',
	'select * from u pivot (sum(a) for b in (2))'
].join('; '));
var duplicatePivotSegments = duplicatePivotResult.diagnostics[0].unsupportedSegments.filter(function(item) {
	return item.label == 'PIVOT';
});
assert.strictEqual(
	duplicatePivotSegments.length,
	2,
	'two real PIVOT constructs must produce two diagnostic segments'
);
assert.notStrictEqual(
	duplicatePivotSegments[0].range.start,
	duplicatePivotSegments[1].range.start,
	'distinct PIVOT constructs must preserve distinct ranges'
);

var incompleteMatchResult = detailed('select * from t match_recognize (');
var incompleteMatchSegment = incompleteMatchResult.diagnostics[0].unsupportedSegments.filter(function(item) {
	return item.label == 'MATCH_RECOGNIZE';
})[0];
assert.ok(incompleteMatchSegment, 'incomplete MATCH_RECOGNIZE must still produce a diagnostic segment');
assert.strictEqual(
	incompleteMatchSegment.source,
	'syntax_risk_detector',
	'incomplete MATCH_RECOGNIZE must not claim opaque protection when it was not preserved'
);
assert.ok(
	!/preserved/i.test(incompleteMatchSegment.action),
	'incomplete MATCH_RECOGNIZE segment action must not claim preserved text'
);
assert.ok(
	!/preserved/i.test(incompleteMatchResult.diagnostics[0].action),
	'incomplete MATCH_RECOGNIZE diagnostic action must not claim preserved text'
);

var setCompleteMatchResult = detailed(
	'set hive.exec.dynamic.partition = true; select * from t match_recognize (partition by a order by b measures match_number() as mn)'
);
var setCompleteMatchSegments = setCompleteMatchResult.diagnostics[0].unsupportedSegments.filter(function(item) {
	return item.label == 'MATCH_RECOGNIZE';
});
assert.strictEqual(
	setCompleteMatchSegments.length,
	1,
	'SET payload protection must not duplicate complete MATCH_RECOGNIZE diagnostics'
);
assert.strictEqual(
	setCompleteMatchSegments[0].source,
	'opaque_protection',
	'complete SET + MATCH_RECOGNIZE must still report opaque protection'
);
assert.ok(
	/preserved/i.test(setCompleteMatchSegments[0].action),
	'complete SET + MATCH_RECOGNIZE action must still describe preservation'
);

var setIncompleteMatchResult = detailed('set hive.exec.dynamic.partition = true; select * from t match_recognize (');
var setIncompleteMatchSegments = setIncompleteMatchResult.diagnostics[0].unsupportedSegments.filter(function(item) {
	return item.label == 'MATCH_RECOGNIZE';
});
assert.strictEqual(
	setIncompleteMatchSegments.length,
	1,
	'SET payload protection must not duplicate incomplete MATCH_RECOGNIZE diagnostics'
);
assert.strictEqual(
	setIncompleteMatchSegments[0].source,
	'syntax_risk_detector',
	'incomplete SET + MATCH_RECOGNIZE must report detector source'
);
assert.ok(
	setIncompleteMatchSegments[0].text.indexOf('SQLBEAUTIFY_') < 0,
	'incomplete SET + MATCH_RECOGNIZE text must not leak internal markers'
);
assert.ok(
	setIncompleteMatchSegments[0].snippet.indexOf('SQLBEAUTIFY_') < 0,
	'incomplete SET + MATCH_RECOGNIZE snippet must not leak internal markers'
);

var safeIdentifier = detailed('select qualify as c, pivot as p from t where pivot(p)=1', {
	dialect: 'postgres'
});
assert.strictEqual(safeIdentifier.diagnostics.length, 0, 'keyword-shaped identifiers and functions must not warn');

assert.throws(
	function() {
		vkbeautify.sql(
			'select * from t match_recognize (partition by a order by b measures match_number() as mn)',
			true,
			false,
			true,
			150,
			80,
			{
				dialect: 'generic',
				unsupportedSyntaxPolicy: 'bail_out'
			}
		);
	},
	/Unsupported SQL fragment detected under bail_out policy.*MATCH_RECOGNIZE/,
	'bail_out error must keep the stable prefix and include the first unsupported label'
);

console.log('diagnostics explainability tests passed');
