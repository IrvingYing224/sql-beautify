var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function assert_contains(name, actual, fragments) {
	for (var i = 0; i < fragments.length; i++) {
		assert.ok(
			actual.indexOf(fragments[i]) >= 0,
			name + '\n--- missing fragment ---\n' + fragments[i] + '\n--- actual ---\n' + actual
		);
	}
}

function assert_not_contains(name, actual, fragments) {
	for (var i = 0; i < fragments.length; i++) {
		assert.ok(
			actual.indexOf(fragments[i]) < 0,
			name + '\n--- forbidden fragment ---\n' + fragments[i] + '\n--- actual ---\n' + actual
		);
	}
}

var aliasedExpression = vkbeautify.extractddl("select a + b as total_amount -- 总金额\nfrom t");
assert_contains(
	'explicit alias stays extractable for complex expressions',
	aliasedExpression,
	['total_amount', 'COMMENT "总金额"']
);

var simpleReference = vkbeautify.extractddl("select t.user_id -- 用户ID\n, amount as amount -- 金额\nfrom t");
assert_contains(
	'simple column reference without alias stays extractable',
	simpleReference,
	['user_id', 'COMMENT "用户ID"']
);

var unsupportedMixed = vkbeautify.extractddl("select concat(a,b), case when x=1 then y else z end, named_struct('a',a,'b',b) as payload from t");
assert_contains(
	'only high-confidence aliased complex columns survive mixed extractddl inputs',
	unsupportedMixed,
	['payload']
);
assert_not_contains(
	'unsupported mixed expressions must not be guessed into fake columns',
	unsupportedMixed,
	['concat', 'end BIGINT', 'case BIGINT']
);

assert.strictEqual(
	vkbeautify.extractddl('select a + b, concat(a,b), case when x=1 then y else z end from t').trim(),
	'',
	'unsupported complex expressions without alias must be skipped entirely'
);

var unionConsistent = vkbeautify.extractddl([
	'select a as id -- ID from first branch',
	'from t1',
	'union all',
	'select b as id -- ID from second branch',
	'from t2'
].join('\n'));
assert_contains(
	'extractddl supports consistent UNION branches',
	unionConsistent,
	['id', 'COMMENT "ID from first branch"']
);

var subqueryUnion = vkbeautify.extractddl([
	'select x.id -- outer id',
	'from (',
	'select a as id from t1',
	'union all',
	'select b as id from t2',
	') x'
].join('\n'));
assert_contains(
	'extractddl ignores set operators inside subqueries when splitting branches',
	subqueryUnion,
	['id', 'COMMENT "outer id"']
);

var unionMismatch = vkbeautify.extractddl([
	'select a as first_id -- first',
	'from t1',
	'union all',
	'select b as second_id -- second',
	'from t2'
].join('\n'));
assert.strictEqual(
	unionMismatch.trim(),
	'',
	'extractddl must reject inconsistent UNION branch schemas instead of returning the final branch'
);

var escapedComment = vkbeautify.extractddl('select a as display_name -- user "display" name\nfrom t');
assert_contains(
	'extractddl escapes double quotes inside generated comment literal',
	escapedComment,
	['display_name BIGINT COMMENT "user \\"display\\" name"']
);

console.log('extractddl safety tests passed');
