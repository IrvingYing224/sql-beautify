function object_lookup(object, key) {
    return object && Object.prototype.hasOwnProperty.call(object, String(key))
        ? object[String(key)]
        : null;
}

function token_by_id(document, tokenId) {
    return object_lookup(document && document.tokenById, tokenId);
}

function token_by_index(document, tokenIndex) {
    return object_lookup(document && document.tokenByIndex, tokenIndex);
}

function line_by_index(document, lineIndex) {
    return object_lookup(document && document.lineByIndex, lineIndex);
}

function active_tokens(document) {
    return document && document.codeTokens ? document.codeTokens : [];
}

function code_position(document, token) {
    if (!document || !token || !document.codeTokenPositionByIndex) {
        return -1;
    }
    var value = document.codeTokenPositionByIndex[String(token.index)];
    return typeof value == 'number' ? value : -1;
}

function previous_code_token(document, token) {
    var tokens = active_tokens(document);
    var position = code_position(document, token);
    return position > 0 ? tokens[position - 1] : null;
}

function next_code_token(document, token) {
    var tokens = active_tokens(document);
    var position = code_position(document, token);
    return position >= 0 && position + 1 < tokens.length ? tokens[position + 1] : null;
}

function attach_scope_index(document) {
    var scopeById = {};
    var scopes = document && document.scopes ? document.scopes : [];

    for (var i = 0; i < scopes.length; i++) {
        scopeById[String(scopes[i].id)] = scopes[i];
    }

    if (document) {
        document.scopeById = scopeById;
    }
    return document;
}

function scope_by_id(document, scopeId) {
    return object_lookup(document && document.scopeById, scopeId);
}

function scope_by_id_from_list(scopes, scopeId) {
    for (var i = 0; i < (scopes || []).length; i++) {
        if (scopes[i].id == scopeId) {
            return scopes[i];
        }
    }
    return null;
}

exports.token_by_id = token_by_id;
exports.token_by_index = token_by_index;
exports.line_by_index = line_by_index;
exports.active_tokens = active_tokens;
exports.previous_code_token = previous_code_token;
exports.next_code_token = next_code_token;
exports.attach_scope_index = attach_scope_index;
exports.scope_by_id = scope_by_id;
exports.scope_by_id_from_list = scope_by_id_from_list;
