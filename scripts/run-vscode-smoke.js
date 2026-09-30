#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var test = require('@vscode/test-electron');

async function main() {
    var root = path.resolve(__dirname, '..');
    var cache = path.join(root, '.tmp', 'vscode-smoke');
    fs.mkdirSync(cache, { recursive: true });
    var session = fs.mkdtempSync(path.join(cache, 'session-'));
    var workspace = path.join(session, 'workspace');
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
        'editor.defaultFormatter': 'clarkyu.vscode-sql-beautify',
        'editor.formatOnSave': false,
        'editor.detectIndentation': false,
        'files.autoSave': 'off',
        'sqlBeautify.keywordCase': 'upper',
        'sqlBeautify.indentStyle': 'space',
        '[sql]': {
            'sqlBeautify.keywordCase': 'lower',
            'editor.tabSize': 2,
            'editor.insertSpaces': false
        }
    }, null, 4));
    // Keep logs and isolated profiles in .tmp for failures; never reuse the
    // developer's installed extensions, settings, or workspace files.
    var executable = process.env.SQL_BEAUTIFY_VSCODE_EXECUTABLE;
    await test.runTests({
        version: process.env.SQL_BEAUTIFY_VSCODE_VERSION || 'stable',
        ...(executable ? { vscodeExecutablePath: path.resolve(executable) } : {}),
        cachePath: path.join(cache, 'downloads'),
        extensionDevelopmentPath: root,
        extensionTestsPath: path.join(root, 'tests', 'vscode', 'smoke.js'),
        launchArgs: [workspace, '--disable-extensions', '--disable-gpu',
            '--user-data-dir=' + path.join(session, 'user-data'),
            '--extensions-dir=' + path.join(session, 'extensions')],
        extensionTestsEnv: { SQL_BEAUTIFY_SMOKE_WORKSPACE: workspace }
    });
}

main().catch(function(error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
