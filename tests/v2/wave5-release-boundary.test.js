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
var migration = fs.readFileSync(path.join(root, 'docs', 'migration-to-2.0.md'), 'utf8');
var architecture = fs.readFileSync(
    path.join(root, 'docs', 'technical', 'sql-formatter-architecture.md'),
    'utf8'
);

assert.strictEqual(packageJson.version, '2.0.0');
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
assert.match(readme, new RegExp(
    '/blob/v' + packageJson.version.replace(/\./g, '\\.') +
    '/docs/migration-to-' + packageJson.version.split('.').slice(0, 2).join('\\.') + '\\.md'
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
    '__TYPE_REQUIRED__'
].forEach(function(value) {
    assert.ok(migration.indexOf(value) >= 0, 'migration guide must mention ' + value);
});
assert.match(architecture, /src\/core\/lexer/);
assert.match(architecture, /dist\/runtime\.cjs/);
assert.doesNotMatch(architecture, /`lib\//);
assert.doesNotMatch(architecture, /vkbeautify/);

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
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('v2 Wave 5 release boundary tests passed');
