function repeat_string(text, count) {
	if (count <= 0) {
		return '';
	}

	return new Array(count + 1).join(String(text || ''));
}

function repeat_space(count) {
	return repeat_string(' ', count);
}

function expand_tabs_for_width(text) {
	return String(text || '').replace(/\t/ig, "    ");
}

exports.repeat_string = repeat_string;
exports.repeat_space = repeat_space;
exports.expand_tabs_for_width = expand_tabs_for_width;
