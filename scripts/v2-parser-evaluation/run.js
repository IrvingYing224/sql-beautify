var fs = require('fs');
var path = require('path');
var cases = require('../../tests/fixtures/v2-parser-evaluation-cases');
var evaluator = require('./evaluator');
var candidate = require('./candidates/dt-sql-parser');
var probe = require('./probe-dt-sql-parser').probe_dt_sql_parser(candidate);
var renderer = require('./report');
var report = evaluator.evaluate_candidate(candidate, cases, probe);
var technicalRoot = path.join(process.cwd(), 'docs', 'technical');
var adrRoot = path.join(technicalRoot, 'adr');
fs.mkdirSync(adrRoot, { recursive: true });
fs.writeFileSync(path.join(technicalRoot, 'v2-parser-evaluation-report.md'), renderer.render_report(report));
fs.writeFileSync(path.join(adrRoot, '0001-v2-parser-backend.md'), renderer.render_adr(report));
console.log(JSON.stringify({
    candidate: report.candidate,
    decision: report.decision,
    summary: report.summary,
    probe: report.probe,
}, null, 2));
