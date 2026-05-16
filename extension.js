var vscode = require('vscode');
var vscodeExtension = require('./lib/adapters/vscode-extension');

var extension = vscodeExtension.create_extension(vscode);

exports.activate = extension.activate;
exports.deactivate = extension.deactivate;
