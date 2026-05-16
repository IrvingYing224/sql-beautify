function escape_regex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function create_nonce(source, label) {
    var seed = 0;
    var nonce = '';
    do {
        nonce = 'SQLBEAUTIFY_' + label + '_' + seed + '_';
        seed += 1;
    } while (String(source || '').indexOf(nonce) >= 0);
    return nonce;
}

function create_context(source) {
    return {
        source: String(source || ''),
        stores: {},
        nonces: {},
        marker: function(label, index) {
            if (!this.nonces[label]) {
                this.nonces[label] = create_nonce(this.source, label);
            }
            return '{' + this.nonces[label] + index + '}';
        },
        marker_regex: function(label) {
            if (!this.nonces[label]) {
                this.nonces[label] = create_nonce(this.source, label);
            }
            return new RegExp('\\{' + escape_regex(this.nonces[label]) + '(\\d+)\\}', 'g');
        },
        store: function(label, value) {
            if (!this.stores[label]) {
                this.stores[label] = [];
            }
            var index = this.stores[label].length;
            this.stores[label].push(value);
            return this.marker(label, index);
        },
        restore: function(label, text) {
            var values = this.stores[label] || [];
            return String(text || '').replace(this.marker_regex(label), function(match, index) {
                return values[parseInt(index, 10)];
            });
        }
    };
}

exports.create_context = create_context;
exports.escape_regex = escape_regex;
