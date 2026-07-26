'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var packageJson = require(path.join(root, 'package.json'));
var packageLock = require(path.join(root, 'package-lock.json'));
var workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-vsix.yml'), 'utf8');
var readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
var changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
var migrationVersion = packageJson.version.split('.').slice(0, 2).join('.');
var migrationPath = path.join(root, 'docs', 'migration-to-' + migrationVersion + '.md');
var migration = fs.readFileSync(migrationPath, 'utf8');
var architecture = fs.readFileSync(
    path.join(root, 'docs', 'technical', 'sql-formatter-architecture.md'),
    'utf8'
);

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
assert.strictEqual(packageLock.version, packageJson.version);
assert.strictEqual(packageLock.packages[''].version, packageJson.version);
assert.strictEqual(packageJson.scripts.prepack, 'npm run build:v2-runtime');
assert.match(packageJson.scripts['package:vsix'], /verify-release-artifact\.js/);
assert.match(packageJson.scripts['package:vsix'], /--compare-build/);
assert.match(packageJson.scripts['test:verify'], /test:v2:wave5/);

assert.match(workflow, /^permissions:\n  contents: read$/m,
    'workflow default token must be read-only');
assert.match(workflow, /^  release:\n(?:.|\n)*?    permissions:\n      contents: write$/m,
    'only the release job may request contents write');
assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /GITHUB_SHA/);
assert.match(workflow, /refs\/heads\/main/);
assert.match(workflow, /--target "\$\{GITHUB_SHA\}"/);
assert.match(workflow, /vscode-sql-beautify-v\$\{VERSION\}\.vsix/);

assert.match(readme, /`postgresql`/);
assert.doesNotMatch(readme, /`postgres`/);
assert.doesNotMatch(readme, /extractddl/i,
    'current README must not reuse the removed 1.x API spelling');
assert.doesNotMatch(readme, /demo\.gif/,
    'current README must not embed the obsolete 1.x demo');
assert.match(readme, /Hive `CREATE TABLE` 子集/,
    'README must state the bounded experimental Hive DDL contract');
assert.match(readme, /524,288 个 UTF-16 code units/,
    'README must state the formatter input boundary and its unit');
assert.match(readme, /verbatim 区域.*keywordCase|keywordCase.*verbatim 区域/,
    'README must state that verbatim content does not receive keyword case');
assert.match(readme, /手动执行 `SQL Beautify: Format SQL`.*汇总提示/,
    'README must state preserve feedback for the explicit command');
assert.match(readme, /debugDiagnostics=true.*SQL 片段.*本地文件路径/,
    'README must disclose opt-in debug console content');
assert.match(readme, /INSERT INTO.*`SET`|`SET`.*INSERT INTO/,
    'README must describe the new bounded Hive command support');
assert.match(packageJson.description, /Hive-first SQL formatter with lossless token handling/,
    'Marketplace description must describe the current formatter');
assert.match(readme, new RegExp(
    '/blob/v' + packageJson.version.replace(/\./g, '\\.') +
    '/docs/migration-to-' + migrationVersion.replace(/\./g, '\\.') + '\\.md'
));
assert.match(readme, /`sqlBeautify\.unsupportedSyntaxPolicy` \| `preserve` \/ `warn` \/ `bail_out` \| `warn`/);
[
    'extension.beautifySql',
    'extension.beautifySqlddl',
    'extension.extractDdl',
    'vscode-sql-beautify/formatter',
    'vscode-sql-beautify/experimental/ddl',
    'postgresql',
    'formatted',
    'preserved',
    '__TYPE_REQUIRED__',
    '524,288',
    'UTF-16',
    'verbatim',
    'keywordCase',
    'debugDiagnostics',
    'INSERT INTO',
    'SET'
].forEach(function(value) {
    assert.ok(migration.indexOf(value) >= 0, 'migration guide must mention ' + value);
});
assert.match(architecture, /src\/core\/lexer/);
assert.match(architecture, /dist\/runtime\.cjs/);
assert.match(architecture, /524,288 JavaScript UTF-16 code units/);
assert.match(architecture, /fewer than 8,192 source code units and fewer than 2,000 leaves/);
assert.match(architecture, /`debugDiagnostics` is an opt-in internal execution channel/);
assert.match(architecture, /DDL has no semantic source map/);
assert.match(architecture, /Hive `EXPLAIN`, `GROUPING SETS`, `TRANSFORM`, DDL, `UPDATE`, and `DELETE`/);
assert.doesNotMatch(architecture, /`lib\//);
assert.doesNotMatch(architecture, /vkbeautify/);

var changelogVersions = Array.from(changelog.matchAll(/^### (\d+)\.(\d+)\.(\d+)(?: |$)/gm));
assert.ok(changelogVersions.length > 0, 'CHANGELOG must contain semantic version headings');
assert.strictEqual(
    changelogVersions[0].slice(1, 4).join('.'),
    packageJson.version,
    'latest CHANGELOG version must match the package version'
);
var changelogVersionKeys = changelogVersions.map(function(match) {
    return match.slice(1, 4).join('.');
});
assert.strictEqual(new Set(changelogVersionKeys).size, changelogVersionKeys.length,
    'CHANGELOG version headings must be unique');
for (var versionIndex = 1; versionIndex < changelogVersions.length; versionIndex++) {
    var previous = changelogVersions[versionIndex - 1].slice(1, 4).map(Number);
    var current = changelogVersions[versionIndex].slice(1, 4).map(Number);
    assert.ok(
        previous[0] > current[0] ||
            (previous[0] === current[0] && previous[1] > current[1]) ||
            (previous[0] === current[0] && previous[1] === current[1] && previous[2] > current[2]),
        'CHANGELOG versions must be strictly descending: ' +
            changelogVersionKeys[versionIndex - 1] + ' before ' + changelogVersionKeys[versionIndex]
    );
}

var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-release-boundary-'));
try {
    var artifactName = 'vscode-sql-beautify-v' + packageJson.version + '.vsix';
    var artifactPath = path.join(temporaryRoot, artifactName);
    childProcess.execFileSync(
        path.join(root, 'node_modules', '.bin', 'vsce'),
        ['package', '--no-dependencies', '--out', artifactPath],
        { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    var cleanRoot = path.join(temporaryRoot, 'clean-checkout');
    fs.mkdirSync(path.join(cleanRoot, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(cleanRoot, 'package.json'));
    fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(cleanRoot, 'package-lock.json'));
    fs.copyFileSync(path.join(root, 'README.md'), path.join(cleanRoot, 'README.md'));
    fs.cpSync(path.join(root, 'images'), path.join(cleanRoot, 'images'), { recursive: true });
    fs.copyFileSync(
        path.join(root, 'scripts', 'verify-release-artifact.js'),
        path.join(cleanRoot, 'scripts', 'verify-release-artifact.js')
    );
    fs.copyFileSync(artifactPath, path.join(cleanRoot, artifactName));
    assert.strictEqual(fs.existsSync(path.join(cleanRoot, 'dist')), false,
        'release validation fixture must model a fresh checkout without dist');
    childProcess.execFileSync(
        process.execPath,
        ['scripts/verify-release-artifact.js', '--artifact', artifactName],
        { cwd: cleanRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    fs.writeFileSync(path.join(cleanRoot, 'images', 'unused.png'), '', 'utf8');
    var orphanImageCheck = childProcess.spawnSync(
        process.execPath,
        ['scripts/verify-release-artifact.js', '--artifact', artifactName],
        { cwd: cleanRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    assert.notStrictEqual(orphanImageCheck.status, 0,
        'release verification must reject undeclared repository images');
    assert.match(orphanImageCheck.stderr, /repository images must contain only explicitly packaged/);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('v2 Wave 5 release boundary tests passed');
