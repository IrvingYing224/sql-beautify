'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var packageTools = require('../../scripts/package-tools');

var root = path.join(__dirname, '..', '..');
var packageManifest = require(path.join(root, 'scripts', 'package-manifest.js'))
    .loadPackageManifest(root);
var packageJson = packageManifest.packageJson;
var strictXml = require(path.join(root, 'scripts', 'strict-xml.js'));
var packageLock = require(path.join(root, 'package-lock.json'));
var workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-vsix.yml'), 'utf8');
var verifyPlan = require(path.join(root, 'scripts', 'v2-suite-manifest.js'))
    .buildPlan('verify');
var readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
var changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
var migrationVersion = packageJson.version.split('.').slice(0, 2).join('.');
var migrationPath = path.join(root, 'docs', 'migration-to-' + migrationVersion + '.md');
var migration = fs.readFileSync(migrationPath, 'utf8');
var architecture = fs.readFileSync(
    path.join(root, 'docs', 'technical', 'sql-formatter-architecture.md'),
    'utf8'
);

function copyReleaseTrustRoot(destination) {
    ['package.json', 'package-lock.json'].concat(
        packageManifest.staticFiles,
        packageManifest.declarationFiles.map(function(fileName) {
            return 'src/runtime/' + path.basename(fileName);
        })
    ).forEach(function(fileName) {
        var destinationPath = path.join(destination, fileName);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(path.join(root, fileName), destinationPath);
    });
}

(function testBoundedStrictXmlParser() {
    var declaration = '<?xml version="1.0" encoding="utf-8"?>';
    var parsed = strictXml.parseStrictXml(
        declaration + '<Root a="&amp;&#65;&#x42;" b=\'value\'><Child/></Root>'
    );
    assert.strictEqual(parsed.name, 'Root');
    assert.strictEqual(parsed.attributes.a, '&AB');
    assert.strictEqual(parsed.attributes.b, 'value');
    assert.strictEqual(parsed.text, '');
    assert.strictEqual(parsed.children.length, 1);
    assert.strictEqual(parsed.children[0].selfClosing, true);
    assert.strictEqual(parsed.children[0].text, '');
    var decodedText = strictXml.parseStrictXml(
        declaration + '<Root>direct &amp; decoded &#x41;</Root>'
    );
    assert.strictEqual(decodedText.text, 'direct & decoded A');
    [
        declaration + '<Root><!-- fake --></Root>',
        declaration + '<Root><![CDATA[fake]]></Root>',
        declaration + '<!DOCTYPE Root><Root/>',
        declaration + '<?probe value?><Root/>',
        declaration + '<Root/><Other/>',
        declaration + '<Root><Other></Root>',
        declaration + '<Root a="&unknown;"/>',
        declaration + '<Root>raw & text</Root>',
        declaration + '<Root>bad ]]> text</Root>',
        declaration + '<Root>mixed<Child/></Root>',
        declaration + '<Root>\u00a0<Child/></Root>',
        declaration + '\u00a0<Root/>',
        declaration + '<Root>\u0000</Root>'
    ].forEach(function(source, index) {
        assert.throws(function() {
            strictXml.parseStrictXml(source);
        }, 'strict XML negative case ' + index);
    });
})();

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
assert.strictEqual(packageJson.version, '2.2.0',
    'the unified audit remediation candidate must be 2.2.0');
assert.strictEqual(packageLock.version, packageJson.version);
assert.strictEqual(packageLock.packages[''].version, packageJson.version);
assert.strictEqual(packageJson.scripts.prepack, 'node scripts/build-v2-runtime.js');
assert.strictEqual(packageJson.scripts['package:vsix'], 'node scripts/package-vsix.js');
var packagePlan = require('../../scripts/package-vsix').packagePlan();
assert.strictEqual(packagePlan.length, 3);
assert.strictEqual(path.basename(packagePlan[0][0]), 'build-v2-runtime.js');
assert.strictEqual(packagePlan[1][0], packageTools.vsceCliPath());
assert.strictEqual(path.basename(packagePlan[1][4]),
    'vscode-sql-beautify-v' + packageJson.version + '.vsix');
assert.strictEqual(path.basename(packagePlan[2][0]), 'verify-release-artifact.js');
assert.strictEqual(packagePlan[2][3], '--compare-build');
assert.strictEqual(packagePlan[2][2], packagePlan[1][4]);
packageTools.requireArchiveTools(['zip', 'unzip']);
assert.strictEqual(packageJson.scripts['test:verify'],
    'node scripts/run-v2-suite.js verify');
assert.deepStrictEqual(verifyPlan.steps.filter(function(step) {
    return step.category !== 'test';
}).map(function(step) { return step.category; }), ['typecheck', 'core', 'runtime'],
    'verify suite must schedule each canonical prerequisite exactly once');
assert.ok(verifyPlan.steps.some(function(step) {
    return step.args.indexOf('tests/v2/wave5-release-boundary.test.js') >= 0;
}), 'verify suite must retain the release boundary');
assert.ok(verifyPlan.steps.some(function(step) {
    return step.args.indexOf('scripts/verify-clean-package.js') >= 0;
}), 'verify suite must retain one clean-package lifecycle');

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
assert.match(workflow, /node: \[20, 24\]/,
    'workflow must smoke the supported Node 20 runtime and Node 24 development lane');
assert.match(workflow, /npm run test:v2:node-smoke/);
assert.match(workflow, /npm run test:v2:performance-relative/);
assert.match(workflow,
    /github\.event_name == 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/,
    'strict relative wall-clock gates must stay off hosted pull requests');
assert.strictEqual((workflow.match(/npm run verify:clean-package/g) || []).length, 0,
    'workflow must not duplicate the clean-package step already owned by test:verify');

assert.match(readme, /`postgresql`/);
assert.doesNotMatch(readme, /`postgres`/);
assert.doesNotMatch(readme, /\bextractddl\b/,
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
assert.match(readme, /标准 `Format Document` \/ `Format Selection`/,
    'README must use the standard VS Code formatter entry');
assert.doesNotMatch(readme, /`Alt\+Shift\+F`/,
    'README must not advertise the removed default formatter keybinding');
assert.match(readme, /PARTITIONED BY.*STORED AS|STORED AS.*PARTITIONED BY/,
    'README must disclose the modeled Hive DDL suffixes');
assert.match(readme, /DDL \/ Extract DDL.*524,288 个 UTF-16 code units/,
    'README must disclose the experimental DDL input limit');
assert.match(readme, /`hive-sql` language id 由第三方 Hive 语言扩展提供/,
    'README must disclose the third-party hive-sql language dependency');
assert.match(packageJson.description, /Hive-first SQL formatter with lossless token handling/,
    'Marketplace description must describe the current formatter');
assert.match(
    packageJson.contributes.configuration.properties['sqlBeautify.debugDiagnostics'].description,
    /SQL fragments.*error stacks.*local file paths/,
    'Settings UI must disclose opt-in debug console content'
);
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
    'SET',
    'SYN_PROOF_BUDGET',
    'LAYOUT_COMMA_FALLBACK',
    'Unicode 17.0.0',
    'tabSize',
    'PARTITIONED BY',
    'STORED AS',
    'Node 20',
    'Node 24',
    '2.1.0'
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
assert.match(architecture, /size-aware active-cancellation drain grace/);
assert.match(architecture, /tests\/v2\/perf-baseline\.json/);
assert.match(architecture, /scripts\/v2-suite-manifest\.js/);
assert.match(architecture, /scripts\/package-manifest\.js/);
assert.match(architecture, /Node 20 and Node 24/);
assert.match(architecture, /Release comparison recomputes the same runtime source fingerprint/);
assert.match(architecture, /allowlisted regular files/);
assert.match(architecture, /packed package manifest and repository-owned static bytes/);
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
        process.execPath,
        [packageTools.vsceCliPath(), 'package', '--no-dependencies', '--out', artifactPath],
        { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    childProcess.execFileSync(process.execPath, [
        'scripts/verify-release-artifact.js',
        '--artifact', artifactPath,
        '--compare-build'
    ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    var staleRoot = path.join(temporaryRoot, 'stale-source-checkout');
    fs.mkdirSync(path.join(staleRoot, '.tmp'), { recursive: true });
    fs.mkdirSync(path.join(staleRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(staleRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist'), path.join(staleRoot, 'dist'), { recursive: true });
    copyReleaseTrustRoot(staleRoot);
    [
        'build-v2-runtime.js',
        'build-v2-utils.js',
        'package-manifest.js',
        'runtime-build-fingerprint.js'
    ].forEach(function(fileName) {
        var sourcePath = path.join(root, 'scripts', fileName);
        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, path.join(staleRoot, 'scripts', fileName));
        }
    });
    fs.copyFileSync(
        path.join(root, '.tmp', 'v2-runtime-build-stamp.json'),
        path.join(staleRoot, '.tmp', 'v2-runtime-build-stamp.json')
    );
    var verifier = require(path.join(root, 'scripts', 'verify-release-artifact.js'));
    assert.doesNotThrow(function() {
        verifier.verifyArtifact(artifactPath, {
            root: staleRoot,
            compareBuild: true
        });
    }, 'an exact source snapshot must match the trusted runtime stamp');
    fs.appendFileSync(
        path.join(staleRoot, 'src', 'runtime', 'index.ts'),
        '\n// stale source fingerprint probe\n',
        'utf8'
    );
    assert.throws(function() {
        verifier.verifyArtifact(artifactPath, {
            root: staleRoot,
            compareBuild: true
        });
    }, /source hash|current source|trusted build/i,
    '--compare-build must reject an old stamp/dist/VSIX after source changes');

    function tamperedArtifact(label, entryPath, transform) {
        var tamperRoot = path.join(temporaryRoot, 'tamper-' + label);
        var tamperedPath = path.join(tamperRoot, artifactName);
        var unpackedPath = path.join(tamperRoot, 'unpacked');
        fs.mkdirSync(unpackedPath, { recursive: true });
        fs.copyFileSync(artifactPath, tamperedPath);
        childProcess.execFileSync('unzip', [
            '-q', tamperedPath, '-d', unpackedPath
        ]);
        var targetPath = path.join(unpackedPath, entryPath);
        fs.writeFileSync(targetPath, transform(fs.readFileSync(targetPath)));
        childProcess.execFileSync('zip', [
            '-q', tamperedPath, entryPath
        ], { cwd: unpackedPath });
        return tamperedPath;
    }

    function assertArtifactRejectedInBothModes(tamperedPath, label) {
        [false, true].forEach(function(compareBuild) {
            assert.throws(function() {
                verifier.verifyArtifact(tamperedPath, {
                    root: root,
                    compareBuild: compareBuild
                });
            }, label + ' must fail in compareBuild=' + compareBuild);
        });
    }

    function directChild(parent, name) {
        var matches = parent.children.filter(function(child) {
            return child.name === name;
        });
        assert.strictEqual(matches.length, 1,
            parent.name + ' fixture must contain exactly one ' + name);
        return matches[0];
    }

    function tamperElementAttribute(buffer, elementName, elementIndex,
        attributeName, replacement) {
        var value = buffer.toString('utf8');
        var elementPattern = new RegExp('<' + elementName + '\\b[^>]*>', 'g');
        var seen = 0;
        var changed = value.replace(elementPattern, function(element) {
            if (seen !== elementIndex) {
                seen += 1;
                return element;
            }
            seen += 1;
            var attributePattern = new RegExp(
                '(\\s' + attributeName + '=")[^"]*(")'
            );
            var tampered = element.replace(attributePattern,
                '$1' + replacement + '$2');
            assert.notStrictEqual(tampered, element,
                elementName + '[' + elementIndex + '] fixture must contain ' +
                    attributeName);
            return tampered;
        });
        assert.ok(seen > elementIndex,
            elementName + '[' + elementIndex + '] fixture must exist');
        assert.notStrictEqual(changed, value,
            elementName + '[' + elementIndex + '] fixture must modify the manifest');
        return Buffer.from(changed, 'utf8');
    }

    function tamperLeafText(buffer, elementName, replacement) {
        var value = buffer.toString('utf8');
        var openingPattern = '(<' + elementName + '\\b[^>]*>)';
        var elementPattern = new RegExp(
            openingPattern + '[\\s\\S]*?(</' + elementName + '>)'
        );
        var changed = value.replace(elementPattern, '$1' + replacement + '$2');
        assert.notStrictEqual(changed, value,
            elementName + ' text fixture must modify the manifest');
        return Buffer.from(changed, 'utf8');
    }

    function replaceFixture(buffer, search, replacement, label) {
        var value = buffer.toString('utf8');
        var changed = value.replace(search, replacement);
        assert.notStrictEqual(changed, value,
            label + ' fixture must modify the artifact entry');
        return Buffer.from(changed, 'utf8');
    }

    var generatedManifestXml = childProcess.execFileSync(
        'unzip', ['-p', artifactPath, 'extension.vsixmanifest'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    var generatedManifest = strictXml.parseStrictXml(generatedManifestXml);
    var generatedMetadata = directChild(generatedManifest, 'Metadata');
    var generatedProperties = directChild(generatedMetadata, 'Properties').children;
    var generatedAssets = directChild(generatedManifest, 'Assets').children;
    assert.deepStrictEqual(generatedProperties.map(function(property) {
        return property.attributes.Id;
    }), [
        'Microsoft.VisualStudio.Code.Engine',
        'Microsoft.VisualStudio.Code.ExtensionDependencies',
        'Microsoft.VisualStudio.Code.ExtensionPack',
        'Microsoft.VisualStudio.Code.ExtensionKind',
        'Microsoft.VisualStudio.Code.LocalizedLanguages',
        'Microsoft.VisualStudio.Code.EnabledApiProposals',
        'Microsoft.VisualStudio.Code.ExecutesCode',
        'Microsoft.VisualStudio.Services.Links.Source',
        'Microsoft.VisualStudio.Services.Links.Getstarted',
        'Microsoft.VisualStudio.Services.Links.GitHub',
        'Microsoft.VisualStudio.Services.Links.Support',
        'Microsoft.VisualStudio.Services.Links.Learn',
        'Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown',
        'Microsoft.VisualStudio.Services.Content.Pricing'
    ], 'tamper matrix must cover every generated Property in order');
    assert.deepStrictEqual(generatedAssets.map(function(asset) {
        return asset.attributes.Type;
    }), [
        'Microsoft.VisualStudio.Code.Manifest',
        'Microsoft.VisualStudio.Services.Content.Details',
        'Microsoft.VisualStudio.Services.Content.Changelog',
        'Microsoft.VisualStudio.Services.Content.License',
        'Microsoft.VisualStudio.Services.Icons.Default'
    ], 'tamper matrix must cover the core and every static Asset in order');

    var installationTargetTamper = tamperedArtifact(
        'manifest-installation-target',
        'extension.vsixmanifest',
        function(buffer) {
            return tamperElementAttribute(
                buffer,
                'InstallationTarget',
                0,
                'Id',
                'Untrusted.Installation.Target'
            );
        }
    );
    assertArtifactRejectedInBothModes(installationTargetTamper,
        'VSIX InstallationTarget Id tamper');

    generatedAssets.forEach(function(asset, assetIndex) {
        assert.strictEqual(asset.name, 'Asset',
            'generated Assets fixture must contain only Asset elements');
        ['Type', 'Path', 'Addressable'].forEach(function(attributeName) {
            var assetTamper = tamperedArtifact(
                'manifest-asset-' + assetIndex + '-' + attributeName.toLowerCase(),
                'extension.vsixmanifest',
                function(buffer) {
                    return tamperElementAttribute(
                        buffer,
                        'Asset',
                        assetIndex,
                        attributeName,
                        'TAMPERED_' + assetIndex + '_' + attributeName
                    );
                }
            );
            assertArtifactRejectedInBothModes(assetTamper,
                'VSIX Asset[' + assetIndex + '] ' + attributeName + ' tamper');
        });
    });

    generatedProperties.forEach(function(property, propertyIndex) {
        assert.strictEqual(property.name, 'Property',
            'generated Properties fixture must contain only Property elements');
        var propertyTamper = tamperedArtifact(
            'manifest-property-' + propertyIndex,
            'extension.vsixmanifest',
            function(buffer) {
                return tamperElementAttribute(
                    buffer,
                    'Property',
                    propertyIndex,
                    'Value',
                    'TAMPERED_PROPERTY_' + propertyIndex
                );
            }
        );
        assertArtifactRejectedInBothModes(propertyTamper,
            'VSIX Property ' + property.attributes.Id + ' value tamper');
    });

    [
        'DisplayName',
        'Description',
        'Tags',
        'Categories',
        'GalleryFlags',
        'License',
        'Icon'
    ].forEach(function(elementName, metadataIndex) {
        var metadataTamper = tamperedArtifact(
            'manifest-metadata-text-' + metadataIndex,
            'extension.vsixmanifest',
            function(buffer) {
                return tamperLeafText(
                    buffer,
                    elementName,
                    'TAMPERED_METADATA_' + metadataIndex
                );
            }
        );
        assertArtifactRejectedInBothModes(metadataTamper,
            'VSIX ' + elementName + ' text tamper');
    });

    var unknownAttributeTamper = tamperedArtifact(
        'manifest-unknown-attribute',
        'extension.vsixmanifest',
        function(buffer) {
            var value = buffer.toString('utf8');
            var changed = value.replace(
                '<DisplayName>',
                '<DisplayName Unknown="true">'
            );
            assert.notStrictEqual(changed, value,
                'unknown attribute fixture must modify the manifest');
            return Buffer.from(changed, 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(unknownAttributeTamper,
        'VSIX unknown metadata attribute');

    var extraChildTamper = tamperedArtifact(
        'manifest-extra-child',
        'extension.vsixmanifest',
        function(buffer) {
            var value = buffer.toString('utf8');
            var changed = value.replace(
                '</Metadata>',
                '<UnexpectedMetadata />\n</Metadata>'
            );
            assert.notStrictEqual(changed, value,
                'extra child fixture must modify the manifest');
            return Buffer.from(changed, 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(extraChildTamper,
        'VSIX extra Metadata child');

    var duplicatePropertyTamper = tamperedArtifact(
        'manifest-duplicate-property',
        'extension.vsixmanifest',
        function(buffer) {
            var value = buffer.toString('utf8');
            var firstProperty = value.match(/<Property\b[^>]*\/>/);
            assert.ok(firstProperty,
                'duplicate Property fixture must find a generated Property');
            return Buffer.from(value.replace(
                '</Properties>',
                firstProperty[0] + '\n</Properties>'
            ), 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(duplicatePropertyTamper,
        'VSIX duplicate Property');

    var pairedTargetTamper = tamperedArtifact(
        'manifest-paired-installation-target',
        'extension.vsixmanifest',
        function(buffer) {
            var value = buffer.toString('utf8');
            var changed = value.replace(
                /<InstallationTarget\b([^>]*)\/>/,
                '<InstallationTarget$1></InstallationTarget>'
            );
            assert.notStrictEqual(changed, value,
                'paired InstallationTarget fixture must modify the manifest');
            return Buffer.from(changed, 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(pairedTargetTamper,
        'VSIX paired InstallationTarget');

    var contentTypesEntry = '[Content_Types].xml';
    var contentTypesTamperCases = [
        {
            label: 'namespace',
            transform: function(buffer) {
                return replaceFixture(
                    buffer,
                    'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"',
                    'xmlns="urn:untrusted-content-types"',
                    'content-types namespace'
                );
            }
        },
        {
            label: 'json-mime',
            transform: function(buffer) {
                return replaceFixture(
                    buffer,
                    'Extension=".json" ContentType="application/json"',
                    'Extension=".json" ContentType="text/plain"',
                    'content-types JSON MIME'
                );
            }
        },
        {
            label: 'json-extension',
            transform: function(buffer) {
                return replaceFixture(
                    buffer,
                    'Extension=".json" ContentType="application/json"',
                    'Extension=".mjs" ContentType="application/json"',
                    'content-types JSON extension'
                );
            }
        },
        {
            label: 'missing-vsixmanifest',
            transform: function(buffer) {
                return replaceFixture(
                    buffer,
                    '<Default Extension=".vsixmanifest" ContentType="text/xml"/>',
                    '',
                    'content-types missing VSIX manifest mapping'
                );
            }
        },
        {
            label: 'duplicate-json',
            transform: function(buffer) {
                var entry = '<Default Extension=".json" ' +
                    'ContentType="application/json"/>';
                return replaceFixture(
                    buffer,
                    '</Types>',
                    entry + '</Types>',
                    'content-types duplicate JSON mapping'
                );
            }
        },
        {
            label: 'extra-exe',
            transform: function(buffer) {
                return replaceFixture(
                    buffer,
                    '</Types>',
                    '<Default Extension=".exe" ' +
                        'ContentType="application/octet-stream"/></Types>',
                    'content-types extra executable mapping'
                );
            }
        },
        {
            label: 'override-node',
            transform: function(buffer) {
                return replaceFixture(
                    buffer,
                    '<Default Extension=".json" ContentType="application/json"/>',
                    '<Override PartName="/extension/package.json" ' +
                        'ContentType="application/json"/>',
                    'content-types Override node'
                );
            }
        },
        {
            label: 'paired-default',
            transform: function(buffer) {
                return replaceFixture(
                    buffer,
                    '<Default Extension=".json" ContentType="application/json"/>',
                    '<Default Extension=".json" ' +
                        'ContentType="application/json"></Default>',
                    'content-types paired Default'
                );
            }
        }
    ];
    contentTypesTamperCases.forEach(function(testCase) {
        var contentTypesTamper = tamperedArtifact(
            'content-types-' + testCase.label,
            contentTypesEntry,
            testCase.transform
        );
        assertArtifactRejectedInBothModes(contentTypesTamper,
            'VSIX content types ' + testCase.label + ' tamper');
    });

    var duplicateMainTamper = tamperedArtifact(
        'package-duplicate-main',
        'extension/package.json',
        function(buffer) {
            var trustedMain = '\t"main": "./dist/extension.cjs",';
            return replaceFixture(
                buffer,
                trustedMain,
                '\t"main": "./untrusted-runtime.cjs",\n' + trustedMain,
                'packed package duplicate main'
            );
        }
    );
    assertArtifactRejectedInBothModes(duplicateMainTamper,
        'packed package duplicate main');

    var reorderedPackageTamper = tamperedArtifact(
        'package-reordered-json',
        'extension/package.json',
        function(buffer) {
            var parsedPackage = JSON.parse(buffer.toString('utf8'));
            var reorderedPackage = {};
            Object.keys(parsedPackage).reverse().forEach(function(key) {
                reorderedPackage[key] = parsedPackage[key];
            });
            var changed = Buffer.from(
                JSON.stringify(reorderedPackage, null, '\t') + '\n',
                'utf8'
            );
            assert.notDeepStrictEqual(changed, buffer,
                'packed package reordered fixture must change source bytes');
            return changed;
        }
    );
    assertArtifactRejectedInBothModes(reorderedPackageTamper,
        'packed package reordered JSON');

    var packageTamper = tamperedArtifact(
        'package-extension-pack',
        'extension/package.json',
        function(buffer) {
            var value = JSON.parse(buffer.toString('utf8'));
            value.extensionPack = ['untrusted.publisher-extension'];
            return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(packageTamper,
        'packed package metadata tamper');

    packageManifest.staticFiles.forEach(function(fileName, index) {
        var mapping = packageManifest.vsixPackageFiles.find(function(entry) {
            return entry.sourcePath === fileName;
        });
        assert.ok(mapping, 'static file must have a packed-entry mapping: ' + fileName);
        var staticTamper = tamperedArtifact(
            'static-' + index,
            mapping.entryPath,
            function(buffer) {
                return Buffer.concat([
                    buffer,
                    Buffer.from('\nTAMPERED_STATIC_' + index + '\n', 'utf8')
                ]);
            }
        );
        assertArtifactRejectedInBothModes(staticTamper,
            'packed static tamper ' + fileName);
    });

    packageManifest.declarationFiles.forEach(function(fileName, index) {
        var declarationTamper = tamperedArtifact(
            'declaration-' + index,
            'extension/' + fileName,
            function(buffer) {
                return Buffer.concat([buffer, Buffer.from('\nexport const privateApi: any;\n')]);
            }
        );
        assertArtifactRejectedInBothModes(declarationTamper,
            'packed declaration tamper ' + fileName);
    });

    var identityTamper = tamperedArtifact(
        'manifest-identity',
        'extension.vsixmanifest',
        function(buffer) {
            var value = buffer.toString('utf8');
            var changed = value.replace(
                'Publisher="' + packageJson.publisher + '"',
                'Publisher="untrusted-publisher"'
            );
            assert.notStrictEqual(changed, value,
                'identity tamper fixture must modify the manifest');
            return Buffer.from(changed, 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(identityTamper,
        'VSIX Identity tamper');

    var dependencyTamper = tamperedArtifact(
        'manifest-extension-pack',
        'extension.vsixmanifest',
        function(buffer) {
            var value = buffer.toString('utf8');
            var changed = value.replace(
                'Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""',
                'Id="Microsoft.VisualStudio.Code.ExtensionPack" ' +
                    'Value="untrusted.publisher-extension"'
            );
            assert.notStrictEqual(changed, value,
                'extension-pack tamper fixture must modify the manifest');
            return Buffer.from(changed, 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(dependencyTamper,
        'VSIX ExtensionPack tamper');

    var structuralBypassTamper = tamperedArtifact(
        'manifest-property-structural-bypass',
        'extension.vsixmanifest',
        function(buffer) {
            var value = buffer.toString('utf8');
            var trustedProperty =
                '<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />';
            var changed = value.replace(
                trustedProperty,
                '<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" ' +
                    'Value="untrusted.publisher-extension"></Property>\n' +
                    '<!-- ' + trustedProperty + ' -->'
            );
            assert.notStrictEqual(changed, value,
                'structural XML bypass fixture must modify the manifest');
            return Buffer.from(changed, 'utf8');
        }
    );
    assertArtifactRejectedInBothModes(structuralBypassTamper,
        'VSIX paired Property plus comment bypass');

    var trailingRootTamper = tamperedArtifact(
        'manifest-trailing-root',
        'extension.vsixmanifest',
        function(buffer) {
            return Buffer.concat([
                buffer,
                Buffer.from('\n<UnexpectedRoot/>\n', 'utf8')
            ]);
        }
    );
    assertArtifactRejectedInBothModes(trailingRootTamper,
        'VSIX trailing XML root tamper');

    var artifactBefore = fs.readFileSync(artifactPath);
    var runtimeArtifact = path.join(root, 'dist', 'runtime.cjs');
    var runtimeArtifactBefore = fs.readFileSync(runtimeArtifact);
    var unpackedArtifact = path.join(temporaryRoot, 'tampered-artifact');
    fs.mkdirSync(unpackedArtifact);
    try {
        childProcess.execFileSync('unzip', ['-q', artifactPath, '-d', unpackedArtifact]);
        var corruptedRuntime = Buffer.from('BROKEN_RUNTIME_CACHE\n', 'utf8');
        fs.writeFileSync(runtimeArtifact, corruptedRuntime);
        fs.writeFileSync(
            path.join(unpackedArtifact, 'extension', 'dist', 'runtime.cjs'),
            corruptedRuntime
        );
        childProcess.execFileSync('zip', [
            '-q', artifactPath, 'extension/dist/runtime.cjs'
        ], { cwd: unpackedArtifact });
        var corruptedCompare = childProcess.spawnSync(process.execPath, [
            'scripts/verify-release-artifact.js',
            '--artifact', artifactPath,
            '--compare-build'
        ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        assert.notStrictEqual(corruptedCompare.status, 0,
            '--compare-build must reject equally corrupted dist and VSIX artifacts');
        assert.match(corruptedCompare.stderr, /build stamp|digest|SHA-256/i);
    } finally {
        fs.writeFileSync(runtimeArtifact, runtimeArtifactBefore);
        fs.writeFileSync(artifactPath, artifactBefore);
    }
    var cleanRoot = path.join(temporaryRoot, 'clean-checkout');
    fs.mkdirSync(path.join(cleanRoot, 'scripts'), { recursive: true });
    copyReleaseTrustRoot(cleanRoot);
    fs.copyFileSync(
        path.join(root, 'scripts', 'verify-release-artifact.js'),
        path.join(cleanRoot, 'scripts', 'verify-release-artifact.js')
    );
    fs.copyFileSync(
        path.join(root, 'scripts', 'package-manifest.js'),
        path.join(cleanRoot, 'scripts', 'package-manifest.js')
    );
    fs.copyFileSync(
        path.join(root, 'scripts', 'strict-xml.js'),
        path.join(cleanRoot, 'scripts', 'strict-xml.js')
    );
    fs.copyFileSync(
        path.join(root, 'scripts', 'package-tools.js'),
        path.join(cleanRoot, 'scripts', 'package-tools.js')
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
    assert.match(orphanImageCheck.stderr,
        /images must contain only shared-manifest production assets/);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('v2 Wave 5 release boundary tests passed');
