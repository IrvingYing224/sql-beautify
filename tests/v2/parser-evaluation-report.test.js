var fs = require('fs');
var path = require('path');
var assert = require('assert');
var reportPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'v2-parser-evaluation-report.md');
var adrPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'adr', '0001-v2-parser-backend.md');
var report = fs.readFileSync(reportPath, 'utf8');
var adr = fs.readFileSync(adrPath, 'utf8');
assert.ok(report.indexOf('dt-sql-parser@4.5.0') >= 0, 'exact candidate version');
assert.ok(report.indexOf('Required parse rate') >= 0, 'correctness evidence');
assert.ok(report.indexOf('Required case node-range rate') >= 0, 'source-range evidence');
assert.ok(report.indexOf('8x scale ratio') >= 0, 'scaling evidence');
assert.ok(report.indexOf('Maximum RSS KiB') >= 0, 'memory evidence');
assert.ok(report.indexOf('Node/platform') >= 0, 'environment evidence');
assert.ok(adr.indexOf('Status: Accepted') >= 0, 'accepted ADR');
assert.ok(adr.indexOf('project-owned lossless lexer') >= 0, 'owned lexer decision');
assert.ok(
    /Decision role: (runtime-grammar-backend|development-oracle|rejected)/.test(adr),
    'closed decision role'
);
console.log('v2 parser evaluation report tests passed');
