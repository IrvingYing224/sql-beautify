var started = process.hrtime.bigint();
var bundle = require(process.argv[2]);
var createHiveParser = bundle.default || bundle.create_hive_parser || bundle;
if (typeof createHiveParser != 'function') {
    throw new TypeError('Hive bundle must export a parser factory');
}
var parser = createHiveParser();
var errors = parser.validate('SELECT 1');
if (!Array.isArray(errors) || errors.length > 0) {
    throw new Error('Hive bundle failed SELECT 1 validation');
}
var elapsedMs = Number(process.hrtime.bigint() - started) / 1000000;
process.stdout.write(String(elapsedMs));
