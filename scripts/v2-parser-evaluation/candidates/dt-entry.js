var HiveSQL = require('dt-sql-parser').HiveSQL;
module.exports = function create_hive_parser() {
    return new HiveSQL();
};
