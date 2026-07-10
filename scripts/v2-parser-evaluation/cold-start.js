var started = process.hrtime.bigint();
var createHiveParser = require(process.argv[2]);
var parser = createHiveParser();
parser.validate('SELECT 1');
var elapsedMs = Number(process.hrtime.bigint() - started) / 1000000;
process.stdout.write(String(elapsedMs));
