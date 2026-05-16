var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var expected = fs.readFileSync(path.join(__dirname, '..', 'docs', 'technical', 'sql-support-matrix.md'), 'utf8');
var actual = childProcess.execFileSync(process.execPath, [
	path.join(__dirname, '..', 'scripts', 'generate-support-matrix.js')
], {
	encoding: 'utf8'
});

assert.strictEqual(
	actual,
	expected,
	'sql support matrix must be regenerated with scripts/generate-support-matrix.js --write after registry changes'
);

console.log('generated support matrix tests passed');
