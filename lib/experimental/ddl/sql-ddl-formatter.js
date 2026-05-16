var sqlDdlFormat = require('./sql-ddl-format');
var sqlExtractDdl = require('./sql-extract-ddl');

exports.ddl = sqlDdlFormat.ddl;
exports.extractddl = sqlExtractDdl.extractddl;
