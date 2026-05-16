var sqlFormatter = require('./lib/sql-formatter');
var sqlDdlFormatter = require('./lib/sql-ddl-formatter');

function vkbeautify() {}

vkbeautify.prototype.sql = function(text, uppercase, comma_location, bracket_char, as_loc_cnt, case_when_then_wrap_length, advanced_options) {
    return sqlFormatter.format_sql(text, {
        uppercase: uppercase,
        comma_location: comma_location,
        bracket_char: bracket_char,
        as_loc_cnt: as_loc_cnt,
        case_when_then_wrap_length: case_when_then_wrap_length,
        dialect: advanced_options && advanced_options.dialect
    });
};

vkbeautify.prototype.sqlddl = function(text) {
    return sqlDdlFormatter.ddl(text);
};

vkbeautify.prototype.extractddl = function(text) {
    return sqlDdlFormatter.extractddl(text);
};

module.exports = new vkbeautify();
