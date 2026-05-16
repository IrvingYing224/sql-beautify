var sqlFormatter = require('./lib/core/sql-formatter');
var sqlDdlFormatter = require('./lib/experimental/ddl');
var sqlRenderOptions = require('./lib/adapters/sql-render-options');

function vkbeautify() {}

vkbeautify.prototype.sql = function(text, uppercase, comma_location, bracket_char, as_loc_cnt, case_when_then_wrap_length, advanced_options) {
    var options = sqlRenderOptions.normalize({
        keywordCase: uppercase === false ? 'lower' : 'upper',
        commaStyle: comma_location === true ? 'trailing' : 'leading',
        indentStyle: bracket_char === true ? 'space' : 'tab',
        maxAlignWidth: as_loc_cnt,
        caseWhenThenWrapLength: case_when_then_wrap_length,
        dialect: advanced_options && advanced_options.dialect,
        unsupportedSyntaxPolicy: advanced_options && advanced_options.unsupportedSyntaxPolicy
    }, {
        keywordCase: true,
        commaStyle: true,
        indentStyle: true,
        maxAlignWidth: true,
        caseWhenThenWrapLength: true,
        dialect: !!(advanced_options && typeof advanced_options.dialect !== 'undefined'),
        unsupportedSyntaxPolicy: !!(advanced_options && typeof advanced_options.unsupportedSyntaxPolicy !== 'undefined')
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
