function install_string_times() {
	if (typeof String.prototype.times != 'function') {
		String.prototype.times = function(n) {
			return (new Array(n + 1)).join(this);
		};
	}
}

function expand_tabs_for_width(text) {
	return String(text || '').replace(/\t/ig, "    ");
}

install_string_times();

exports.install_string_times = install_string_times;
exports.expand_tabs_for_width = expand_tabs_for_width;
