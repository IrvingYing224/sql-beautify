var assert = require('assert');
var sqlTokenizer = require('../lib/core/sql-tokenizer');
var clauseContext = require('../lib/core/sql-clause-context');

function tokens(sql) {
	return sqlTokenizer.tokenize(sql, { dialect: 'generic' });
}

function code_tokens(sql) {
	return tokens(sql).filter(function(token) {
		return token.type != 'whitespace'
			&& token.type != 'newline'
			&& token.type != 'line_comment'
			&& token.type != 'block_comment';
	});
}

function word_index(tokenList, value, occurrence) {
	var seen = 0;
	for (var i = 0; i < tokenList.length; i++) {
		if (tokenList[i].type == 'word' && tokenList[i].value.toUpperCase() == value) {
			if (seen == (occurrence || 0)) {
				return i;
			}
			seen += 1;
		}
	}
	return -1;
}

function context_after_clauses(clauseNames) {
	var context = clauseContext.create_query_context();
	for (var i = 0; i < clauseNames.length; i++) {
		clauseContext.update_query_clause_context(context, clauseNames[i]);
	}
	return context;
}

var qualifyClauseTokens = code_tokens('select * from t qualify row_number() over(partition by a order by b)=1');
var qualifyClauseIndex = word_index(qualifyClauseTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyClauseTokens,
		qualifyClauseIndex,
		context_after_clauses(['SELECT', 'FROM'])
	),
	true,
	'QUALIFY after SELECT ... FROM with expression must be treated as a real clause'
);

var qualifyAliasTokens = code_tokens('select qualify as c from t');
var qualifyAliasIndex = word_index(qualifyAliasTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyAliasTokens,
		qualifyAliasIndex,
		context_after_clauses(['SELECT'])
	),
	false,
	'QUALIFY-shaped SELECT-list identifier must not be treated as a real clause'
);

var qualifyOperandTokens = code_tokens('select * from t where qualify = 1');
var qualifyOperandIndex = word_index(qualifyOperandTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyOperandTokens,
		qualifyOperandIndex,
		context_after_clauses(['SELECT', 'FROM', 'WHERE'])
	),
	false,
	'QUALIFY-shaped WHERE operand must not be treated as a real clause'
);

var qualifyFunctionTokens = code_tokens('select * from t where x = qualify(y)');
var qualifyFunctionIndex = word_index(qualifyFunctionTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyFunctionTokens,
		qualifyFunctionIndex,
		context_after_clauses(['SELECT', 'FROM', 'WHERE'])
	),
	false,
	'QUALIFY-shaped function name must not be treated as a real clause'
);

var pivotConstructTokens = code_tokens('select * from t pivot (sum(x) for y in (1))');
var pivotConstructIndex = word_index(pivotConstructTokens, 'PIVOT');
assert.strictEqual(
	clauseContext.is_pivot_construct(
		pivotConstructTokens,
		pivotConstructIndex,
		context_after_clauses(['SELECT', 'FROM'])
	),
	true,
	'PIVOT after a table reference and before parens must be treated as a table construct'
);

var pivotFunctionTokens = code_tokens('select * from t where x = pivot(y)');
var pivotFunctionIndex = word_index(pivotFunctionTokens, 'PIVOT');
assert.strictEqual(
	clauseContext.is_pivot_construct(
		pivotFunctionTokens,
		pivotFunctionIndex,
		context_after_clauses(['SELECT', 'FROM', 'WHERE'])
	),
	false,
	'PIVOT-shaped WHERE function call must not be treated as a table construct'
);

var unpivotConstructTokens = code_tokens('select * from t unpivot (v for k in (c1,c2))');
var unpivotConstructIndex = word_index(unpivotConstructTokens, 'UNPIVOT');
assert.strictEqual(
	clauseContext.is_pivot_construct(
		unpivotConstructTokens,
		unpivotConstructIndex,
		context_after_clauses(['SELECT', 'FROM'])
	),
	true,
	'UNPIVOT after a table reference and before parens must follow table construct rules'
);

var mergeStatementTokens = code_tokens('merge into target t using source s on t.id=s.id when matched then update set v=s.v');
var mergeStatementIndex = word_index(mergeStatementTokens, 'MERGE');
assert.strictEqual(
	clauseContext.is_merge_statement(mergeStatementTokens, mergeStatementIndex, 0),
	true,
	'MERGE INTO at top-level statement start must be treated as a merge statement'
);

var mergeAliasTokens = code_tokens('select merge as c from t');
var mergeAliasIndex = word_index(mergeAliasTokens, 'MERGE');
assert.strictEqual(
	clauseContext.is_merge_statement(mergeAliasTokens, mergeAliasIndex, 0),
	false,
	'MERGE-shaped SELECT item must not be treated as a merge statement'
);

var compactMatchSql = 'select * from t match_recognize (partition by a order by b measures match_number() as mn)';
var compactMatchTokens = tokens(compactMatchSql);
var compactMatchIndex = word_index(compactMatchTokens, 'MATCH_RECOGNIZE');
var compactRange = clauseContext.match_recognize_range(compactMatchSql, compactMatchTokens, compactMatchIndex);
assert.strictEqual(
	compactRange.text,
	'match_recognize (partition by a order by b measures match_number() as mn)',
	'MATCH_RECOGNIZE compact token form must return the full opaque range'
);

var spacedMatchSql = 'select * from t match recognize (partition by a order by b measures match_number() as mn)';
var spacedMatchTokens = tokens(spacedMatchSql);
var spacedMatchIndex = word_index(spacedMatchTokens, 'MATCH');
var spacedRange = clauseContext.match_recognize_range(spacedMatchSql, spacedMatchTokens, spacedMatchIndex);
assert.strictEqual(
	spacedRange.text,
	'match recognize (partition by a order by b measures match_number() as mn)',
	'MATCH RECOGNIZE spaced token form must return the full opaque range'
);

var noisyTokens = tokens('select a -- keep\nfrom t');
var selectIndex = word_index(noisyTokens, 'SELECT');
var fromIndex = word_index(noisyTokens, 'FROM');
assert.strictEqual(
	clauseContext.next_code_token(noisyTokens, selectIndex).value,
	'a',
	'next_code_token must skip whitespace and comments'
);
assert.strictEqual(
	clauseContext.previous_code_token(noisyTokens, fromIndex).value,
	'a',
	'previous_code_token must skip whitespace and comments'
);

console.log('clause context tests passed');
