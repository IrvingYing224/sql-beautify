#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var manifestApi = require('./package-manifest');
var strictXml = require('./strict-xml');

function argumentValue(args, name) {
    var index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length) {
        throw new Error('Missing required argument: ' + name);
    }
    return args[index + 1];
}

function hasArgument(args, name) {
    return args.indexOf(name) >= 0;
}

function unzipText(artifactPath, entry) {
    return childProcess.execFileSync('unzip', ['-p', artifactPath, entry], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
}

function unzipBuffer(artifactPath, entry) {
    return childProcess.execFileSync('unzip', ['-p', artifactPath, entry], {
        encoding: null,
        maxBuffer: 16 * 1024 * 1024
    });
}

function listEntries(artifactPath) {
    return childProcess.execFileSync('unzip', ['-Z1', artifactPath], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    }).trim().split('\n').filter(Boolean);
}

function parseGeneratedVsixManifest(xml) {
    var root = strictXml.parseStrictXml(xml);
    assert.strictEqual(root.name, 'PackageManifest',
        'VSIX manifest root must be PackageManifest');
    assert.deepStrictEqual(root.attributes, Object.assign(
        Object.create(null),
        {
            Version: '2.0.0',
            xmlns: 'http://schemas.microsoft.com/developer/vsx-schema/2011',
            'xmlns:d': 'http://schemas.microsoft.com/developer/vsx-schema-design/2011'
        }
    ), 'VSIX PackageManifest attributes must match the generated schema');
    assert.deepStrictEqual(
        root.children.map(function(child) { return child.name; }),
        ['Metadata', 'Installation', 'Dependencies', 'Assets'],
        'VSIX PackageManifest must contain the exact generated sections'
    );

    function directChild(parent, name) {
        var matches = parent.children.filter(function(child) {
            return child.name === name;
        });
        assert.strictEqual(matches.length, 1,
            parent.name + ' must contain exactly one ' + name);
        return matches[0];
    }

    function descendantsNamed(node, name, output) {
        if (node.name === name) {
            output.push(node);
        }
        node.children.forEach(function(child) {
            descendantsNamed(child, name, output);
        });
    }

    var metadata = directChild(root, 'Metadata');
    var identity = directChild(metadata, 'Identity');
    assert.strictEqual(identity.selfClosing, true,
        'VSIX Identity must be self-closing');
    assert.deepStrictEqual(identity.children, [],
        'VSIX Identity must not contain children');
    var allIdentities = [];
    descendantsNamed(root, 'Identity', allIdentities);
    assert.strictEqual(allIdentities.length, 1,
        'VSIX Identity must only appear in Metadata');
    var propertiesContainer = directChild(metadata, 'Properties');
    var properties = new Map();
    propertiesContainer.children.forEach(function(property) {
        assert.strictEqual(property.name, 'Property',
            'VSIX Properties must contain only Property elements');
        assert.strictEqual(property.selfClosing, true,
            'VSIX Property must be self-closing');
        assert.deepStrictEqual(property.children, [],
            'VSIX Property must not contain children');
        assert.deepStrictEqual(Object.keys(property.attributes).sort(), ['Id', 'Value'],
            'VSIX Property must contain only Id and Value');
        assert.strictEqual(properties.has(property.attributes.Id), false,
            'VSIX manifest must not repeat Property ' + property.attributes.Id);
        properties.set(property.attributes.Id, property.attributes.Value);
    });
    var allProperties = [];
    descendantsNamed(root, 'Property', allProperties);
    assert.strictEqual(allProperties.length, propertiesContainer.children.length,
        'VSIX Property elements must only appear in Metadata/Properties');

    var dependencies = directChild(root, 'Dependencies');
    assert.strictEqual(dependencies.selfClosing, true,
        'VSIX Dependencies must be an empty self-closing element');
    assert.deepStrictEqual(Object.keys(dependencies.attributes), [],
        'VSIX Dependencies must not have attributes');
    assert.deepStrictEqual(dependencies.children, [],
        'VSIX Dependencies must not contain generated dependencies');
    var dependencyContainers = [];
    descendantsNamed(root, 'Dependencies', dependencyContainers);
    assert.strictEqual(dependencyContainers.length, 1,
        'VSIX Dependencies must only appear at the package root');
    var dependencyNodes = [];
    descendantsNamed(root, 'Dependency', dependencyNodes);
    assert.deepStrictEqual(dependencyNodes, [],
        'VSIX manifest must not contain Dependency elements');
    return Object.freeze({
        identity: identity.attributes,
        properties: properties
    });
}

function canonicalExtensionList(value) {
    return Array.isArray(value) ? Array.from(new Set(value)).join(',') : '';
}

function verifyGeneratedVsixManifest(xml, packageJson) {
    assert.ok(Buffer.byteLength(xml, 'utf8') <= 1024 * 1024,
        'VSIX generated manifest exceeds the verification budget');
    var parsed = parseGeneratedVsixManifest(xml);
    var identity = parsed.identity;
    assert.deepStrictEqual(Object.keys(identity).sort(), [
        'Id',
        'Language',
        'Publisher',
        'Version'
    ], 'VSIX Identity must contain the exact release identity fields');
    assert.strictEqual(identity.Language, 'en-US',
        'VSIX manifest language must be en-US');
    assert.strictEqual(identity.Id, packageJson.name,
        'VSIX manifest Id must match the source package');
    assert.strictEqual(identity.Publisher, packageJson.publisher,
        'VSIX manifest Publisher must match the source package');
    assert.strictEqual(identity.Version, packageJson.version,
        'VSIX manifest Version must match the source package');

    var properties = parsed.properties;
    assert.strictEqual(
        properties.get('Microsoft.VisualStudio.Code.Engine'),
        packageJson.engines.vscode,
        'VSIX engine must match the source package'
    );
    assert.strictEqual(
        properties.get('Microsoft.VisualStudio.Code.ExtensionDependencies'),
        canonicalExtensionList(packageJson.extensionDependencies),
        'VSIX extension dependencies must match the source package'
    );
    assert.strictEqual(
        properties.get('Microsoft.VisualStudio.Code.ExtensionPack'),
        canonicalExtensionList(packageJson.extensionPack),
        'VSIX extension pack must match the source package'
    );
}

function verifyPackedSourceFiles(artifactPath, root, packageManifest) {
    var packageJson = packageManifest.packageJson;
    var packedManifest = JSON.parse(unzipText(
        artifactPath,
        'extension/package.json'
    ));
    assert.deepStrictEqual(packedManifest, packageJson,
        'packed package manifest must match the source package exactly');
    var staticFiles = new Set(packageManifest.staticFiles);
    packageManifest.vsixPackageFiles.forEach(function(entry) {
        if (!staticFiles.has(entry.sourcePath)) {
            return;
        }
        var source = fs.readFileSync(path.join(root, entry.sourcePath));
        var packed = unzipBuffer(artifactPath, entry.entryPath);
        assert.deepStrictEqual(packed, source,
            'packed static file must match source bytes: ' + entry.sourcePath);
    });
    verifyGeneratedVsixManifest(
        unzipText(artifactPath, 'extension.vsixmanifest'),
        packageJson
    );
}

function verifyTrustedBuild(artifactPath, root, packageManifest) {
    var fingerprint = require('./runtime-build-fingerprint');
    var utils = require('./build-v2-utils');
    var stampPath = path.join(root, '.tmp', 'v2-runtime-build-stamp.json');
    var stamp = utils.readJson(stampPath);
    assert.ok(stamp !== null && stamp.schemaVersion === 2,
        '--compare-build requires a current trusted build stamp');
    assert.strictEqual(stamp.debugSourceMaps, false,
        'release artifacts must come from a non-debug runtime build');
    assert.strictEqual(stamp.esbuildVersion, fingerprint.esbuildVersion(),
        'trusted build stamp must use the current esbuild version');
    assert.strictEqual(
        stamp.sourceHash,
        fingerprint.runtimeSourceHash(root, false),
        'trusted build stamp source hash must match the current source'
    );
    assert.ok(utils.validateOutputManifest(
        path.join(root, 'dist'),
        stamp.outputManifest
    ), 'current dist must match the trusted build stamp exactly');
    assert.deepStrictEqual(
        stamp.outputManifest.map(function(output) { return output.path; }),
        packageManifest.runtimeFileNames.slice().sort(),
        'trusted build stamp must describe the exact packaged runtime set'
    );
    stamp.outputManifest.forEach(function(output) {
        var packed = unzipBuffer(
            artifactPath,
            'extension/dist/' + output.path
        );
        var packedSha256 = crypto.createHash('sha256')
            .update(packed).digest('hex');
        assert.strictEqual(packed.length, output.size,
            'VSIX runtime size differs from the trusted build stamp: ' + output.path);
        assert.strictEqual(packedSha256, output.sha256,
            'VSIX runtime SHA-256 differs from the trusted build stamp: ' + output.path);
    });
}

function verifyArtifact(artifactPath, options) {
    var settings = options || {};
    var root = settings.root || path.join(__dirname, '..');
    var compareBuild = settings.compareBuild === true;
    var packageManifest = manifestApi.loadPackageManifest(root);
    var packageJson = packageManifest.packageJson;
    var packageLock = require(path.join(root, 'package-lock.json'));
    var expectedName = 'vscode-sql-beautify-v' + packageJson.version + '.vsix';
    assert.strictEqual(path.basename(artifactPath), expectedName,
        'VSIX filename must match package version');
    assert.strictEqual(packageLock.version, packageJson.version,
        'package lock version must match package version');
    assert.strictEqual(packageLock.packages[''].version, packageJson.version,
        'package lock root version must match package version');
    assert.ok(fs.statSync(artifactPath).isFile(), 'VSIX artifact must be a regular file');

    var entries = listEntries(artifactPath);
    var entrySet = new Set(entries);
    var expectedEntries = packageManifest.vsixEntries;
    assert.deepStrictEqual(entries.slice().sort(), expectedEntries,
        'VSIX must contain the exact production allowlist');
    verifyPackedSourceFiles(artifactPath, root, packageManifest);
    if (compareBuild) {
        verifyTrustedBuild(artifactPath, root, packageManifest);
    }
    packageManifest.runtimeFiles.forEach(function(fileName) {
        assert.ok(entrySet.has('extension/' + fileName),
            'VSIX is missing runtime artifact: ' + fileName);
    });
    entries.forEach(function(entry) {
        assert.ok(!/^extension\/(?:src|tests|scripts|docs|lib|node_modules|\.tmp|\.superpowers)(?:\/|$)/.test(entry),
            'VSIX contains forbidden development path: ' + entry);
        assert.notStrictEqual(entry, 'extension/extension.js');
        assert.notStrictEqual(entry, 'extension/vkbeautify.js');
    });
    var migrationVersion = packageJson.version.split('.').slice(0, 2).join('.');
    assert.match(
        unzipText(artifactPath, 'extension/readme.md'),
        new RegExp('/blob/v' + packageJson.version.replace(/\./g, '\\.') +
            '/docs/migration-to-' + migrationVersion.replace(/\./g, '\\.') + '\\.md'),
        'packed README migration link must be pinned to the package version'
    );

    return Object.freeze({
        artifact: path.resolve(artifactPath),
        entryCount: entries.length,
        version: packageJson.version
    });
}

function run(args) {
    var artifact = argumentValue(args, '--artifact');
    var result = verifyArtifact(path.resolve(process.cwd(), artifact), {
        compareBuild: hasArgument(args, '--compare-build')
    });
    console.log('Verified release artifact ' + path.basename(result.artifact) +
        ' (' + result.entryCount + ' entries, version ' + result.version + ')');
}

if (require.main === module) {
    try {
        run(process.argv.slice(2));
    } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    }
}

module.exports = Object.freeze({ verifyArtifact: verifyArtifact });
