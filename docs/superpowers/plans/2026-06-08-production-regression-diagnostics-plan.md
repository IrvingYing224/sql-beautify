# Production Regression And Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-oriented regression layer with public/private SQL corpora, strict public golden snapshots, p95-style performance reporting, and actionable structured unsupported-syntax diagnostics.

**Architecture:** Keep the structured formatter pipeline unchanged. Add test-only corpus helpers and committed public fixtures under `tests/fixtures/production-corpus/`, add a non-packaged private corpus runner controlled by `SQL_BEAUTIFY_CORPUS_DIR`, add wide-gated performance reporting, and centralize unsupported diagnostic shaping in `lib/core/sql-diagnostics.js` while preserving the public `format_sql()` / `format_sql_detailed()` API.

**Tech Stack:** CommonJS JavaScript, Node.js built-in `assert` / `fs` / `path`, existing formatter core under `lib/core/`, VS Code adapter tests with the existing mock harness, existing CLI verification through `npm run test:verify`, VSIX smoke through local `@vscode/vsce`.

---

## File Structure

Create:

- `tests/fixtures/production-corpus/public/hive-cte-window-comments.sql`
- `tests/fixtures/production-corpus/public/hive-template-variables.sql`
- `tests/fixtures/production-corpus/public/postgres-json-dollar.sql`
- `tests/fixtures/production-corpus/public/postgres-json-dollar.options.json`
- `tests/fixtures/production-corpus/public/unsupported-match-recognize.sql`
- `tests/fixtures/production-corpus/public/unsupported-match-recognize.options.json`
- `tests/fixtures/production-corpus/public/unsupported-pivot-qualify-safety.sql`
- `tests/fixtures/production-corpus/public/unsupported-pivot-qualify-safety.options.json`
- `tests/fixtures/production-corpus/snapshots/*.formatted.sql`
- `tests/helpers/production-corpus.js`
- `tests/helpers/performance-report.js`
- `tests/production-corpus-golden.test.js`
- `tests/production-corpus-private.test.js`
- `tests/production-performance-budget.test.js`
- `tests/diagnostics-explainability.test.js`
- `lib/core/sql-diagnostics.js`

Modify:

- `lib/core/sql-unsupported-policy.js`
- `lib/core/sql-syntax-risk-detector.js`
- `lib/core/sql-clause-splitter.js`
- `lib/core/sql-format-context.js`
- `lib/core/sql-formatter.js`
- `lib/adapters/formatter-diagnostics.js`
- `tests/unsupported-safety.test.js`
- `tests/extension-contribution.test.js`
- `tests/module-boundary.test.js`
- `package.json`
- `docs/technical/sql-formatter-architecture.md`

Do not modify:

- `README.md`
- root `lib/*.js` compatibility shims
- `lib/experimental/ddl/`
- `.github/workflows/*`
- generated `.vsix` artifacts

Private corpus is intentionally not added to `npm run test:verify`.

---

### Task 1: Public Production Corpus And Golden Snapshots

**Files:**
- Create: `tests/fixtures/production-corpus/public/*.sql`
- Create: `tests/fixtures/production-corpus/public/*.options.json`
- Create: `tests/fixtures/production-corpus/snapshots/*.formatted.sql`
- Create: `tests/helpers/production-corpus.js`
- Create: `tests/production-corpus-golden.test.js`
- Modify: `package.json`

- [ ] **Step 1: Confirm baseline and read the spec**

Run:

```bash
git status --short --branch
sed -n '1,360p' docs/superpowers/specs/2026-06-08-production-regression-diagnostics-design.md
```

Expected: branch is `codex/structured-formatter-pipeline-plan`, no tracked local changes, and the spec describes public corpus, private corpus, golden snapshots, performance budget, and structured diagnostics.

- [ ] **Step 2: Run baseline checks**

Run:

```bash
node tests/tokenizer-profile.test.js
node tests/performance-smoke.test.js
node tests/unsupported-safety.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass before edits. If any command fails on the untouched baseline, stop and report the failure.

- [ ] **Step 3: Create the public corpus SQL fixtures**

Create `tests/fixtures/production-corpus/public/hive-cte-window-comments.sql`:

```sql
with source_orders as (
select
o.user_id,
o.order_id,
case when o.city_id in (
1001, -- city one
1002 -- city two
) then concat_ws(',', o.city_name, o.region_name)
else 'unknown'
end as city_label,
row_number() over(partition by o.user_id order by o.pay_time desc,o.order_id desc) as rn
from dwd_order_detail o
left join dim_user_profile u
on -- user join
o.user_id = u.user_id
and u.ds='${bizdate}'
where o.ds='${bizdate}'
and o.status in (1,2,3)
)
select user_id,order_id,city_label
from source_orders
where rn=1;
```

Create `tests/fixtures/production-corpus/public/hive-template-variables.sql`:

```sql
select
a.user_id,
'${bizdate}' as bizdate,
'${env}' as run_env,
case when a.event_name='select from where' then 1 else 0 end as has_sql_text,
concat_ws('|', a.app_id, a.channel, '${bizdate}') as compound_key -- output key
from ods_event_log a
where a.ds='${bizdate}'
and a.hour between '${start_hour}' and '${end_hour}'
and a.extra_json like '%case when%'
and a.comment_text <> '-- not a real comment';
```

Create `tests/fixtures/production-corpus/public/postgres-json-dollar.sql`:

```sql
select
u.id,
payload->>'order_id' as order_id,
payload ? 'coupon' as has_coupon,
$$CASE WHEN -- keep raw text$$ as raw_sql_text
from public.events u
where payload->>'status' = 'paid'
and u.created_at >= now() - interval '1 day';
```

Create `tests/fixtures/production-corpus/public/unsupported-match-recognize.sql`:

```sql
select *
from event_stream
match_recognize (partition by user_id order by event_time measures match_number() as match_id one row per match pattern (A B+) define A as event_name='view', B as event_name='pay')
where ds='2026-06-08';
```

Create `tests/fixtures/production-corpus/public/unsupported-pivot-qualify-safety.sql`:

```sql
select *
from sales_source
pivot (sum(amount) for quarter in ('Q1','Q2')) p
where pivot = 'safe_name'
and qualify(pivot) = 1;

select qualify as c, pivot as p
from keyword_named_columns
where pivot(p) = 1;
```

- [ ] **Step 4: Create per-case options**

Create `tests/fixtures/production-corpus/public/postgres-json-dollar.options.json`:

```json
{
	"dialect": "postgres"
}
```

Create `tests/fixtures/production-corpus/public/unsupported-match-recognize.options.json`:

```json
{
	"dialect": "generic",
	"unsupportedSyntaxPolicy": "warn"
}
```

Create `tests/fixtures/production-corpus/public/unsupported-pivot-qualify-safety.options.json`:

```json
{
	"dialect": "generic",
	"unsupportedSyntaxPolicy": "warn"
}
```

- [ ] **Step 5: Add the production corpus helper**

Create `tests/helpers/production-corpus.js`:

```js
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var corpusRoot = path.join(__dirname, '..', 'fixtures', 'production-corpus');
var publicRoot = path.join(corpusRoot, 'public');
var snapshotRoot = path.join(corpusRoot, 'snapshots');

var DEFAULT_OPTIONS = {
	keywordCase: 'upper',
	commaStyle: 'leading',
	indentStyle: 'space',
	maxAlignWidth: 150,
	caseWhenThenWrapLength: 80,
	dialect: 'hive',
	unsupportedSyntaxPolicy: 'preserve'
};

function normalize_slashes(value) {
	return String(value || '').replace(/\\/g, '/');
}

function ensure_dir(dir) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function read_text(filePath) {
	return fs.readFileSync(filePath, 'utf8').replace(/\r\n|\r/g, '\n');
}

function read_options(filePath) {
	if (!fs.existsSync(filePath)) {
		return {};
	}
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		throw new Error('Invalid corpus options JSON: ' + filePath + ': ' + error.message);
	}
}

function list_sql_files(root) {
	var output = [];
	if (!root || !fs.existsSync(root)) {
		return output;
	}

	fs.readdirSync(root).sort().forEach(function(entry) {
		var fullPath = path.join(root, entry);
		var stat = fs.statSync(fullPath);
		if (stat.isDirectory()) {
			output = output.concat(list_sql_files(fullPath));
			return;
		}
		if (/\.sql$/i.test(entry)) {
			output.push(fullPath);
		}
	});

	return output;
}

function snapshot_name_for(relativePath) {
	return normalize_slashes(relativePath).replace(/\//g, '__').replace(/\.sql$/i, '.formatted.sql');
}

function build_case(root, sqlPath, hasSnapshot) {
	var relativePath = normalize_slashes(path.relative(root, sqlPath));
	var optionsPath = sqlPath.replace(/\.sql$/i, '.options.json');
	var options = Object.assign({}, DEFAULT_OPTIONS, read_options(optionsPath));
	var testCase = {
		name: relativePath.replace(/\.sql$/i, ''),
		sqlPath: sqlPath,
		relativePath: relativePath,
		optionsPath: fs.existsSync(optionsPath) ? optionsPath : null,
		sql: read_text(sqlPath),
		options: options
	};

	if (hasSnapshot) {
		testCase.snapshotPath = path.join(snapshotRoot, snapshot_name_for(relativePath));
	}

	return testCase;
}

function load_public_cases() {
	return list_sql_files(publicRoot).map(function(sqlPath) {
		return build_case(publicRoot, sqlPath, true);
	});
}

function load_private_cases(root) {
	return list_sql_files(root).map(function(sqlPath) {
		return build_case(root, sqlPath, false);
	});
}

function format_case(sqlFormatter, testCase) {
	if (typeof sqlFormatter.format_sql_detailed == 'function') {
		return sqlFormatter.format_sql_detailed(testCase.sql, testCase.options);
	}

	return {
		text: sqlFormatter.format_sql(testCase.sql, testCase.options),
		diagnostics: []
	};
}

function read_snapshot(testCase) {
	if (!testCase.snapshotPath || !fs.existsSync(testCase.snapshotPath)) {
		return null;
	}
	return read_text(testCase.snapshotPath);
}

function write_snapshot(testCase, text) {
	ensure_dir(path.dirname(testCase.snapshotPath));
	fs.writeFileSync(testCase.snapshotPath, String(text || '').replace(/\r\n|\r/g, '\n'));
}

function assert_diagnostics_shape(diagnostics, caseName) {
	assert.ok(Array.isArray(diagnostics), caseName + ' diagnostics must be an array');
	diagnostics.forEach(function(item, index) {
		assert.ok(item.level, caseName + ' diagnostic ' + index + ' must include level');
		assert.ok(item.code, caseName + ' diagnostic ' + index + ' must include code');
		assert.ok(item.message, caseName + ' diagnostic ' + index + ' must include message');
		if (item.unsupportedSegments) {
			assert.ok(Array.isArray(item.unsupportedSegments), caseName + ' unsupportedSegments must be an array');
		}
	});
}

function assert_formatted_contract(sqlFormatter, testCase, result) {
	assert.strictEqual(typeof result.text, 'string', testCase.name + ' formatter result text must be a string');
	assert.ok(/\n$/.test(result.text), testCase.name + ' formatted output must end with one newline');
	assert_diagnostics_shape(result.diagnostics, testCase.name);

	var idempotentCase = Object.assign({}, testCase, { sql: result.text });
	var second = format_case(sqlFormatter, idempotentCase);
	assert.strictEqual(second.text, result.text, testCase.name + ' formatted output must be idempotent');
}

exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
exports.publicRoot = publicRoot;
exports.snapshotRoot = snapshotRoot;
exports.load_public_cases = load_public_cases;
exports.load_private_cases = load_private_cases;
exports.format_case = format_case;
exports.read_snapshot = read_snapshot;
exports.write_snapshot = write_snapshot;
exports.assert_diagnostics_shape = assert_diagnostics_shape;
exports.assert_formatted_contract = assert_formatted_contract;
```

- [ ] **Step 6: Add the golden snapshot test**

Create `tests/production-corpus-golden.test.js`:

```js
var assert = require('assert');
var path = require('path');
var sqlFormatter = require('../lib/sql-formatter');
var corpus = require('./helpers/production-corpus');

var updateSnapshots = process.env.SQL_BEAUTIFY_UPDATE_SNAPSHOTS == '1';
var cases = corpus.load_public_cases();

assert.ok(cases.length >= 5, 'production corpus must include at least five public SQL cases');

cases.forEach(function(testCase) {
	var result = corpus.format_case(sqlFormatter, testCase);
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);

	if (updateSnapshots) {
		corpus.write_snapshot(testCase, result.text);
		return;
	}

	var expected = corpus.read_snapshot(testCase);
	assert.notStrictEqual(
		expected,
		null,
		[
			'Missing production corpus snapshot for ' + testCase.name,
			'Expected snapshot: ' + path.relative(process.cwd(), testCase.snapshotPath),
			'Run: SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1 node tests/production-corpus-golden.test.js'
		].join('\n')
	);

	assert.strictEqual(
		result.text,
		expected,
		[
			'Production corpus snapshot changed for ' + testCase.name,
			'Snapshot: ' + path.relative(process.cwd(), testCase.snapshotPath),
			'Review the formatter output diff. If the change is intentional, run:',
			'SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1 node tests/production-corpus-golden.test.js'
		].join('\n')
	);
});

console.log('production corpus golden tests passed (' + cases.length + ' cases)');
```

- [ ] **Step 7: Add package scripts for the public corpus test**

Modify `package.json`:

```json
"test:production-corpus": "node tests/production-corpus-golden.test.js",
```

Insert `node tests/production-corpus-golden.test.js` into `test:verify` after `node tests/structured-differential.test.js` and before `node tests/pipeline-idempotency.test.js`.

- [ ] **Step 8: Run the golden test and verify it fails before snapshots exist**

Run:

```bash
node tests/production-corpus-golden.test.js
```

Expected: FAIL with `Missing production corpus snapshot`.

- [ ] **Step 9: Generate public snapshots explicitly**

Run:

```bash
SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1 node tests/production-corpus-golden.test.js
```

Expected: PASS and creates `tests/fixtures/production-corpus/snapshots/*.formatted.sql`.

- [ ] **Step 10: Run the golden test without update mode**

Run:

```bash
node tests/production-corpus-golden.test.js
```

Expected: PASS.

- [ ] **Step 11: Commit Task 1**

Run:

```bash
git status --short
git add package.json tests/fixtures/production-corpus tests/helpers/production-corpus.js tests/production-corpus-golden.test.js
git commit -m "test: add production corpus golden snapshots"
```

Expected: commit includes public corpus fixtures, generated public snapshots, helper, golden test, and `package.json`.

---

### Task 2: Optional Private Corpus Runner

**Files:**
- Create: `tests/production-corpus-private.test.js`
- Modify: `package.json`
- Test: `tests/production-corpus-private.test.js`

- [ ] **Step 1: Add the private corpus test**

Create `tests/production-corpus-private.test.js`:

```js
var assert = require('assert');
var path = require('path');
var sqlFormatter = require('../lib/sql-formatter');
var corpus = require('./helpers/production-corpus');

var privateRoot = process.env.SQL_BEAUTIFY_CORPUS_DIR;

if (!privateRoot) {
	console.log('private production corpus skipped: SQL_BEAUTIFY_CORPUS_DIR is not set');
	process.exit(0);
}

var cases = corpus.load_private_cases(privateRoot);
assert.ok(cases.length > 0, 'private production corpus has no .sql files: ' + privateRoot);

cases.forEach(function(testCase) {
	var result = corpus.format_case(sqlFormatter, testCase);
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);
});

console.log('private production corpus tests passed (' + cases.length + ' cases from ' + path.resolve(privateRoot) + ')');
```

- [ ] **Step 2: Add package script without adding it to `test:verify`**

Modify `package.json`:

```json
"test:production-private": "node tests/production-corpus-private.test.js",
```

Do not add `test:production-private` to `test:verify`.

- [ ] **Step 3: Verify skip behavior**

Run:

```bash
node tests/production-corpus-private.test.js
```

Expected: PASS and prints `private production corpus skipped: SQL_BEAUTIFY_CORPUS_DIR is not set`.

- [ ] **Step 4: Verify local private corpus behavior with a temporary directory**

Run:

```bash
tmpdir="$(mktemp -d)"
cat > "$tmpdir/private-case.sql" <<'SQL'
select a,b from t where x=1 and y=2;
SQL
SQL_BEAUTIFY_CORPUS_DIR="$tmpdir" node tests/production-corpus-private.test.js
rm -rf "$tmpdir"
```

Expected: PASS and prints `private production corpus tests passed (1 cases`.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git status --short
git add package.json tests/production-corpus-private.test.js
git commit -m "test: add optional private production corpus runner"
```

Expected: commit includes only the private runner and package script change.

---

### Task 3: Production Corpus Performance Budget

**Files:**
- Create: `tests/helpers/performance-report.js`
- Create: `tests/production-performance-budget.test.js`
- Modify: `package.json`
- Test: `tests/production-performance-budget.test.js`

- [ ] **Step 1: Add the performance report helper**

Create `tests/helpers/performance-report.js`:

```js
function percentile(sortedNumbers, percentileValue) {
	if (sortedNumbers.length == 0) {
		return 0;
	}
	var index = Math.ceil((percentileValue / 100) * sortedNumbers.length) - 1;
	index = Math.max(0, Math.min(sortedNumbers.length - 1, index));
	return sortedNumbers[index];
}

function round(value) {
	return Math.round(value * 100) / 100;
}

function summarize(samples) {
	var elapsedValues = samples.map(function(sample) {
		return sample.elapsedMs;
	}).sort(function(a, b) {
		return a - b;
	});

	var normalizedValues = samples.map(function(sample) {
		return sample.msPer10kChars;
	}).sort(function(a, b) {
		return a - b;
	});

	var totalElapsed = samples.reduce(function(total, sample) {
		return total + sample.elapsedMs;
	}, 0);

	var totalChars = samples.reduce(function(total, sample) {
		return total + sample.inputChars;
	}, 0);

	return {
		count: samples.length,
		totalChars: totalChars,
		totalElapsedMs: round(totalElapsed),
		p50Ms: round(percentile(elapsedValues, 50)),
		p95Ms: round(percentile(elapsedValues, 95)),
		maxMs: round(elapsedValues.length ? elapsedValues[elapsedValues.length - 1] : 0),
		p95MsPer10kChars: round(percentile(normalizedValues, 95)),
		maxMsPer10kChars: round(normalizedValues.length ? normalizedValues[normalizedValues.length - 1] : 0)
	};
}

function format_summary(summary) {
	return [
		'production performance budget',
		'cases=' + summary.count,
		'chars=' + summary.totalChars,
		'totalMs=' + summary.totalElapsedMs,
		'p50Ms=' + summary.p50Ms,
		'p95Ms=' + summary.p95Ms,
		'maxMs=' + summary.maxMs,
		'p95MsPer10kChars=' + summary.p95MsPer10kChars,
		'maxMsPer10kChars=' + summary.maxMsPer10kChars
	].join(' ');
}

exports.summarize = summarize;
exports.format_summary = format_summary;
```

- [ ] **Step 2: Add the performance budget test**

Create `tests/production-performance-budget.test.js`:

```js
var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');
var corpus = require('./helpers/production-corpus');
var performanceReport = require('./helpers/performance-report');

var cases = corpus.load_public_cases();
assert.ok(cases.length >= 5, 'production performance budget requires public corpus cases');

cases.forEach(function(testCase) {
	corpus.format_case(sqlFormatter, testCase);
});

var samples = cases.map(function(testCase) {
	var start = Date.now();
	var result = corpus.format_case(sqlFormatter, testCase);
	var elapsed = Math.max(0, Date.now() - start);
	var inputChars = testCase.sql.length;
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);

	return {
		name: testCase.name,
		inputChars: inputChars,
		elapsedMs: elapsed,
		msPer10kChars: inputChars > 0 ? elapsed / inputChars * 10000 : 0
	};
});

var summary = performanceReport.summarize(samples);

assert.ok(summary.totalElapsedMs < 10000, 'production corpus total elapsed must stay below disaster guard; actual=' + summary.totalElapsedMs + 'ms');
assert.ok(summary.maxMs < 5000, 'production corpus max case elapsed must stay below disaster guard; actual=' + summary.maxMs + 'ms');
assert.ok(summary.p95MsPer10kChars < 5000, 'production corpus p95 normalized elapsed must stay below disaster guard; actual=' + summary.p95MsPer10kChars + 'ms/10k chars');

console.log(performanceReport.format_summary(summary));
```

- [ ] **Step 3: Add package scripts and `test:verify` entry**

Modify `package.json`:

```json
"test:production-performance": "node tests/production-performance-budget.test.js",
```

Insert `node tests/production-performance-budget.test.js` into `test:verify` after `node tests/performance-smoke.test.js` and before `node tests/tokenizer-profile.test.js`.

- [ ] **Step 4: Run the performance budget test**

Run:

```bash
node tests/production-performance-budget.test.js
```

Expected: PASS and prints a line beginning `production performance budget cases=`.

- [ ] **Step 5: Run adjacent performance/profile checks**

Run:

```bash
node tests/performance-smoke.test.js
node tests/tokenizer-profile.test.js
```

Expected: both commands pass. Record the performance-budget summary and tokenizer profile numbers in the implementation review notes.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git status --short
git add package.json tests/helpers/performance-report.js tests/production-performance-budget.test.js
git commit -m "test: add production corpus performance budget"
```

Expected: commit includes performance helper, performance budget test, and package script changes.

---

### Task 4: Structured Unsupported Diagnostics And Actionable Adapter Messages

**Files:**
- Create: `lib/core/sql-diagnostics.js`
- Create: `tests/diagnostics-explainability.test.js`
- Modify: `lib/core/sql-unsupported-policy.js`
- Modify: `lib/core/sql-syntax-risk-detector.js`
- Modify: `lib/core/sql-clause-splitter.js`
- Modify: `lib/core/sql-format-context.js`
- Modify: `lib/core/sql-formatter.js`
- Modify: `lib/adapters/formatter-diagnostics.js`
- Modify: `tests/unsupported-safety.test.js`
- Modify: `tests/extension-contribution.test.js`
- Modify: `tests/module-boundary.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add explainability tests first**

Create `tests/diagnostics-explainability.test.js`:

```js
var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');
var vkbeautify = require('../vkbeautify');

function detailed(sql, options) {
	return sqlFormatter.format_sql_detailed(sql, Object.assign({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'warn'
	}, options || {}));
}

var matchResult = detailed(
	'select * from t match_recognize (partition by a order by b measures match_number() as mn)'
);
var matchDiagnostic = matchResult.diagnostics.filter(function(item) {
	return item.code == 'unsupported_syntax';
})[0];

assert.ok(matchDiagnostic, 'warn policy must return unsupported_syntax diagnostic');
assert.ok(/unsupported/i.test(matchDiagnostic.message), 'diagnostic message must explain unsupported syntax');
assert.ok(matchDiagnostic.action, 'diagnostic must include user action');
assert.ok(matchDiagnostic.unsupportedSegments.length > 0, 'diagnostic must include unsupported segments');

var matchSegment = matchDiagnostic.unsupportedSegments[0];
assert.strictEqual(matchSegment.kind, 'opaque_clause', 'MATCH_RECOGNIZE segment kind must be opaque_clause');
assert.strictEqual(matchSegment.code, 'unsupported_opaque_clause', 'MATCH_RECOGNIZE segment code must be stable');
assert.strictEqual(matchSegment.label, 'MATCH_RECOGNIZE', 'MATCH_RECOGNIZE segment label must be explicit');
assert.strictEqual(matchSegment.source, 'opaque_protection', 'MATCH_RECOGNIZE segment source must explain preservation path');
assert.strictEqual(matchSegment.confidence, 'known_low_confidence', 'segment confidence must be explicit');
assert.ok(matchSegment.text.indexOf('match_recognize') >= 0, 'segment must retain original text');
assert.ok(matchSegment.snippet.indexOf('match_recognize') >= 0, 'segment must include readable snippet');
assert.ok(matchSegment.range && typeof matchSegment.range.start == 'number', 'segment must include numeric range.start');
assert.ok(matchSegment.range && typeof matchSegment.range.end == 'number', 'segment must include numeric range.end');
assert.ok(matchSegment.action, 'segment must include actionable guidance');

var pivotResult = detailed('select * from t pivot (sum(x) for y in (1))');
var pivotSegment = pivotResult.diagnostics[0].unsupportedSegments.filter(function(item) {
	return item.label == 'PIVOT';
})[0];
assert.ok(pivotSegment, 'PIVOT table construct must produce a labeled diagnostic segment');
assert.strictEqual(pivotSegment.kind, 'known_unmodeled_construct', 'PIVOT segment kind must remain known_unmodeled_construct');
assert.strictEqual(pivotSegment.source, 'syntax_risk_detector', 'PIVOT segment source must explain detector path');

var safeIdentifier = detailed('select qualify as c, pivot as p from t where pivot(p)=1', {
	dialect: 'postgres'
});
assert.strictEqual(safeIdentifier.diagnostics.length, 0, 'keyword-shaped identifiers and functions must not warn');

assert.throws(
	function() {
		vkbeautify.sql(
			'select * from t match_recognize (partition by a order by b measures match_number() as mn)',
			true,
			false,
			true,
			150,
			80,
			{
				dialect: 'generic',
				unsupportedSyntaxPolicy: 'bail_out'
			}
		);
	},
	/Unsupported SQL fragment detected under bail_out policy.*MATCH_RECOGNIZE/,
	'bail_out error must keep the stable prefix and include the first unsupported label'
);

console.log('diagnostics explainability tests passed');
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
node tests/diagnostics-explainability.test.js
```

Expected: FAIL because current diagnostics do not include `code`, `label`, `source`, `confidence`, `action`, and `range` on unsupported segments.

- [ ] **Step 3: Add the core diagnostics helper**

Create `lib/core/sql-diagnostics.js`:

```js
function snippet(text) {
	var value = String(text || '').replace(/\r\n|\r/g, '\n');
	if (value.length <= 180) {
		return value;
	}
	return value.slice(0, 177) + '...';
}

function infer_label(kind, text, explicitLabel) {
	var source = String(text || '').toUpperCase();
	if (explicitLabel) {
		return String(explicitLabel).toUpperCase();
	}
	if (source.indexOf('MATCH_RECOGNIZE') >= 0 || /\bMATCH\s+RECOGNIZE\b/.test(source)) {
		return 'MATCH_RECOGNIZE';
	}
	if (/\bUNPIVOT\b/.test(source)) {
		return 'UNPIVOT';
	}
	if (/\bPIVOT\b/.test(source)) {
		return 'PIVOT';
	}
	if (/\bMERGE\b/.test(source)) {
		return 'MERGE';
	}
	if (/\bQUALIFY\b/.test(source)) {
		return 'QUALIFY';
	}
	return String(kind || 'unsupported_syntax').toUpperCase();
}

function code_for_kind(kind) {
	return 'unsupported_' + String(kind || 'syntax').replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
}

function default_source(kind) {
	if (kind == 'opaque_clause') {
		return 'opaque_protection';
	}
	return 'syntax_risk_detector';
}

function default_action(kind, label) {
	if (kind == 'opaque_clause') {
		return 'Review the preserved ' + label + ' fragment, or set sqlBeautify.unsupportedSyntaxPolicy to bail_out to reject it.';
	}
	return 'Review the ' + label + ' fragment manually, or set sqlBeautify.unsupportedSyntaxPolicy to bail_out to reject low-confidence SQL.';
}

function normalize_range(range) {
	if (!range || typeof range.start != 'number' || typeof range.end != 'number') {
		return null;
	}
	return {
		start: range.start,
		end: range.end
	};
}

function normalize_unsupported_segment(kind, segment) {
	var raw = typeof segment == 'object' && segment !== null
		? segment
		: { text: segment };
	var normalizedKind = raw.kind || kind || 'unsupported_syntax';
	var text = String(raw.text || raw.snippet || '');
	var label = infer_label(normalizedKind, text, raw.label);

	return {
		kind: normalizedKind,
		code: raw.code || code_for_kind(normalizedKind),
		label: label,
		text: text,
		snippet: snippet(raw.snippet || text),
		range: normalize_range(raw.range),
		source: raw.source || default_source(normalizedKind),
		confidence: raw.confidence || 'known_low_confidence',
		action: raw.action || default_action(normalizedKind, label)
	};
}

function unsupported_summary(segments) {
	var list = segments || [];
	var labels = [];
	var seen = {};

	for (var i = 0; i < list.length; i++) {
		var label = list[i].label || infer_label(list[i].kind, list[i].text);
		if (!seen[label]) {
			labels.push(label);
			seen[label] = true;
		}
	}

	if (labels.length == 0) {
		return 'Unsupported or low-confidence SQL syntax was detected.';
	}

	return 'Unsupported or low-confidence SQL syntax was detected: ' + labels.join(', ') + '.';
}

function unsupported_action(segments) {
	var list = segments || [];
	for (var i = 0; i < list.length; i++) {
		if (list[i].action) {
			return list[i].action;
		}
	}
	return 'Review the reported SQL fragment manually, or set sqlBeautify.unsupportedSyntaxPolicy to bail_out to reject low-confidence SQL.';
}

function create_unsupported_runtime_diagnostic(segments) {
	var normalized = (segments || []).map(function(item) {
		return normalize_unsupported_segment(item.kind, item);
	});

	return {
		level: 'warning',
		code: 'unsupported_syntax',
		message: unsupported_summary(normalized),
		action: unsupported_action(normalized),
		unsupportedSegments: normalized
	};
}

exports.normalize_unsupported_segment = normalize_unsupported_segment;
exports.create_unsupported_runtime_diagnostic = create_unsupported_runtime_diagnostic;
exports.unsupported_summary = unsupported_summary;
exports.unsupported_action = unsupported_action;
```

- [ ] **Step 4: Normalize unsupported policy records**

Modify `lib/core/sql-unsupported-policy.js`:

```js
var sqlDiagnostics = require('./sql-diagnostics');
```

Replace `note_unsupported` with:

```js
function note_unsupported(context, kind, segment) {
    var normalized;

    if (!context) {
        return;
    }

    if (!context.unsupportedSegments) {
        context.unsupportedSegments = [];
    }

    normalized = sqlDiagnostics.normalize_unsupported_segment(kind, segment);

    for (var i = 0; i < context.unsupportedSegments.length; i++) {
        if (context.unsupportedSegments[i].kind == normalized.kind
            && context.unsupportedSegments[i].text == normalized.text
            && context.unsupportedSegments[i].source == normalized.source) {
            return;
        }
    }

    context.unsupportedSegments.push(normalized);
}
```

Replace the `bail_out` throw in `enforce_policy` with:

```js
        var segments = (context.unsupportedSegments || []).map(function(item) {
            return sqlDiagnostics.normalize_unsupported_segment(item.kind, item);
        });
        var summary = sqlDiagnostics.unsupported_summary(segments);
        var action = sqlDiagnostics.unsupported_action(segments);
        throw new Error('Unsupported SQL fragment detected under bail_out policy. ' + summary + ' ' + action);
```

Keep `normalize_policy`, `has_unsupported`, and exports intact.

- [ ] **Step 5: Allow richer context notes**

Modify `lib/core/sql-format-context.js` by requiring diagnostics at the top:

```js
var sqlDiagnostics = require('./sql-diagnostics');
```

Replace the object method `note_unsupported` with:

```js
        note_unsupported: function(kind, segment) {
            this.unsupportedSegments.push(sqlDiagnostics.normalize_unsupported_segment(kind, segment));
        }
```

- [ ] **Step 6: Return structured risk detector segments**

Modify `lib/core/sql-syntax-risk-detector.js`.

Replace `note_segment` with:

```js
function note_segment(segments, kind, segment) {
	segments.push(Object.assign({
		kind: kind,
		source: 'syntax_risk_detector',
		confidence: 'known_low_confidence'
	}, segment || {}));
}
```

Add this helper after `snippet_for_range`:

```js
function segment_for_token(source, token, kind, label) {
	return {
		kind: kind,
		label: label,
		text: snippet_for_range(source, token.start, token.end),
		snippet: snippet_for_range(source, token.start, token.end),
		range: {
			start: token.start,
			end: token.end
		},
		source: 'syntax_risk_detector',
		confidence: 'known_low_confidence'
	};
}
```

For `MATCH_RECOGNIZE`, change the `note_segment` call to pass the range metadata:

```js
				note_segment(
					segments,
					syntaxLookup.MATCH_RECOGNIZE || syntaxLookup.MATCH,
					{
						label: 'MATCH_RECOGNIZE',
						text: matchRange.text || snippet_for_range(source, tokens[i].start, tokens[i].end),
						snippet: matchRange.text || snippet_for_range(source, tokens[i].start, tokens[i].end),
						range: {
							start: typeof matchRange.start == 'number' ? matchRange.start : tokens[i].start,
							end: typeof matchRange.end == 'number' ? matchRange.end : tokens[i].end
						},
						source: 'opaque_protection',
						confidence: 'known_low_confidence'
					}
				);
```

For `QUALIFY`, `MERGE`, and `PIVOT` / `UNPIVOT`, replace plain snippets with:

```js
			note_segment(segments, kind, segment_for_token(source, tokens[i], kind, value));
```

- [ ] **Step 7: Return structured opaque-protection segments**

Modify `lib/core/sql-clause-splitter.js`.

Add this helper near `protect_opaque_segments`:

```js
function note_opaque_segment(context, range) {
    sqlUnsupportedPolicy.note_unsupported(context, 'opaque_clause', {
        kind: 'opaque_clause',
        label: 'MATCH_RECOGNIZE',
        text: range.text,
        snippet: range.text,
        range: {
            start: range.start,
            end: range.end
        },
        source: 'opaque_protection',
        confidence: 'known_low_confidence'
    });
}
```

Inside `protect_opaque_segments`, replace both existing `sqlUnsupportedPolicy.note_unsupported(context, 'opaque_clause', range.text);` calls with:

```js
            note_opaque_segment(context, range);
```

and:

```js
        note_opaque_segment(context, range);
```

- [ ] **Step 8: Pass full risk segments through the formatter**

Modify `lib/core/sql-formatter.js`.

Add:

```js
var sqlDiagnostics = require('./sql-diagnostics');
```

Replace the `collect_runtime_diagnostics` unsupported warning object with:

```js
        diagnostics.push(sqlDiagnostics.create_unsupported_runtime_diagnostic(context.unsupportedSegments || []));
```

In `format_sql_detailed`, replace:

```js
        sqlUnsupportedPolicy.note_unsupported(context, riskSegments[r].kind, riskSegments[r].text);
```

with:

```js
        sqlUnsupportedPolicy.note_unsupported(context, riskSegments[r].kind, riskSegments[r]);
```

- [ ] **Step 9: Make adapter warning text actionable**

Modify `lib/adapters/formatter-diagnostics.js`.

Add this helper inside `create_diagnostics` before the returned object:

```js
    function diagnostic_message(item) {
        var message = item && item.message ? item.message : 'SQL Beautify warning.';
        var action = item && item.action ? item.action : '';
        return action ? message + ' ' + action : message;
    }
```

In `runtime_diagnostics`, replace:

```js
                show_user_warning('SQL Beautify warning: ' + list[i].message, {
```

with:

```js
                show_user_warning('SQL Beautify warning: ' + diagnostic_message(list[i]), {
```

Keep the debug payload shape, including `unsupportedSegments`.

- [ ] **Step 10: Add module-boundary assertions**

Modify `tests/module-boundary.test.js` by requiring the helper:

```js
var sqlDiagnostics = require('../lib/core/sql-diagnostics');
```

Add an exact export assertion near other export-surface checks:

```js
assert.deepStrictEqual(
	Object.keys(sqlDiagnostics).sort(),
	[
		'create_unsupported_runtime_diagnostic',
		'normalize_unsupported_segment',
		'unsupported_action',
		'unsupported_summary'
	].sort(),
	'sql-diagnostics must expose only the structured unsupported diagnostic helpers'
);
```

Add a source assertion near live graph dependency checks:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-diagnostics.js')),
	'structured diagnostics helper must exist in core'
);
```

- [ ] **Step 11: Extend unsupported safety assertions**

In `tests/unsupported-safety.test.js`, after the existing `warned` assertions for `MATCH_RECOGNIZE`, add:

```js
assert.ok(
	warned.diagnostics[0].action,
	'warn diagnostic must include actionable guidance'
);

assert.strictEqual(
	warned.diagnostics[0].unsupportedSegments[0].label,
	'MATCH_RECOGNIZE',
	'warn diagnostic segment must label MATCH_RECOGNIZE'
);

assert.strictEqual(
	warned.diagnostics[0].unsupportedSegments[0].source,
	'opaque_protection',
	'warn diagnostic segment must identify opaque protection source'
);
```

- [ ] **Step 12: Extend VS Code adapter diagnostics test**

In `tests/extension-contribution.test.js`, add this test after the existing document formatting provider diagnostics coverage. Use the already-defined `create_vscode_mock`, `load_extension_with_mock`, and `create_document` helpers from the same file:

```js
var warningMock = create_vscode_mock();
warningMock.workspace.getConfiguration = function(section, scope) {
	warningMock.configScopes.push({ section: section, scope: scope });
	return {
		get: function(key) {
			var values = {
				keywordCase: 'upper',
				commaStyle: 'leading',
				indentStyle: 'space',
				maxAlignWidth: 150,
				caseWhenThenWrapLength: 80,
				dialect: 'generic',
				unsupportedSyntaxPolicy: 'warn',
				debugDiagnostics: false
			};
			return values[key];
		},
		inspect: function() {
			return {};
		}
	};
};

var warningExtension = load_extension_with_mock(warningMock);
warningExtension.activate({ subscriptions: [] });

var warningDocument = create_document(
	'select * from t match_recognize (partition by a order by b measures match_number() as mn)'
);
warningMock.documentProvider.provideDocumentFormattingEdits(warningDocument);

assert.ok(
	warningMock.warnings.some(function(message) {
		return /MATCH_RECOGNIZE/.test(message) && /bail_out/.test(message);
	}),
	'VS Code warning must name the unsupported construct and suggest bail_out for strict handling'
);
```

- [ ] **Step 13: Add package script and `test:verify` entry**

Modify `package.json`:

```json
"test:diagnostics": "node tests/diagnostics-explainability.test.js",
```

Insert `node tests/diagnostics-explainability.test.js` into `test:verify` after `node tests/unsupported-safety.test.js` or near other diagnostics-related tests. Keep `node tests/unsupported-safety.test.js` in `test:verify`.

- [ ] **Step 14: Run targeted diagnostics checks**

Run:

```bash
node tests/diagnostics-explainability.test.js
node tests/unsupported-safety.test.js
node tests/extension-contribution.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass.

- [ ] **Step 15: Run syntax checks for changed live modules**

Run:

```bash
node -c lib/core/sql-diagnostics.js
node -c lib/core/sql-unsupported-policy.js
node -c lib/core/sql-syntax-risk-detector.js
node -c lib/core/sql-clause-splitter.js
node -c lib/core/sql-format-context.js
node -c lib/core/sql-formatter.js
node -c lib/adapters/formatter-diagnostics.js
```

Expected: all syntax checks pass.

- [ ] **Step 16: Commit Task 4**

Run:

```bash
git status --short
git add lib/core/sql-diagnostics.js lib/core/sql-unsupported-policy.js lib/core/sql-syntax-risk-detector.js lib/core/sql-clause-splitter.js lib/core/sql-format-context.js lib/core/sql-formatter.js lib/adapters/formatter-diagnostics.js tests/diagnostics-explainability.test.js tests/unsupported-safety.test.js tests/extension-contribution.test.js tests/module-boundary.test.js package.json
git commit -m "feat: explain unsupported SQL diagnostics"
```

Expected: commit contains structured diagnostics implementation, diagnostics tests, adapter warning update, module-boundary update, and package script.

---

### Task 5: Documentation, Full Verification, And Packaging Smoke

**Files:**
- Modify: `docs/technical/sql-formatter-architecture.md`
- Test: full verification and VSIX content

- [ ] **Step 1: Update architecture documentation**

Modify `docs/technical/sql-formatter-architecture.md`.

Under `## Verification Contract`, add:

```markdown
- `tests/production-corpus-golden.test.js` locks committed anonymized production-shaped SQL against readable `.formatted.sql` snapshots. Snapshot updates require `SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1`.
- `tests/production-performance-budget.test.js` reports corpus p50/p95/max timing and uses wide gates as disaster guards, not exact performance promises.
```

Under `## Diagnostics Contract`, add:

```markdown
- Unsupported syntax diagnostics use structured segment metadata: `kind`, `code`, `label`, `text`, `snippet`, `range`, `source`, `confidence`, and `action`.
- `format_sql()` remains text-only. `format_sql_detailed()` remains `{ text, diagnostics }` and is the diagnostics-bearing API.
- Private production SQL can be checked locally with `SQL_BEAUTIFY_CORPUS_DIR=/path/to/sql node tests/production-corpus-private.test.js`; private corpus contents must not be committed.
```

- [ ] **Step 2: Verify package scripts**

Run:

```bash
jq -r '.scripts | keys[]' package.json | rg 'production|diagnostics'
```

Expected output includes:

```text
test:diagnostics
test:production-corpus
test:production-performance
test:production-private
```

- [ ] **Step 3: Run all new targeted tests**

Run:

```bash
node tests/production-corpus-golden.test.js
node tests/production-corpus-private.test.js
node tests/production-performance-budget.test.js
node tests/diagnostics-explainability.test.js
```

Expected: all pass. The private corpus test should skip when `SQL_BEAUTIFY_CORPUS_DIR` is unset.

- [ ] **Step 4: Run core regression checks adjacent to the new work**

Run:

```bash
node tests/unsupported-safety.test.js
node tests/extension-contribution.test.js
node tests/module-boundary.test.js
node tests/tokenizer-profile.test.js
node tests/performance-smoke.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run test:verify
```

Expected: PASS, including the new public corpus, diagnostics, and production performance budget tests.

- [ ] **Step 6: Run VSIX packaging smoke**

Run:

```bash
ALL_PROXY=socks5://127.0.0.1:7897 npm run package:vsix
```

Expected: PASS and creates `vscode-sql-beautify-v$(node -p "require('./package.json').version").vsix`.

- [ ] **Step 7: Verify VSIX content boundaries**

Run:

```bash
vsix="$(ls -t vscode-sql-beautify-v*.vsix | head -1)"
node -e "const cp=require('child_process'); const list=cp.execFileSync('unzip',['-Z1',process.argv[1]],{encoding:'utf8'}).trim().split(/\\n/); const has=p=>list.includes(p); const starts=p=>list.some(x=>x.startsWith(p)); const checks=[['includes diagnostics helper',has('extension/lib/core/sql-diagnostics.js')],['excludes tests',!starts('extension/tests/')],['excludes docs',!starts('extension/docs/')],['excludes production corpus',!starts('extension/tests/fixtures/production-corpus/')]]; const failed=checks.filter(x=>!x[1]); if(failed.length){console.error(failed.map(x=>x[0]).join('\\n')); process.exit(1);} console.log('VSIX production diagnostics content smoke passed');" "$vsix"
```

Expected: PASS and prints `VSIX production diagnostics content smoke passed`.

- [ ] **Step 8: Run diff hygiene checks**

Run:

```bash
git diff --check
git status --short --ignored
```

Expected: `git diff --check` exits 0. `git status --short --ignored` shows tracked changes ready to commit plus ignored `.vsix`, `.DS_Store`, and `node_modules/` artifacts only.

- [ ] **Step 9: Commit Task 5**

Run:

```bash
git status --short
git add docs/technical/sql-formatter-architecture.md
git commit -m "docs: document production regression diagnostics"
```

Expected: commit contains the architecture documentation update only.

- [ ] **Step 10: Final review checkpoint**

Run:

```bash
git log --oneline -6
git status --short --ignored
```

Expected:

- recent commits include Task 1 through Task 5
- no tracked or staged changes remain
- ignored generated `.vsix` artifacts remain untracked

Report:

- new public corpus case count
- generated snapshot file count
- production performance summary line
- `npm run test:verify` result
- package smoke result
- VSIX content smoke result
- any non-blocking follow-up items discovered during implementation

---

## Plan Self-Review Checklist

- Spec coverage:
  - Public committed corpus: Task 1.
  - Strict golden snapshots and explicit update mode: Task 1.
  - Optional private corpus: Task 2.
  - p95-style performance reporting and wide gates: Task 3.
  - Structured unsupported diagnostics and actionable adapter messages: Task 4.
  - Architecture docs, full verification, and packaging smoke: Task 5.
- Scope control:
  - No full parser work.
  - No formatter behavior rewrite.
  - No private SQL committed.
  - No VSIX artifact committed.
  - Private corpus is not added to `test:verify`.
- Verification:
  - New targeted tests are listed before full `npm run test:verify`.
  - Packaging smoke includes VSIX content boundaries for new helper and non-packaged test/corpus/docs files.
