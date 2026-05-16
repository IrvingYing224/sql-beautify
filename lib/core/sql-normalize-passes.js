var sqlTokenizer = require('./sql-tokenizer');

function normalize_set_payload(payload) {
	var tokens = sqlTokenizer.tokenize(payload.replace(/^\s+/ig, '').replace(/\s+$/ig, ''));
	var text = '';

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'whitespace') {
			if (text != '' && !/\s$/.exec(text)) {
				text += ' ';
			}
			continue;
		}

		if (tokens[i].type == 'operator' && tokens[i].value == '=') {
			text = text.replace(/\s+$/ig, '') + ' = ';
			continue;
		}

		text += tokens[i].value;
	}

	text = text.replace(/\s+$/ig, '');
	return text;
}

function protect_set_payloads(str, context) {
	var tokens = sqlTokenizer.tokenize(str);
	var text = '';
	var at_statement_start = true;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'word' && /^SET$/i.exec(tokens[i].value) && at_statement_start) {
			var payload_text = '';
			text += tokens[i].value;
			i += 1;

			while (i < tokens.length
				&& !(tokens[i].type == 'punctuation' && tokens[i].value == ';')
				&& tokens[i].type != 'newline') {
				payload_text += tokens[i].value;
				i += 1;
			}

			text += context.store('set_payload', normalize_set_payload(payload_text));

			if (i < tokens.length) {
				text += tokens[i].value;
				if (tokens[i].type == 'punctuation' && tokens[i].value == ';'
					&& i + 1 < tokens.length
					&& tokens[i + 1].type == 'newline') {
					text += context.store('set_newline', '\n');
					i += 1;
				}
				at_statement_start = tokens[i].type == 'punctuation' && tokens[i].value == ';'
					|| tokens[i].type == 'newline';
			}
			continue;
		}

		text += tokens[i].value;

		if (tokens[i].type == 'punctuation' && tokens[i].value == ';') {
			at_statement_start = true;
		} else if (tokens[i].type == 'newline') {
			at_statement_start = true;
		} else if (tokens[i].type != 'whitespace') {
			at_statement_start = false;
		}
	}

	return {
		text: text
	};
}

function restore_set_payloads(str, context) {
	return context.restore('set_newline', context.restore('set_payload', str));
}

exports.normalize_set_payload = normalize_set_payload;
exports.protect_set_payloads = protect_set_payloads;
exports.restore_set_payloads = restore_set_payloads;
