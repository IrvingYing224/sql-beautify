#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var manifestApi = require('./package-manifest');

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

function decodeXmlAttribute(value) {
    var entities = Object.freeze({
        '&apos;': "'",
        '&quot;': '"',
        '&lt;': '<',
        '&gt;': '>',
        '&amp;': '&'
    });
    assert.doesNotMatch(value, /&(?!apos;|quot;|lt;|gt;|amp;)/,
        'VSIX manifest contains an unsupported or unescaped XML entity');
    return value.replace(/&(?:apos|quot|lt|gt|amp);/g, function(entity) {
        return entities[entity];
    });
}

function parseXmlAttributes(raw, label) {
    var attributes = Object.create(null);
    var matcher = /([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g;
    var match;
    var previousEnd = raw.indexOf(' ');
    assert.ok(previousEnd >= 0, label + ' must contain attributes');
    while ((match = matcher.exec(raw)) !== null) {
        assert.strictEqual(raw.slice(previousEnd, match.index).trim(), '',
            label + ' contains unrecognized attribute syntax');
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(attributes, match[1]),
            false,
            label + ' must not repeat attribute ' + match[1]
        );
        attributes[match[1]] = decodeXmlAttribute(match[2]);
        previousEnd = matcher.lastIndex;
    }
    assert.match(raw.slice(previousEnd), /^\s*\/?>$/,
        label + ' contains trailing unrecognized attribute syntax');
    return attributes;
}

function singleXmlTagAttributes(xml, tagName) {
    var matcher = new RegExp('<' + tagName + '\\b[^>]*>', 'g');
    var tags = xml.match(matcher) || [];
    assert.strictEqual(tags.length, 1,
        'VSIX manifest must contain exactly one ' + tagName + ' tag');
    return parseXmlAttributes(tags[0], tagName);
}

function xmlPropertyMap(xml) {
    var matcher = /<Property\b[^>]*\/>/g;
    var properties = new Map();
    var match;
    while ((match = matcher.exec(xml)) !== null) {
        var attributes = parseXmlAttributes(match[0], 'Property');
        assert.deepStrictEqual(Object.keys(attributes).sort(), ['Id', 'Value'],
            'VSIX Property must contain only Id and Value');
        assert.strictEqual(properties.has(attributes.Id), false,
            'VSIX manifest must not repeat Property ' + attributes.Id);
        properties.set(attributes.Id, attributes.Value);
    }
    return properties;
}

function canonicalExtensionList(value) {
    return Array.isArray(value) ? Array.from(new Set(value)).join(',') : '';
}

function verifyGeneratedVsixManifest(xml, packageJson) {
    assert.ok(Buffer.byteLength(xml, 'utf8') <= 1024 * 1024,
        'VSIX generated manifest exceeds the verification budget');
    var identity = singleXmlTagAttributes(xml, 'Identity');
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

    var properties = xmlPropertyMap(xml);
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
    var dependencyContainers = xml.match(/<Dependencies\b[^>]*>/g) || [];
    assert.deepStrictEqual(dependencyContainers, ['<Dependencies/>'],
        'VSIX manifest must contain one empty Dependencies container');
    assert.doesNotMatch(xml, /<Dependency\b/,
        'VSIX manifest must not contain generated dependencies');
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
