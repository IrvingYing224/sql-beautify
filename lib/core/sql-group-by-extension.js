function is_word(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}

function is_clause_stop_word(token) {
	if (!is_word(token)) {
		return false;
	}
	return /^(SELECT|FROM|WHERE|HAVING|QUALIFY|ORDER|SORT|CLUSTER|DISTRIBUTE|LIMIT|UNION|INTERSECT|EXCEPT|JOIN|ON)$/i.exec(token.value) != null;
}

function has_group_by_clause_before(tokens, index) {
	for (var i = index - 1; i >= 0; i--) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == ';') {
			return false;
		}
		if (is_word(tokens[i], 'BY') && i > 0 && is_word(tokens[i - 1], 'GROUP')) {
			return true;
		}
		if (is_clause_stop_word(tokens[i])) {
			return false;
		}
	}
	return false;
}

function is_start(tokens, index) {
	if (!is_word(tokens[index], 'WITH')) {
		return false;
	}
	if (!has_group_by_clause_before(tokens, index)) {
		return false;
	}
	if (is_word(tokens[index + 1], 'CUBE') || is_word(tokens[index + 1], 'ROLLUP')) {
		return true;
	}
	return is_word(tokens[index + 1], 'GROUPING') && is_word(tokens[index + 2], 'SETS');
}

exports.is_start = is_start;
