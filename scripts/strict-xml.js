#!/usr/bin/env node
'use strict';

var assert = require('assert');

var XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';

function isWhitespace(character) {
    return character === ' ' || character === '\t' ||
        character === '\n' || character === '\r';
}

function isNameStart(character) {
    return character !== undefined && /[A-Za-z_:]/.test(character);
}

function isNameContinue(character) {
    return character !== undefined && /[A-Za-z0-9_.:-]/.test(character);
}

function isXmlCodePoint(codePoint) {
    return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function decodeEntity(entity) {
    var named = Object.freeze({
        apos: "'",
        quot: '"',
        lt: '<',
        gt: '>',
        amp: '&'
    });
    if (Object.prototype.hasOwnProperty.call(named, entity)) {
        return named[entity];
    }
    var codePoint = null;
    if (/^#[0-9]+$/.test(entity)) {
        codePoint = Number(entity.slice(1));
    } else if (/^#x[0-9a-f]+$/i.test(entity)) {
        codePoint = Number.parseInt(entity.slice(2), 16);
    }
    assert.ok(Number.isInteger(codePoint) && isXmlCodePoint(codePoint),
        'XML attribute contains an invalid entity: &' + entity + ';');
    return String.fromCodePoint(codePoint);
}

function decodeAttribute(raw) {
    assert.strictEqual(raw.indexOf('<'), -1,
        'XML attribute values must not contain an unescaped <');
    var output = '';
    var cursor = 0;
    while (cursor < raw.length) {
        var ampersand = raw.indexOf('&', cursor);
        if (ampersand < 0) {
            output += raw.slice(cursor);
            break;
        }
        output += raw.slice(cursor, ampersand);
        var semicolon = raw.indexOf(';', ampersand + 1);
        assert.ok(semicolon > ampersand + 1,
            'XML attribute contains an unterminated entity');
        output += decodeEntity(raw.slice(ampersand + 1, semicolon));
        cursor = semicolon + 1;
    }
    return output;
}

function assertXmlCharacters(value) {
    for (var index = 0; index < value.length;) {
        var codePoint = value.codePointAt(index);
        assert.ok(codePoint !== undefined && isXmlCodePoint(codePoint),
            'XML contains a forbidden code point at offset ' + index);
        index += codePoint > 0xffff ? 2 : 1;
    }
}

function freezeNode(node) {
    node.children.forEach(freezeNode);
    Object.freeze(node.attributes);
    Object.freeze(node.children);
    Object.freeze(node);
}

function parseStrictXml(xml) {
    if (typeof xml !== 'string') {
        throw new TypeError('XML input must be a string');
    }
    assertXmlCharacters(xml);
    assert.ok(xml.startsWith(XML_DECLARATION),
        'XML must start with the canonical declaration');
    var cursor = XML_DECLARATION.length;
    var stack = [];
    var root = null;

    function skipWhitespace() {
        var start = cursor;
        while (cursor < xml.length && isWhitespace(xml[cursor])) {
            cursor += 1;
        }
        return cursor - start;
    }

    function readName(label) {
        assert.ok(isNameStart(xml[cursor]), label + ' must start with an XML name');
        var start = cursor;
        cursor += 1;
        while (cursor < xml.length && isNameContinue(xml[cursor])) {
            cursor += 1;
        }
        return xml.slice(start, cursor);
    }

    function parseAttributes(elementName) {
        var attributes = Object.create(null);
        var selfClosing = false;
        while (cursor < xml.length) {
            var whitespace = skipWhitespace();
            if (xml.startsWith('/>', cursor)) {
                cursor += 2;
                selfClosing = true;
                break;
            }
            if (xml[cursor] === '>') {
                cursor += 1;
                break;
            }
            assert.ok(whitespace > 0,
                elementName + ' attributes must be whitespace-separated');
            var name = readName(elementName + ' attribute');
            assert.strictEqual(
                Object.prototype.hasOwnProperty.call(attributes, name),
                false,
                elementName + ' must not repeat attribute ' + name
            );
            skipWhitespace();
            assert.strictEqual(xml[cursor], '=',
                elementName + ' attribute ' + name + ' must have =');
            cursor += 1;
            skipWhitespace();
            var quote = xml[cursor];
            assert.ok(quote === '"' || quote === "'",
                elementName + ' attribute ' + name + ' must be quoted');
            cursor += 1;
            var valueStart = cursor;
            while (cursor < xml.length && xml[cursor] !== quote) {
                cursor += 1;
            }
            assert.ok(cursor < xml.length,
                elementName + ' attribute ' + name + ' is unterminated');
            attributes[name] = decodeAttribute(xml.slice(valueStart, cursor));
            cursor += 1;
        }
        assert.ok(cursor <= xml.length,
            elementName + ' must terminate before end of XML');
        return { attributes: attributes, selfClosing: selfClosing };
    }

    function appendNode(node) {
        if (stack.length === 0) {
            assert.strictEqual(root, null, 'XML must contain exactly one root element');
            root = node;
        } else {
            stack[stack.length - 1].children.push(node);
        }
        if (!node.selfClosing) {
            stack.push(node);
        }
    }

    while (cursor < xml.length) {
        if (xml[cursor] !== '<') {
            var textEnd = xml.indexOf('<', cursor);
            if (textEnd < 0) {
                textEnd = xml.length;
            }
            var text = xml.slice(cursor, textEnd);
            assert.strictEqual(text.indexOf(']]>'), -1,
                'XML text must not contain the CDATA closing delimiter');
            decodeAttribute(text);
            if (stack.length === 0) {
                assert.strictEqual(text.trim(), '',
                    'XML must not contain text outside the root');
            }
            cursor = textEnd;
            continue;
        }
        if (xml.startsWith('<!--', cursor) ||
            xml.startsWith('<![CDATA[', cursor) ||
            /^<!DOCTYPE\b/i.test(xml.slice(cursor)) ||
            xml.startsWith('<!', cursor)) {
            throw new Error('XML comments, CDATA, DOCTYPE, and declarations are forbidden');
        }
        if (xml.startsWith('<?', cursor)) {
            throw new Error('XML processing instructions are forbidden after the declaration');
        }
        if (xml.startsWith('</', cursor)) {
            cursor += 2;
            var closingName = readName('closing tag');
            skipWhitespace();
            assert.strictEqual(xml[cursor], '>',
                'XML closing tag must terminate with >');
            cursor += 1;
            assert.ok(stack.length > 0, 'XML contains an unexpected closing tag');
            assert.strictEqual(stack[stack.length - 1].name, closingName,
                'XML closing tag must match the current element');
            stack.pop();
            continue;
        }
        cursor += 1;
        var elementName = readName('opening tag');
        var details = parseAttributes(elementName);
        appendNode({
            name: elementName,
            attributes: details.attributes,
            children: [],
            selfClosing: details.selfClosing
        });
    }

    assert.strictEqual(stack.length, 0, 'XML contains an unclosed element');
    assert.notStrictEqual(root, null, 'XML must contain one root element');
    freezeNode(root);
    return root;
}

module.exports = Object.freeze({ parseStrictXml: parseStrictXml });
