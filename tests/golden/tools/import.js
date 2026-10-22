#!/usr/bin/env node
'use strict';

// P1 one-off (deleted with the seeds in P2): builds tests/golden/cases from the old fixtures, the
// public corpus, the seed files, an option matrix and the explicit cases listed in plan §6 P1.
// Afterwards `node tests/golden/run.js --update` writes outputs and snapshot.json.

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..', '..');
var golden = path.join(__dirname, '..');
var casesDir = path.join(golden, 'cases');
var core = path.join(root, '.tmp', 'v2-core');
var definitions = require(path.join(core, 'core', 'config', 'definitions.js'));
var environment = require(path.join(core, 'core', 'renderer', 'environment.js'));

var HEADER = '-- golden: ';
var cases = [];
var seen = new Set();

function slug(text, limit) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, limit)
        .replace(/-+$/g, '') || 'case';
}

function hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

// Drops fields equal to the adapter default so equivalent calls deduplicate.
function canonical(spec, source) {
    var result = {};
    var op = spec.op || 'formatSql';
    if (op !== 'formatSql') {
        result.op = op;
    }
    var options = {};
    Object.keys(spec.options || {}).sort().forEach(function(key) {
        var definition = definitions.FORMAT_OPTION_DEFINITIONS[key];
        var value = spec.options[key];
        if (!(op === 'formatSql' && definition !== undefined && definition.default === value)) {
            options[key] = value;
        }
    });
    if (Object.keys(options).length > 0) {
        result.options = options;
    }
    if (spec.mode !== undefined && spec.mode !== 'document') {
        result.mode = spec.mode;
    }
    if (spec.newline !== undefined && spec.newline !== environment.inferRenderNewline(source, '\n')) {
        result.newline = spec.newline;
    }
    if (spec.tabSize !== undefined && spec.tabSize !== environment.DEFAULT_RENDER_TAB_SIZE) {
        result.tabSize = spec.tabSize;
    }
    if (spec.startColumn !== undefined && spec.startColumn !== 0) {
        result.startColumn = spec.startColumn;
    }
    return result;
}

function add(group, name, source, spec, variants) {
    var header = canonical(spec || {}, source);
    var key = JSON.stringify([header, variants || null, source]);
    if (seen.has(key)) {
        return;
    }
    seen.add(key);
    if (variants) {
        header.variants = variants;
    }
    cases.push({ file: group + '/' + name, header: header, source: source });
}

function addSeed(group, source, spec) {
    add(group, slug(source, 40) + '-' + hash(JSON.stringify([spec, source])), source, spec);
}

// 1. Old fixtures with expected outputs or outcomes.
var fixtures = path.join(root, 'tests', 'fixtures');
[
    ['cst', 'v2-cst-cases.js'],
    ['layout', 'v2-layout-cases.js'],
    ['sql-corpus', 'v2-sql-corpus-cases.js'],
    ['wave3-corpus', 'v2-wave3-corpus-cases.js'],
    ['hive-query', 'v2-wave3c-hive-query-cases.js'],
    ['expression', 'v2-wave3d-expression-cases.js'],
].forEach(function(entry) {
    require(path.join(fixtures, entry[1])).forEach(function(value) {
        var options = value.options || (value.dialect ? { dialect: value.dialect } : {});
        add('fixtures/' + entry[0], slug(value.id, 60), value.source, { options: options, mode: value.mode });
    });
});
var ddlFixtures = require(path.join(fixtures, 'v2-wave4-ddl.js'));
ddlFixtures.ddl.forEach(function(value) {
    add('fixtures/ddl', slug(value.id, 60), value.source, { op: 'formatHiveDdl' });
});
ddlFixtures.extract.forEach(function(value) {
    add('fixtures/extract', slug(value.id, 60), value.source, { op: 'extractDdl' });
});

// 2. Public production corpus, byte-exact (BOM and CRLF included).
var corpus = path.join(fixtures, 'production-corpus', 'public');
require(path.join(corpus, 'manifest.json')).cases.forEach(function(value) {
    add('corpus', slug(value.id, 60), fs.readFileSync(path.join(corpus, value.file), 'utf8'),
        { op: value.operation, options: value.options });
});

// 3. Explicit cases (plan §6 P1, Appendix C repros).
function nestedCase(depth) {
    var expression = '0';
    for (var level = depth; level >= 1; level--) {
        expression = 'case when a' + level + ' = 1 then ' + expression + ' else 0 end';
    }
    return 'select ' + expression + ' as x from t';
}
function wideSelect(columns) {
    var names = [];
    for (var index = 0; index < columns; index++) {
        names.push('c' + index);
    }
    return 'select ' + names.join(',') + ' from t';
}
var TABS = { t2: { tabSize: 2 }, t4: { tabSize: 4 }, t8: { tabSize: 8 } };
var DDL_ENV = {
    plain: {},
    col4: { startColumn: 4 },
    crlf: { newline: '\r\n' },
    t2: { tabSize: 2 },
    t8: { tabSize: 8 },
};
[
    ['known/k01-partial-trailing-comments', 'select a, b, -- c\nc, d from t'],
    ['known/k02-commented-column', 'select a,\n -- b,\n c from t'],
    ['known/k03-indented-statements', '    select a from t;\n    select b from u;'],
    ['known/k04-comment-in-predicate', 'select a from t where a = /* x */ 1 and b = 2'],
    ['known/k04-commented-condition', 'select a from t\nwhere a = 1\n-- and b = 2\nand c = 3'],
    ['known/k05-case-in-function', 'select sum(case when a = 1 then b else 0 end) as s, c from t group by c'],
    ['known/k06-then-string-else', "select case when a = 1 then 'x'else 3 end as c from t"],
    ['known/k07-template-desc', 'select a from t order by ${p}desc'],
    ['known/k07-template-and', 'select a from t where x=${v}and y=1'],
    ['known/k07-adjacent-templates', 'select ${a}${b} from t'],
    ['known/k07-spaced-templates', 'select ${a} ${b} from t'],
    ['known/k09-row-star', 'SELECT (t.*, a) AS x FROM t t'],
    ['known/k10-div', 'select a div 2 from t'],
    ['known/k10-nulls-last', 'select a from t order by a desc nulls last'],
    ['known/k10-limit-comma', 'select a from t limit 5, 10'],
    ['known/k10-limit-offset', 'select a from t limit 10 offset 5'],
    ['known/k10-interval', 'select a + interval 2 hour from t'],
    ['known/k10-with-rollup', 'select a, count(1) from t group by a with rollup'],
    ['known/k10-insert-columns', 'insert into table t (c1, c2) select a, b from s'],
    ['known/k10-templated-names', 'select a from db_${env}.tbl_${dt}'],
    ['known/k28-template-after-identifier', 'select tbl_${dt}.a from db_${env}.tbl_${dt} where p_${k}=1'],
    ['known/k29-shift-operators', 'select a >> 1, b<<2 from t'],
    ['known/k30-comment-before-paren', 'select a from t where (b and c /* c */)'],
    ['known/k11-use', 'use db;'],
    ['known/k11-msck', 'msck repair table t;'],
    ['known/k11-analyze', 'analyze table t compute statistics;'],
    ['known/k11-show', 'show partitions t;'],
    ['known/k11-describe', 'describe formatted t;'],
    ['known/k11-load-data', "load data local inpath '/tmp/x.csv' into table t;"],
    ['known/k12-ctas', 'create table t as select a, b from s where c = 1'],
    ['known/k13-null-true-false', 'select case when a is null then null when b then true else false end from t'],
    ['known/k14-hint', 'select /*+ MAPJOIN(b) */ a.x, b.y from a join b on a.id = b.id'],
    ['known/k15-comment-in-args', 'select f(/* arg */ x) from t'],
    ['known/k17-trailing-spaces', 'select a\nfrom t   '],
    ['template/lhs-operator', 'select a from t where ${lhs}=1'],
    ['template/rhs-operator', 'select a from t where ds=${hiveconf:run_date}'],
    ['template/d13-list', 'select ${hivevar:left},${hivevar:right} from t'],
    ['template/outer-space-probe', 'select ${v} + 1 from t'],
    ['literal/long', 'select 0L from t'],
    ['literal/tinyint', 'select 10Y from t'],
    ['literal/smallint', 'select 5S from t'],
    ['literal/double', 'select 1.0D from t'],
    ['literal/decimal', 'select 1.0BD from t'],
    ['literal/alias-l', 'select 0 L from t'],
    ['payload/add-jar', 'add jar /tmp/current.jar;'],
    ['payload/add-jar-dash', 'add jar /tmp/my-udf.jar;'],
    ['payload/add-jar-hdfs', 'add jar hdfs:///user/Lib/UDF.jar;'],
    ['payload/add-jars-multiple', 'add jars /tmp/a.jar /tmp/b-c.jar;'],
    ['payload/add-file', 'add file hdfs:///tmp/Dict.txt;'],
    ['payload/list-jars', 'list jars;'],
    ['payload/delete-jar', 'delete jar /tmp/current.jar;'],
    ['payload/dfs', 'dfs -ls /user/hive;'],
    ['payload/shell', '!ls -la /tmp;'],
    ['payload/source', 'source /tmp/init-Script.sql;'],
    ['payload/set-path', 'set hive.exec.scratchdir=/tmp/Hive-Scratch;'],
    ['payload/reset', 'reset;'],
    ['payload/script', "add jar /tmp/my-udf.jar;\ncreate temporary function f as 'com.x.F';\nselect f(a) from t;"],
    ['ctas/defined-name', 'create table defined as select 1'],
    ['ctas/qualified-defined-name', 'create table db.defined as select 1'],
    ['ctas/stored-name', 'create table stored as select 1'],
    ['ctas/malformed-shell', 'create table t row format delimited null defined as (select 1)'],
    ['env/crlf', 'select a,b\r\nfrom t\r\nwhere x=1\r\n'],
    ['env/cr', 'select a,b\rfrom t\r'],
    ['env/bom', '﻿select a from t'],
    ['env/lf-source-crlf-newline', 'select a,b\nfrom t\n', { newline: '\r\n' }],
    ['env/fragment-select', 'select a,b from t where x=1', { mode: 'fragment' }],
    ['env/fragment-where', 'where x=1 and y=2', { mode: 'fragment' }],
    ['env/statement', 'select a,b from t where x=1', { mode: 'statement' }],
    ['env/tab-comment-alignment', 'select\ta,\t-- first\n\tbbbb,\t-- second\n\tc\t-- third\nfrom t', {}, TABS],
    ['env/tab-indent-style', 'select a, case when b = 1 then 2 else 3 end as c from t',
        { options: { indentStyle: 'tab' } }, TABS],
    ['ddl-env/create-table', "create table db.t (\n  id bigint comment 'id',\n  name string\n) stored as orc",
        { op: 'formatHiveDdl' }, DDL_ENV],
    ['ddl-env/create-table-tab-indent', '\tcreate table t (a int, bb string)', { op: 'formatHiveDdl' }, DDL_ENV],
    ['ddl-env/extract', 'select a, b as bb, cast(c as int) as c from t', { op: 'extractDdl' }, DDL_ENV],
    ['ddl-env/extract-tab-indent', '\tselect a, bb from t', { op: 'extractDdl' }, DDL_ENV],
    ['resource/nested-case-40', nestedCase(40)],
    ['resource/nested-case-60', nestedCase(60)],
    ['resource/nested-case-80', nestedCase(80)],
    ['resource/extract-12000-columns', wideSelect(12000), { op: 'extractDdl' }],
    ['resource/extract-20000-columns', wideSelect(20000), { op: 'extractDdl' }],
].forEach(function(entry) {
    var file = entry[0].split('/');
    add('explicit/' + file[0], file[1], entry[1], entry[2], entry[3]);
});

// 4. Option matrix: 8 representative inputs x 32 option combinations.
var seeds = require(path.join(golden, 'seeds', 'review-2026-10.json')).cases;
var etl = seeds.filter(function(value) { return value.origin === 'review-probe:hive:etl-full'; })[0].source;
var matrixInputs = [
    ['etl-script', etl],
    ['cte-window', 'with q as (select a, b, row_number() over (partition by a order by b desc) as rn from t) select a, b from q where rn = 1'],
    ['case-heavy', "select id, case when score >= 90 then 'A' when score >= 80 then 'B' else 'C' end as grade, case status when 1 then 'on' else 'off' end as st from s"],
    ['join-subquery', "select a.id, b.name, c.total from a left join b on a.id = b.id and b.dt = a.dt join (select id, sum(x) as total from c group by id) c on c.id = a.id where a.dt = '2024-01-01'"],
    ['insert-partition', "insert overwrite table dw.t partition (dt='2024-01-01') select a, b, count(1) as cnt from src where c > 0 group by a, b having count(1) > 1 order by cnt desc limit 10"],
    ['comment-alignment', 'select\n  a, -- first\n  bbbbbbbb, -- second\n  c -- third\nfrom t -- table\nwhere x = 1 /* cond */'],
    ['union-lateral-view', 'select x.a, e.v from t x lateral view explode(x.arr) e as v union all select a, b from t2'],
    ['wide-expressions', "select aaaaaaaaaaaaaaaaaaaa as x, b as yyyyyyyyyyyyyyyyyyyy, concat_ws(',', c, d, e, f, g) as z, coalesce(h, 0) + nvl(i, 0) * 2 as w from t where a in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)"],
];
var matrix = {};
['upper', 'lower'].forEach(function(keywordCase) {
    ['leading', 'trailing'].forEach(function(commaStyle) {
        ['space', 'tab'].forEach(function(indentStyle) {
            ['expanded', 'compactShort'].forEach(function(caseLayout) {
                [['wide', {}], ['narrow', { maxAlignWidth: 20, caseWhenThenWrapLength: 10 }]].forEach(function(width) {
                    var name = [keywordCase, commaStyle, indentStyle, caseLayout, width[0]].join('-').toLowerCase();
                    matrix[name] = {
                        options: Object.assign({
                            keywordCase: keywordCase,
                            commaStyle: commaStyle,
                            indentStyle: indentStyle,
                            caseLayout: caseLayout,
                        }, width[1]),
                    };
                });
            });
        });
    });
});
matrixInputs.forEach(function(entry) {
    add('matrix', entry[0], entry[1], {}, matrix);
});

// 5. Seeds: review probes, recaptured asserted calls (with environment), parser-test inputs and
// the old tests' remaining calls whose output they check only by property.
seeds.forEach(function(value) {
    var origin = value.origin.split(':');
    if (origin[0] === 'review-probe') {
        add('probe/' + slug(origin[1], 40), slug(origin.slice(2).join('-'), 60), value.source,
            { op: value.op, options: value.options });
    }
});
var recaptured = require(path.join(golden, 'seeds', 'recapture-2026-10.json')).cases;
var recapturedKeys = new Set();
recaptured.forEach(function(value) {
    recapturedKeys.add(JSON.stringify([canonical({ op: value.op, options: value.options }, value.source),
        value.source]));
    addSeed('recapture/' + value.origin.split(':')[1], value.source, value);
});
seeds.forEach(function(value) {
    var origin = value.origin.split(':');
    var spec = { op: value.op, options: value.options };
    if (origin[0] === 'harvest' &&
        !recapturedKeys.has(JSON.stringify([canonical(spec, value.source), value.source]))) {
        addSeed('harvest/' + origin[1], value.source, spec);
    }
});
seeds.forEach(function(value) {
    var origin = value.origin.split(':');
    if (origin[0] === 'parse-harvest') {
        addSeed('parse/' + origin[1], value.source, { op: value.op, options: value.options });
    }
});
// Last, so an old-test call that is already a case elsewhere keeps that case.
require(path.join(golden, 'seeds', 'called-2026-10.json')).cases.forEach(function(value) {
    addSeed('called/' + value.origin.split(':')[1], value.source, value);
});

fs.rmSync(casesDir, { recursive: true, force: true });
var files = new Set();
cases.forEach(function(value) {
    if (files.has(value.file)) {
        throw new Error('duplicate case name ' + value.file);
    }
    files.add(value.file);
    var target = path.join(casesDir, value.file + '.in.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    var header = Object.keys(value.header).length === 0 ? '' : HEADER + JSON.stringify(value.header) + '\n';
    fs.writeFileSync(target, header + value.source);
});
var groups = {};
cases.forEach(function(value) {
    var group = value.file.split('/')[0];
    groups[group] = (groups[group] || 0) + 1;
});
console.log(cases.length + ' case files', groups);
