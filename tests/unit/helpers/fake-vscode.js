'use strict';

// A small in-memory VS Code host. `load()` requires dist/extension.cjs against it, so host tests
// exercise the shipped bundle through the same API surface VS Code offers.

var Module = require('module');
var path = require('path');

var root = path.join(__dirname, '..', '..', '..');
var current = null;

function Position(line, character) {
    this.line = line;
    this.character = character;
}

function Range(start, end) {
    this.start = start;
    this.end = end;
}

function Selection(anchor, active) {
    var forward = anchor.line < active.line ||
        (anchor.line === active.line && anchor.character <= active.character);
    Range.call(this, forward ? anchor : active, forward ? active : anchor);
    this.anchor = anchor;
    this.active = active;
    this.isEmpty = anchor.line === active.line && anchor.character === active.character;
}

function Diagnostic(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
}

function lineStarts(text) {
    var starts = [0];
    var ends = [];
    for (var index = 0; index < text.length; index++) {
        var code = text.charCodeAt(index);
        if (code === 13 || code === 10) {
            ends.push(index);
            if (code === 13 && text.charCodeAt(index + 1) === 10) {
                index += 1;
            }
            starts.push(index + 1);
        }
    }
    ends.push(text.length);
    return { starts: starts, ends: ends };
}

// Line breaks are CRLF, CR or LF; an offset inside CRLF resolves to the end of its line, as in VS Code.
function Document(text, options) {
    options = options || {};
    this.text = text;
    this.version = 1;
    this.languageId = options.languageId || 'sql';
    this.eol = options.eol || (text.indexOf('\r\n') >= 0 ? 2 : 1);
    this.isClosed = false;
    this.uri = { value: options.uri || 'untitled:test.sql', toString: function() { return this.value; } };
}

Document.prototype.getText = function(range) {
    return range === undefined ? this.text : this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
};

Document.prototype.positionAt = function(offset) {
    var lines = lineStarts(this.text);
    var value = Math.max(0, Math.min(offset, this.text.length));
    var line = 0;
    while (line + 1 < lines.starts.length && lines.starts[line + 1] <= value) {
        line += 1;
    }
    return new Position(line, Math.min(value, lines.ends[line]) - lines.starts[line]);
};

Document.prototype.offsetAt = function(position) {
    var lines = lineStarts(this.text);
    var line = Math.max(0, Math.min(position.line, lines.starts.length - 1));
    return Math.min(lines.starts[line] + position.character, lines.ends[line]);
};

Document.prototype.at = function(anchor, active) {
    return new Selection(this.positionAt(anchor), this.positionAt(active === undefined ? anchor : active));
};

function Editor(host, document, selections) {
    this.host = host;
    this.document = document;
    this.selections = selections || [document.at(0)];
    this.options = { tabSize: 4, insertSpaces: true };
    this.editCalls = 0;
    this.editResult = true;
}

Object.defineProperty(Editor.prototype, 'selection', {
    get: function() { return this.selections[0]; }
});

// Applies all replacements at once (offsets refer to the text before the edit), like editor.edit.
Editor.prototype.edit = function(callback) {
    var document = this.document;
    var replacements = [];
    callback({
        replace: function(range, text) {
            replacements.push({ start: document.offsetAt(range.start), end: document.offsetAt(range.end), text: text });
        }
    });
    this.editCalls += 1;
    if (this.editResult !== true) {
        return typeof this.editResult === 'function' ? this.editResult() : Promise.resolve(this.editResult);
    }
    this.host.replace(document, replacements);
    return Promise.resolve(true);
};

function token() {
    var listeners = [];
    return {
        isCancellationRequested: false,
        onCancellationRequested: function(listener) {
            listeners.push(listener);
            return { dispose: function() { listeners = listeners.filter(function(value) { return value !== listener; }); } };
        },
        cancel: function() {
            this.isCancellationRequested = true;
            listeners.slice().forEach(function(listener) { listener(); });
        },
        listeners: function() { return listeners.length; }
    };
}

function createHost(options) {
    options = options || {};
    var host = {
        commands: Object.create(null),
        documentProvider: null,
        rangeProvider: null,
        diagnostics: new Map(),
        diagnosticWrites: 0,
        messages: [],
        clipboard: '',
        progressToken: null,
        configuration: Object.assign({}, options.configuration),
        configurationScopes: [],
        selectors: [],
        collectionNames: [],
        entry: options.entry || path.join(root, 'dist', 'extension.cjs'),
        changeListeners: [],
        closeListeners: [],
        subscriptions: [],
        activeTextEditor: undefined
    };

    function remove(list, value) {
        var index = list.indexOf(value);
        if (index >= 0) {
            list.splice(index, 1);
        }
    }

    function message(kind) {
        return function(text) {
            host.messages.push({ kind: kind, text: text });
            return Promise.resolve(undefined);
        };
    }

    host.vscode = {
        Position: Position,
        Range: Range,
        Selection: Selection,
        Diagnostic: Diagnostic,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        EndOfLine: { LF: 1, CRLF: 2 },
        ProgressLocation: { Notification: 15 },
        TextEdit: {
            replace: function(range, newText) { return { range: range, newText: newText }; }
        },
        env: {
            language: options.language || 'en',
            clipboard: { writeText: function(value) { host.clipboard = value; return Promise.resolve(); } }
        },
        workspace: {
            getConfiguration: function(section, scope) {
                host.configurationScopes.push([section, scope.languageId, scope.uri.toString()]);
                return {
                    get: function(key) {
                        var value = host.configuration[section + '.' + key];
                        return typeof value === 'function' ? value() : value;
                    }
                };
            },
            onDidChangeTextDocument: function(listener) {
                host.changeListeners.push(listener);
                return { dispose: function() { remove(host.changeListeners, listener); } };
            },
            onDidCloseTextDocument: function(listener) {
                host.closeListeners.push(listener);
                return { dispose: function() { remove(host.closeListeners, listener); } };
            },
            onDidChangeConfiguration: function() {
                return { dispose: function() {} };
            }
        },
        window: {
            get activeTextEditor() { return host.activeTextEditor; },
            showInformationMessage: message('info'),
            showWarningMessage: message('warning'),
            showErrorMessage: message('error'),
            withProgress: function(_options, task) {
                var progressToken = host.progressToken || token();
                host.progressToken = null;
                return task({ report: function() {} }, progressToken);
            }
        },
        languages: {
            createDiagnosticCollection: function(name) {
                host.collectionNames.push(name);
                return {
                    set: function(uri, values) {
                        host.diagnosticWrites += 1;
                        host.diagnostics.set(uri.toString(), values);
                    },
                    delete: function(uri) {
                        host.diagnosticWrites += 1;
                        host.diagnostics.delete(uri.toString());
                    },
                    clear: function() { host.diagnostics.clear(); },
                    dispose: function() { host.diagnostics.clear(); }
                };
            },
            registerDocumentFormattingEditProvider: function(selector, provider) {
                host.selectors.push(selector);
                host.documentProvider = provider;
                return { dispose: function() { host.documentProvider = null; } };
            },
            registerDocumentRangeFormattingEditProvider: function(selector, provider) {
                host.selectors.push(selector);
                host.rangeProvider = provider;
                return { dispose: function() { host.rangeProvider = null; } };
            }
        },
        commands: {
            registerCommand: function(id, handler) {
                host.commands[id] = handler;
                return { dispose: function() { delete host.commands[id]; } };
            }
        }
    };

    host.open = function(text, documentOptions, selections) {
        var document = new Document(text, documentOptions);
        var editor = new Editor(host, document);
        if (selections !== undefined) {
            editor.selections = selections.map(function(value) {
                return Array.isArray(value) ? document.at(value[0], value[1]) : document.at(value);
            });
        }
        host.activeTextEditor = editor;
        return editor;
    };

    // Replaces text (offsets in the current text), bumps the version and fires the change event.
    host.replace = function(document, replacements) {
        replacements.slice().sort(function(a, b) { return b.start - a.start; }).forEach(function(item) {
            document.text = document.text.slice(0, item.start) + item.text + document.text.slice(item.end);
        });
        document.version += 1;
        host.fireChange(document, replacements.map(function(item) {
            return { rangeOffset: item.start, rangeLength: item.end - item.start, text: item.text };
        }));
    };

    host.fireChange = function(document, contentChanges) {
        host.changeListeners.slice().forEach(function(listener) {
            listener({ document: document, contentChanges: contentChanges });
        });
    };

    host.close = function(document) {
        document.isClosed = true;
        host.closeListeners.slice().forEach(function(listener) { listener(document); });
    };

    host.applyEdits = function(document, edits) {
        host.replace(document, edits.map(function(edit) {
            return { start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText };
        }));
    };

    host.diagnosticCodes = function(document) {
        return (host.diagnostics.get(document.uri.toString()) || []).map(function(item) { return item.code; });
    };

    host.lastMessage = function() {
        return host.messages[host.messages.length - 1] || null;
    };

    host.formatDocument = function(document, formattingOptions, cancellation) {
        return host.documentProvider.provideDocumentFormattingEdits(
            document, formattingOptions || { tabSize: 4, insertSpaces: true }, cancellation || token());
    };

    host.formatRanges = function(document, ranges, formattingOptions, cancellation) {
        return host.rangeProvider.provideDocumentRangesFormattingEdits(document, ranges.map(function(value) {
            return new Range(document.positionAt(value[0]), document.positionAt(value[1]));
        }), formattingOptions || { tabSize: 4, insertSpaces: true }, cancellation || token());
    };

    host.run = function(command) {
        var args = Array.prototype.slice.call(arguments, 1);
        return host.commands['sqlBeautify.' + command].apply(null, args);
    };

    return host;
}

// Loads a fresh copy of dist/extension.cjs (or `options.entry`) bound to `host` and activates it.
async function load(host) {
    var entry = require.resolve(host.entry);
    delete require.cache[entry];
    current = host;
    var extension = require(entry);
    await extension.activate({
        subscriptions: host.subscriptions,
        extension: { packageJSON: require(path.join(root, 'package.json')) }
    });
    host.extension = extension;
    return host;
}

var originalLoad = Module._load;
Module._load = function(request) {
    if (request === 'vscode') {
        if (current === null) {
            throw new Error('fake vscode requested before load()');
        }
        return current.vscode;
    }
    return originalLoad.apply(this, arguments);
};

async function withHost(options, body) {
    var host = await load(createHost(options));
    try {
        return await body(host);
    } finally {
        await host.extension.deactivate();
    }
}

module.exports = { createHost: createHost, load: load, withHost: withHost, token: token, Position: Position };
