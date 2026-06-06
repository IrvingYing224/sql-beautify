function build_separator_lookup(nodes) {
	var lookup = {};
	var separators = nodes && nodes.separators ? nodes.separators : [];

	for (var i = 0; i < separators.length; i++) {
		lookup[separators[i].id] = separators[i];
	}

	return lookup;
}

function build_move_state(nodes, mutations) {
	var separatorLookup = build_separator_lookup(nodes);
	var removedTokenIds = {};
	var prefixesByLine = {};
	var movedCommentsByLine = {};
	var movedCommentSourceLines = {};

	for (var i = 0; i < mutations.separatorMoves.length; i++) {
		var move = mutations.separatorMoves[i];
		var separator = separatorLookup[move.separatorId];
		var target = move.target || {};

		if (!separator) {
			continue;
		}

		removedTokenIds[String(separator.tokenId)] = true;

		if (target.placement == 'linePrefix') {
			var lineKey = String(target.lineIndex);
			if (!prefixesByLine[lineKey]) {
				prefixesByLine[lineKey] = [];
			}
			prefixesByLine[lineKey].push({
				text: target.text || ',',
				indentText: target.indentText
			});
		}
	}

	for (var tokenOmissionKey in mutations.tokenOmissions) {
		if (!Object.prototype.hasOwnProperty.call(mutations.tokenOmissions, tokenOmissionKey)) {
			continue;
		}
		var tokenOmission = mutations.tokenOmissions[tokenOmissionKey];
		removedTokenIds[String(tokenOmission.tokenId)] = true;
	}

	for (var key in mutations.lineCommentMoves) {
		if (!Object.prototype.hasOwnProperty.call(mutations.lineCommentMoves, key)) {
			continue;
		}
		var commentMove = mutations.lineCommentMoves[key];
		var sourceKey = String(commentMove.fromLineIndex);
		var targetKey = String(commentMove.toLineIndex);
		movedCommentSourceLines[sourceKey] = true;
		if (!movedCommentsByLine[targetKey]) {
			movedCommentsByLine[targetKey] = [];
		}
		movedCommentsByLine[targetKey].push(commentMove);
	}

	return {
		removedTokenIds: removedTokenIds,
		prefixesByLine: prefixesByLine,
		movedCommentsByLine: movedCommentsByLine,
		movedCommentSourceLines: movedCommentSourceLines
	};
}

exports.build_move_state = build_move_state;
