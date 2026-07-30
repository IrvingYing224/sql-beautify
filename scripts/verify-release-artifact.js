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

function expectedAttributes(values) {
    return Object.assign(Object.create(null), values);
}

function assertElement(node, expected, label) {
    assert.strictEqual(node.name, expected.name,
        label + ' must have the expected element name');
    assert.strictEqual(node.selfClosing, expected.selfClosing,
        label + ' must have the expected self-closing shape');
    assert.deepStrictEqual(node.attributes, expectedAttributes(expected.attributes),
        label + ' must contain the exact generated attributes');
    assert.deepStrictEqual(
        node.children.map(function(child) { return child.name; }),
        expected.children,
        label + ' must contain the exact generated children in order'
    );
    if (Object.prototype.hasOwnProperty.call(expected, 'text')) {
        assert.strictEqual(node.text, expected.text,
            label + ' must contain the expected direct text');
    } else {
        assert.match(node.text, /^[ \t\r\n]*$/,
            label + ' container text must be formatting whitespace only');
    }
}

function parseGeneratedVsixManifest(xml) {
    var root = strictXml.parseStrictXml(xml);

    assert.strictEqual(root.name, 'PackageManifest',
        'VSIX manifest root must be PackageManifest');
    assertElement(root, {
        name: 'PackageManifest',
        selfClosing: false,
        attributes: {
            Version: '2.0.0',
            xmlns: 'http://schemas.microsoft.com/developer/vsx-schema/2011',
            'xmlns:d': 'http://schemas.microsoft.com/developer/vsx-schema-design/2011'
        },
        children: ['Metadata', 'Installation', 'Dependencies', 'Assets']
    }, 'VSIX PackageManifest');

    function directChild(parent, name) {
        var matches = parent.children.filter(function(child) {
            return child.name === name;
        });
        assert.strictEqual(matches.length, 1,
            parent.name + ' must contain exactly one ' + name);
        return matches[0];
    }

    var metadata = directChild(root, 'Metadata');
    assertElement(metadata, {
        name: 'Metadata',
        selfClosing: false,
        attributes: {},
        children: [
            'Identity',
            'DisplayName',
            'Description',
            'Tags',
            'Categories',
            'GalleryFlags',
            'Properties',
            'License',
            'Icon'
        ]
    }, 'VSIX Metadata');
    var identity = directChild(metadata, 'Identity');
    assertElement(identity, {
        name: 'Identity',
        selfClosing: true,
        attributes: identity.attributes,
        children: [],
        text: ''
    }, 'VSIX Identity');
    var metadataLeaves = Object.freeze([
        directChild(metadata, 'DisplayName'),
        directChild(metadata, 'Description'),
        directChild(metadata, 'Tags'),
        directChild(metadata, 'Categories'),
        directChild(metadata, 'GalleryFlags'),
        directChild(metadata, 'License'),
        directChild(metadata, 'Icon')
    ]);
    metadataLeaves.forEach(function(leaf) {
        assert.strictEqual(leaf.selfClosing, false,
            'VSIX metadata leaf ' + leaf.name + ' must use paired tags');
        assert.deepStrictEqual(leaf.children, [],
            'VSIX metadata leaf ' + leaf.name + ' must not contain children');
    });
    var propertiesContainer = directChild(metadata, 'Properties');
    assertElement(propertiesContainer, {
        name: 'Properties',
        selfClosing: false,
        attributes: {},
        children: propertiesContainer.children.map(function() { return 'Property'; })
    }, 'VSIX Properties');
    var propertyIds = new Set();
    propertiesContainer.children.forEach(function(property) {
        assertElement(property, {
            name: 'Property',
            selfClosing: true,
            attributes: property.attributes,
            children: [],
            text: ''
        }, 'VSIX Property');
        assert.deepStrictEqual(Object.keys(property.attributes).sort(), ['Id', 'Value'],
            'VSIX Property must contain exactly Id and Value');
        assert.strictEqual(propertyIds.has(property.attributes.Id), false,
            'VSIX manifest must not repeat Property ' + property.attributes.Id);
        propertyIds.add(property.attributes.Id);
    });

    var installation = directChild(root, 'Installation');
    assertElement(installation, {
        name: 'Installation',
        selfClosing: false,
        attributes: {},
        children: ['InstallationTarget']
    }, 'VSIX Installation');
    var installationTarget = directChild(installation, 'InstallationTarget');
    assertElement(installationTarget, {
        name: 'InstallationTarget',
        selfClosing: true,
        attributes: { Id: 'Microsoft.VisualStudio.Code' },
        children: [],
        text: ''
    }, 'VSIX InstallationTarget');

    var dependencies = directChild(root, 'Dependencies');
    assertElement(dependencies, {
        name: 'Dependencies',
        selfClosing: true,
        attributes: {},
        children: [],
        text: ''
    }, 'VSIX Dependencies');

    var assetsContainer = directChild(root, 'Assets');
    assertElement(assetsContainer, {
        name: 'Assets',
        selfClosing: false,
        attributes: {},
        children: assetsContainer.children.map(function() { return 'Asset'; })
    }, 'VSIX Assets');
    var assetKeys = new Set();
    assetsContainer.children.forEach(function(asset) {
        assertElement(asset, {
            name: 'Asset',
            selfClosing: true,
            attributes: asset.attributes,
            children: [],
            text: ''
        }, 'VSIX Asset');
        assert.deepStrictEqual(Object.keys(asset.attributes).sort(), [
            'Addressable',
            'Path',
            'Type'
        ], 'VSIX Asset must contain exactly Type, Path, and Addressable');
        var assetKey = asset.attributes.Type + '\u0000' + asset.attributes.Path;
        assert.strictEqual(assetKeys.has(assetKey), false,
            'VSIX manifest must not repeat Asset ' + asset.attributes.Type +
                ' at ' + asset.attributes.Path);
        assetKeys.add(assetKey);
    });
    return Object.freeze({
        identity: identity.attributes,
        metadataLeaves: metadataLeaves,
        properties: Object.freeze(propertiesContainer.children.slice()),
        installationTarget: installationTarget,
        assets: Object.freeze(assetsContainer.children.slice())
    });
}

function verifyGeneratedContentTypes(xml, packageManifest) {
    assert.ok(Buffer.byteLength(xml, 'utf8') <= 1024 * 1024,
        'VSIX content types exceed the verification budget');
    var root = strictXml.parseStrictXml(xml);
    assertElement(root, {
        name: 'Types',
        selfClosing: false,
        attributes: {
            xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types'
        },
        children: packageManifest.vsixContentTypes.map(function() {
            return 'Default';
        })
    }, 'VSIX content types root');
    var seenExtensions = new Set();
    root.children.forEach(function(entry) {
        assertElement(entry, {
            name: 'Default',
            selfClosing: true,
            attributes: entry.attributes,
            children: [],
            text: ''
        }, 'VSIX content type Default');
        assert.deepStrictEqual(Object.keys(entry.attributes).sort(), [
            'ContentType',
            'Extension'
        ], 'VSIX content type Default must contain exactly Extension and ContentType');
        assert.strictEqual(seenExtensions.has(entry.attributes.Extension), false,
            'VSIX content types must not repeat extension ' +
                entry.attributes.Extension);
        seenExtensions.add(entry.attributes.Extension);
    });
    assert.deepStrictEqual(root.children.map(function(entry) {
        return {
            extension: entry.attributes.Extension,
            contentType: entry.attributes.ContentType
        };
    }), packageManifest.vsixContentTypes,
    'VSIX content types must match the exact shared package suffix mapping');
}

function canonicalExtensionList(value) {
    return Array.isArray(value) ? Array.from(new Set(value)).join(',') : '';
}

function canonicalExtensionKind(packageJson) {
    var kinds;
    if (packageJson.extensionKind !== undefined) {
        kinds = Array.isArray(packageJson.extensionKind)
            ? packageJson.extensionKind.slice()
            : packageJson.extensionKind === 'ui'
                ? ['ui', 'workspace']
                : [packageJson.extensionKind];
        if (packageJson.browser && kinds.indexOf('web') < 0) {
            kinds.push('web');
        }
        return kinds.join(',');
    }
    if (packageJson.main) {
        return packageJson.browser ? 'workspace,web' : 'workspace';
    }
    return packageJson.browser ? 'web' : 'ui,workspace,web';
}

function sourceRepositoryUrl(packageJson) {
    if (typeof packageJson.repository === 'string') {
        return packageJson.repository;
    }
    if (packageJson.repository && typeof packageJson.repository.url === 'string') {
        return packageJson.repository.url;
    }
    return '';
}

function inferredGitHubLink(repository, suffix) {
    if (!/^https:\/\/github\.com\//i.test(repository)) {
        return '';
    }
    return repository.replace(/\.git$/i, '') + suffix;
}

function expectedTags(packageJson) {
    var tags = new Set(packageJson.keywords || []);
    if (packageJson.contributes &&
        Array.isArray(packageJson.contributes.keybindings) &&
        packageJson.contributes.keybindings.length > 0) {
        tags.add('keybindings');
    }
    (packageJson.activationEvents || []).forEach(function(event) {
        var match = /^onLanguage:(.*)$/.exec(event);
        if (match) {
            tags.add(match[1]);
        }
    });
    if (/\bsql(?!\w)/i.test(packageJson.description || '')) {
        tags.add('sql');
    }
    return Array.from(tags).filter(Boolean).join(',');
}

function expectedProperties(packageJson) {
    var values = [
        ['Microsoft.VisualStudio.Code.Engine', packageJson.engines.vscode],
        ['Microsoft.VisualStudio.Code.ExtensionDependencies',
            canonicalExtensionList(packageJson.extensionDependencies)],
        ['Microsoft.VisualStudio.Code.ExtensionPack',
            canonicalExtensionList(packageJson.extensionPack)],
        ['Microsoft.VisualStudio.Code.ExtensionKind', canonicalExtensionKind(packageJson)],
        ['Microsoft.VisualStudio.Code.LocalizedLanguages',
            packageJson.contributes && Array.isArray(packageJson.contributes.localizations)
                ? packageJson.contributes.localizations.map(function(localization) {
                    return localization.localizedLanguageName ||
                        localization.languageName || localization.languageId;
                }).join(',')
                : ''],
        ['Microsoft.VisualStudio.Code.EnabledApiProposals',
            Array.isArray(packageJson.enabledApiProposals)
                ? packageJson.enabledApiProposals.join(',')
                : '']
    ];
    if (packageJson.main || packageJson.browser) {
        values.push(['Microsoft.VisualStudio.Code.ExecutesCode', 'true']);
    }
    var repository = sourceRepositoryUrl(packageJson);
    if (repository) {
        values.push(['Microsoft.VisualStudio.Services.Links.Source', repository]);
        values.push(['Microsoft.VisualStudio.Services.Links.Getstarted', repository]);
        values.push([
            /^https:\/\/github\.com\//i.test(repository)
                ? 'Microsoft.VisualStudio.Services.Links.GitHub'
                : 'Microsoft.VisualStudio.Services.Links.Repository',
            repository
        ]);
    }
    var bugs = '';
    if (packageJson.bugs && typeof packageJson.bugs === 'object') {
        bugs = packageJson.bugs.url ||
            (packageJson.bugs.email ? 'mailto:' + packageJson.bugs.email : '');
    }
    if (!bugs) {
        bugs = inferredGitHubLink(repository, '/issues');
    }
    if (bugs) {
        values.push(['Microsoft.VisualStudio.Services.Links.Support', bugs]);
    }
    var homepage = packageJson.homepage || inferredGitHubLink(repository, '#readme');
    if (homepage) {
        values.push(['Microsoft.VisualStudio.Services.Links.Learn', homepage]);
    }
    if (packageJson.galleryBanner && packageJson.galleryBanner.color) {
        values.push(['Microsoft.VisualStudio.Services.Branding.Color',
            packageJson.galleryBanner.color]);
    }
    if (packageJson.galleryBanner && packageJson.galleryBanner.theme) {
        values.push(['Microsoft.VisualStudio.Services.Branding.Theme',
            packageJson.galleryBanner.theme]);
    }
    values.push(['Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown',
        String(packageJson.markdown !== 'standard')]);
    values.push(['Microsoft.VisualStudio.Services.Content.Pricing',
        packageJson.pricing || 'Free']);
    return values;
}

function expectedAssets(packageManifest) {
    function entryPath(sourcePath) {
        var matches = packageManifest.vsixPackageFiles.filter(function(entry) {
            return entry.sourcePath === sourcePath;
        });
        assert.strictEqual(matches.length, 1,
            'shared package manifest must map asset ' + sourcePath + ' exactly once');
        return matches[0].entryPath;
    }
    return [
        ['Microsoft.VisualStudio.Code.Manifest', 'extension/package.json'],
        ['Microsoft.VisualStudio.Services.Content.Details', entryPath('README.md')],
        ['Microsoft.VisualStudio.Services.Content.Changelog', entryPath('CHANGELOG.md')],
        ['Microsoft.VisualStudio.Services.Content.License', entryPath('LICENSE.txt')],
        ['Microsoft.VisualStudio.Services.Icons.Default', entryPath('images/icon.png')]
    ];
}

function verifyGeneratedVsixManifest(xml, packageJson, packageManifest) {
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

    var assetProjection = expectedAssets(packageManifest);
    var licensePath = assetProjection[3][1];
    var iconPath = assetProjection[4][1];
    var expectedMetadata = [
        ['DisplayName', {}, packageJson.displayName || packageJson.name],
        ['Description', { 'xml:space': 'preserve' }, packageJson.description || ''],
        ['Tags', {}, expectedTags(packageJson)],
        ['Categories', {}, (packageJson.categories || []).join(',')],
        ['GalleryFlags', {}, packageJson.preview ? 'Public Preview' : 'Public'],
        ['License', {}, licensePath],
        ['Icon', {}, iconPath]
    ];
    assert.deepStrictEqual(parsed.metadataLeaves.map(function(leaf) {
        return [leaf.name, Object.assign({}, leaf.attributes), leaf.text];
    }), expectedMetadata, 'VSIX metadata text and attributes must match the source package');

    assert.deepStrictEqual(parsed.properties.map(function(property) {
        return [property.attributes.Id, property.attributes.Value];
    }), expectedProperties(packageJson),
        'VSIX Properties must match the exact generated semantic projection');

    assert.deepStrictEqual(parsed.assets.map(function(asset) {
        return [asset.attributes.Type, asset.attributes.Path, asset.attributes.Addressable];
    }), assetProjection.map(function(asset) {
        return [asset[0], asset[1], 'true'];
    }), 'VSIX Assets must match the exact shared-package mapping');
}

function verifyPackedSourceFiles(artifactPath, root, packageManifest) {
    var packageJson = packageManifest.packageJson;
    var packedManifest = unzipBuffer(
        artifactPath,
        'extension/package.json'
    );
    var sourceManifest = fs.readFileSync(path.join(root, 'package.json'));
    assert.ok(packedManifest.equals(sourceManifest),
        'packed package manifest bytes must match the source package exactly');
    verifyGeneratedVsixManifest(
        unzipText(artifactPath, 'extension.vsixmanifest'),
        packageJson,
        packageManifest
    );
    verifyGeneratedContentTypes(
        unzipText(artifactPath, '\\[Content_Types\\].xml'),
        packageManifest
    );
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
