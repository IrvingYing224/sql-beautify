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

function get_sql_formatter_config(vscode, document) {
    var scopedConfig = vscode.workspace.getConfiguration('sqlBeautify');
    var legacyConfig = vscode.workspace.getConfiguration('extension');
    var raw = {
        sqlKeywordCase: scopedConfig.get('keywordCase'),
        sqlCommaStyle: scopedConfig.get('commaStyle'),
        sqlIndentStyle: scopedConfig.get('indentStyle'),
        sqlMaxAlignWidth: scopedConfig.get('maxAlignWidth'),
        sqlCaseWhenThenWrapLength: scopedConfig.get('caseWhenThenWrapLength'),
        sqlDialect: scopedConfig.get('dialect'),
        keywordCase: legacyConfig.get('keywordCase'),
        commaStyle: legacyConfig.get('commaStyle'),
        indentStyle: legacyConfig.get('indentStyle'),
        maxAlignWidth: legacyConfig.get('maxAlignWidth'),
        uppercase: legacyConfig.get('uppercase'),
        comma_location: legacyConfig.get('comma_location'),
        bracket_char: legacyConfig.get('bracket_char'),
        as_loc_cnt: legacyConfig.get('as_loc_cnt'),
        case_when_then_wrap_length: legacyConfig.get('case_when_then_wrap_length'),
        documentLanguageId: get_document_language_id(document)
    };
    var explicit = {
        sqlKeywordCase: has_configured_value(scopedConfig, 'keywordCase'),
        sqlCommaStyle: has_configured_value(scopedConfig, 'commaStyle'),
        sqlIndentStyle: has_configured_value(scopedConfig, 'indentStyle'),
        sqlMaxAlignWidth: has_configured_value(scopedConfig, 'maxAlignWidth'),
        sqlCaseWhenThenWrapLength: has_configured_value(scopedConfig, 'caseWhenThenWrapLength'),
        sqlDialect: has_configured_value(scopedConfig, 'dialect'),
        keywordCase: has_configured_value(legacyConfig, 'keywordCase'),
        commaStyle: has_configured_value(legacyConfig, 'commaStyle'),
        indentStyle: has_configured_value(legacyConfig, 'indentStyle'),
        maxAlignWidth: has_configured_value(legacyConfig, 'maxAlignWidth'),
        languageMode: true
    };

    return sqlRenderOptions.normalize(raw, explicit);
}

exports.get_sql_formatter_config = get_sql_formatter_config;
exports.has_configured_value = has_configured_value;
exports.get_document_language_id = get_document_language_id;
