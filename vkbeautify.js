var sqlFormatter = require('./lib/sql-formatter');
var sqlDdlFormatter = require('./lib/sql-ddl-formatter');
var sqlRenderOptions = require('./lib/sql-render-options');

function vkbeautify() {}

vkbeautify.prototype.sql = function(text, uppercase, comma_location, bracket_char, as_loc_cnt, case_when_then_wrap_length, advanced_options) {
    var options = sqlRenderOptions.normalize({
        uppercase: uppercase,
        comma_location: comma_location,
        bracket_char: bracket_char,
        as_loc_cnt: as_loc_cnt,
        case_when_then_wrap_length: case_when_then_wrap_length,
        dialect: advanced_options && advanced_options.dialect
    }, {
        dialect: !!(advanced_options && typeof advanced_options.dialect !== 'undefined')
    });

    return sqlFormatter.format_sql(text, options);
};

vkbeautify.prototype.sqlddl = function(text) {
    return sqlDdlFormatter.ddl(text);
};

vkbeautify.prototype.extractddl = function(text) {
    return sqlDdlFormatter.extractddl(text);
};

module.exports = new vkbeautify();
