var sqlRenderOptions = require('./sql-render-options');

function get_document_language_id(document) {
    return document && document.languageId ? document.languageId : 'sql';
}

function has_configured_value(config, key) {
    if (!config.inspect) {
        return false;
    }

    var inspected = config.inspect(key);
    if (!inspected) {
        return false;
    }

    return typeof inspected.globalValue !== 'undefined'
        || typeof inspected.workspaceValue !== 'undefined'
        || typeof inspected.workspaceFolderValue !== 'undefined'
        || typeof inspected.globalLanguageValue !== 'undefined'
        || typeof inspected.workspaceLanguageValue !== 'undefined'
        || typeof inspected.workspaceFolderLanguageValue !== 'undefined';
}

function get_sql_formatter_config(vscode, document, formatting_options) {
    var scopedConfig = vscode.workspace.getConfiguration('sqlBeautify', document && document.uri);
    var raw = {
        keywordCase: scopedConfig.get('keywordCase'),
        commaStyle: scopedConfig.get('commaStyle'),
        indentStyle: scopedConfig.get('indentStyle'),
        maxAlignWidth: scopedConfig.get('maxAlignWidth'),
        caseWhenThenWrapLength: scopedConfig.get('caseWhenThenWrapLength'),
        caseLayout: scopedConfig.get('caseLayout'),
        dialect: scopedConfig.get('dialect'),
        unsupportedSyntaxPolicy: scopedConfig.get('unsupportedSyntaxPolicy'),
        documentLanguageId: get_document_language_id(document)
    };
    var explicit = {
        keywordCase: has_configured_value(scopedConfig, 'keywordCase'),
        commaStyle: has_configured_value(scopedConfig, 'commaStyle'),
        indentStyle: has_configured_value(scopedConfig, 'indentStyle'),
        maxAlignWidth: has_configured_value(scopedConfig, 'maxAlignWidth'),
        caseWhenThenWrapLength: has_configured_value(scopedConfig, 'caseWhenThenWrapLength'),
        caseLayout: has_configured_value(scopedConfig, 'caseLayout'),
        dialect: has_configured_value(scopedConfig, 'dialect'),
        unsupportedSyntaxPolicy: has_configured_value(scopedConfig, 'unsupportedSyntaxPolicy'),
        languageMode: true
    };

    if (!explicit.indentStyle && formatting_options && typeof formatting_options.insertSpaces == 'boolean') {
        raw.indentStyle = formatting_options.insertSpaces ? 'space' : 'tab';
        explicit.indentStyle = true;
    }

    return sqlRenderOptions.normalize(raw, explicit);
}

exports.get_sql_formatter_config = get_sql_formatter_config;
exports.has_configured_value = has_configured_value;
exports.get_document_language_id = get_document_language_id;
