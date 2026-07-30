#!/usr/bin/env node
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var LOCK_STALE_MS = 10 * 60 * 1000;

function token() {
    return process.pid + '-' + crypto.randomBytes(8).toString('hex');
}

function processIsAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code === 'EPERM';
    }
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function acquireProjectLock(lockPath, label) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    var ownerToken = token();
    var owner = Object.freeze({
        schemaVersion: 1,
        pid: process.pid,
        token: ownerToken,
        acquiredAt: new Date().toISOString(),
        label: label
    });
    for (var attempt = 0; attempt < 2; attempt++) {
        try {
            var descriptor = fs.openSync(lockPath, 'wx', 0o600);
            try {
                fs.writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8');
            } finally {
                fs.closeSync(descriptor);
            }
            return Object.freeze({
                release: function() {
                    var current = readJson(lockPath);
                    if (current !== null && current.token === ownerToken) {
                        fs.rmSync(lockPath, { force: true });
                    }
                }
            });
        } catch (error) {
            if (!error || error.code !== 'EEXIST') {
                throw error;
            }
            var existing = readJson(lockPath);
            var stale = existing === null
                ? (function() {
                    try {
                        return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
                    } catch {
                        return false;
                    }
                })()
                : !processIsAlive(existing.pid);
            if (stale && attempt === 0) {
                fs.rmSync(lockPath, { force: true });
                continue;
            }
            throw new Error(
                label + ' is already running' +
                (existing && existing.pid ? ' (pid ' + existing.pid + ')' : '') +
                '; builds sharing .tmp/dist must run serially'
            );
        }
    }
    throw new Error(label + ' could not acquire its project-local lock');
}

function walkFiles(directory) {
    var files = [];
    var work = [directory];
    while (work.length > 0) {
        var current = work.pop();
        fs.readdirSync(current, { withFileTypes: true })
            .sort(function(left, right) {
                return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
            })
            .forEach(function(entry) {
                var child = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    work.push(child);
                } else if (entry.isFile()) {
                    files.push(child);
                } else {
                    throw new Error('Build input must be a regular file: ' + child);
                }
            });
    }
    return files.sort();
}

function contentHash(root, inputs, metadata) {
    var hash = crypto.createHash('sha256');
    var files = [];
    inputs.forEach(function(input) {
        var absolute = path.join(root, input);
        if (fs.statSync(absolute).isDirectory()) {
            files = files.concat(walkFiles(absolute));
        } else {
            files.push(absolute);
        }
    });
    files.sort().forEach(function(filePath) {
        var relative = path.relative(root, filePath).split(path.sep).join('/');
        var bytes = fs.readFileSync(filePath);
        hash.update(String(Buffer.byteLength(relative)) + ':');
        hash.update(relative);
        hash.update(String(bytes.length) + ':');
        hash.update(bytes);
    });
    hash.update(JSON.stringify(metadata || {}));
    return hash.digest('hex');
}

function outputManifest(directory, excludedPaths) {
    var excluded = new Set(excludedPaths || []);
    if (!fs.statSync(directory).isDirectory()) {
        throw new Error('Build output must be a directory: ' + directory);
    }
    return walkFiles(directory).map(function(filePath) {
        var relative = path.relative(directory, filePath).split(path.sep).join('/');
        return { filePath: filePath, relative: relative };
    }).filter(function(output) {
        return !excluded.has(output.relative);
    }).map(function(output) {
        var bytes = fs.readFileSync(output.filePath);
        return Object.freeze({
            path: output.relative,
            size: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        });
    });
}

function validManifestEntry(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).sort().join(',') !== 'path,sha256,size' ||
        typeof entry.path !== 'string' || entry.path.length === 0 ||
        entry.path.indexOf('\\') >= 0 || path.posix.isAbsolute(entry.path) ||
        path.posix.normalize(entry.path) !== entry.path ||
        entry.path.split('/').some(function(part) { return part === '..' || part === '.'; }) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        return false;
    }
    return true;
}

function validateOutputManifest(directory, manifest, excludedPaths) {
    if (!Array.isArray(manifest) || manifest.length === 0) {
        return false;
    }
    for (var index = 0; index < manifest.length; index++) {
        if (!validManifestEntry(manifest[index]) ||
            (index > 0 && manifest[index - 1].path >= manifest[index].path)) {
            return false;
        }
    }
    var actual = outputManifest(directory, excludedPaths);
    return JSON.stringify(actual) === JSON.stringify(manifest);
}

function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    var temporary = filePath + '.tmp-' + token();
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 4) + '\n', 'utf8');
        fs.renameSync(temporary, filePath);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function recoverDirectorySwap(currentPath, previousPath) {
    if (!fs.existsSync(currentPath) && fs.existsSync(previousPath)) {
        fs.renameSync(previousPath, currentPath);
        return;
    }
    if (fs.existsSync(currentPath) && fs.existsSync(previousPath)) {
        fs.rmSync(previousPath, { recursive: true, force: true });
    }
}

function publishDirectory(stagingPath, currentPath, previousPath) {
    if (!fs.statSync(stagingPath).isDirectory()) {
        throw new Error('Build staging output is not a directory: ' + stagingPath);
    }
    recoverDirectorySwap(currentPath, previousPath);
    var movedCurrent = false;
    try {
        if (fs.existsSync(currentPath)) {
            fs.renameSync(currentPath, previousPath);
            movedCurrent = true;
        }
        fs.renameSync(stagingPath, currentPath);
    } catch (error) {
        if (!fs.existsSync(currentPath) && movedCurrent && fs.existsSync(previousPath)) {
            fs.renameSync(previousPath, currentPath);
        }
        throw error;
    }
    if (movedCurrent) {
        try {
            fs.rmSync(previousPath, { recursive: true, force: true });
        } catch (error) {
            console.warn('Published a complete build but could not remove ' +
                previousPath + ': ' + String(error));
        }
    }
}

function testHoldMilliseconds(environmentKey) {
    var raw = process.env[environmentKey];
    if (raw === undefined) {
        return;
    }
    var milliseconds = Number(raw);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 10000) {
        throw new Error(environmentKey + ' must be an integer from 0 through 10000');
    }
    if (milliseconds > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
}

module.exports = Object.freeze({
    acquireProjectLock: acquireProjectLock,
    contentHash: contentHash,
    outputManifest: outputManifest,
    publishDirectory: publishDirectory,
    readJson: readJson,
    recoverDirectorySwap: recoverDirectorySwap,
    testHoldMilliseconds: testHoldMilliseconds,
    token: token,
    validateOutputManifest: validateOutputManifest,
    writeJsonAtomic: writeJsonAtomic
});
