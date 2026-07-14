'use strict';

function freezeCase(value) {
    Object.keys(value.expected).forEach(function(key) {
        if (Array.isArray(value.expected[key])) {
            Object.freeze(value.expected[key]);
        }
    });
    Object.freeze(value.expected);
    return Object.freeze(value);
}

module.exports = Object.freeze([
    freezeCase({
        id: 'hive-cte-window-comments',
        dialect: 'hive',
        mode: 'document',
        source: [
            'WITH src AS (',
            'SELECT user_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts DESC) AS rn',
            'FROM fact_orders -- keep FROM',
            "WHERE ds = '2026-07-11'",
            ') SELECT user_id FROM src WHERE rn = 1'
        ].join('\n'),
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['with', 'select', 'from', 'where'],
            relationKinds: ['table'],
            listRoles: ['select-items'],
            commentLeaves: ['-- keep FROM'],
            requiredSlices: ['src', "SELECT user_id FROM src WHERE rn = 1"],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-lateral-view-explode',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT id, item FROM src LATERAL VIEW EXPLODE(items) e AS item',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['select', 'from', 'lateral-view'],
            relationKinds: ['table', 'lateral-view', 'table-function'],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ['src', 'LATERAL VIEW EXPLODE(items) e AS item'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-insert-overwrite-partition',
        dialect: 'hive',
        mode: 'document',
        source: "INSERT OVERWRITE TABLE dst PARTITION (ds='2026-07-11') SELECT id FROM src",
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['insert-query'],
            queryKinds: ['select'],
            clauseKinds: ['insert', 'partition', 'select', 'from'],
            relationKinds: ['table'],
            listRoles: ['partition-columns', 'select-items'],
            commentLeaves: [],
            requiredSlices: ['dst', "PARTITION (ds='2026-07-11')", 'SELECT id FROM src'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-complex-type-ddl',
        dialect: 'hive',
        mode: 'document',
        source: "CREATE TABLE `t(` (`a,b` DECIMAL(18,2) COMMENT 'a  b')",
        expected: {
            outcome: 'statement-preserved',
            statementKinds: ['opaque'],
            queryKinds: [],
            clauseKinds: [],
            relationKinds: [],
            listRoles: [],
            commentLeaves: [],
            requiredSlices: ["CREATE TABLE `t(` (`a,b` DECIMAL(18,2) COMMENT 'a  b')"],
            opaqueSlices: ["CREATE TABLE `t(` (`a,b` DECIMAL(18,2) COMMENT 'a  b')"],
            diagnosticCodes: ['SYN_UNSUPPORTED_STATEMENT']
        }
    }),
    freezeCase({
        id: 'hive-no-from-functions',
        dialect: 'hive',
        mode: 'document',
        source: "SELECT ARRAY('a','b'), MAP('x', 1), NAMED_STRUCT('k', 2)",
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['select'],
            relationKinds: [],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ["ARRAY('a','b')", "MAP('x', 1)", "NAMED_STRUCT('k', 2)"],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-literal-first-nested-query',
        dialect: 'hive',
        mode: 'document',
        source: "WITH x AS (SELECT 'literal' AS c) SELECT c FROM x",
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['with', 'select', 'from'],
            relationKinds: ['table'],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ['x', "SELECT 'literal' AS c", 'SELECT c FROM x'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-case-and-subquery-expression',
        dialect: 'hive',
        mode: 'document',
        source: "SELECT CASE WHEN id IN (SELECT id FROM dim) THEN 'y' ELSE 'n' END AS flag FROM src",
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['select', 'from'],
            relationKinds: ['table'],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ["CASE WHEN id IN (SELECT id FROM dim) THEN 'y' ELSE 'n' END", 'src'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-cluster-distribute-sort',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT id FROM src CLUSTER BY id DISTRIBUTE BY id SORT BY ts DESC LIMIT 20',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['select', 'from', 'cluster-by', 'distribute-by', 'sort-by', 'limit'],
            relationKinds: ['table'],
            listRoles: ['select-items', 'cluster-by-items', 'distribute-by-items', 'sort-by-items'],
            commentLeaves: [],
            requiredSlices: ['CLUSTER BY id', 'DISTRIBUTE BY id', 'SORT BY ts DESC', 'LIMIT 20'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-template-substitution',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT id FROM ${db}.src WHERE ds = ${hivevar:day}',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['select', 'from', 'where'],
            relationKinds: ['table'],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ['${db}.src', 'ds = ${hivevar:day}'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-multi-statement-empty',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT 1;; SELECT 2;',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query', 'empty', 'query'],
            queryKinds: ['select'],
            clauseKinds: ['select'],
            relationKinds: [],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ['SELECT 1', ';', 'SELECT 2'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-set-operations',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT id FROM a UNION ALL SELECT id FROM b INTERSECT SELECT id FROM c',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['set', 'select'],
            clauseKinds: ['select', 'from', 'set-operation'],
            relationKinds: ['table'],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ['UNION ALL', 'INTERSECT', 'SELECT id FROM b'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-nested-cte',
        dialect: 'hive',
        mode: 'document',
        source: 'WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) SELECT * FROM a',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['with', 'select', 'from'],
            relationKinds: ['table'],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ['a', 'b', 'WITH b AS (SELECT 1) SELECT * FROM b'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-join-subquery',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT a.id FROM a LEFT OUTER JOIN (SELECT id FROM b) q ON a.id = q.id WHERE q.id > 0',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select', 'parenthesized'],
            clauseKinds: ['select', 'from', 'join-on', 'where'],
            relationKinds: ['table', 'join', 'subquery'],
            listRoles: ['select-items'],
            commentLeaves: [],
            requiredSlices: ['LEFT OUTER JOIN (SELECT id FROM b) q ON a.id = q.id', '(SELECT id FROM b) q'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-lateral-view-outer-posexplode',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT id, pos, item FROM src LATERAL VIEW OUTER POSEXPLODE(items) p AS pos, item',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['select', 'from', 'lateral-view'],
            relationKinds: ['table', 'lateral-view', 'table-function'],
            listRoles: ['select-items', 'other'],
            commentLeaves: [],
            requiredSlices: ['POSEXPLODE(items)', 'pos, item'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-group-having-window-order',
        dialect: 'hive',
        mode: 'document',
        source: 'SELECT k, count(*) c FROM t WHERE x > 0 GROUP BY k HAVING count(*) > 1 WINDOW w AS (PARTITION BY k) ORDER BY c DESC',
        expected: {
            outcome: 'fully-structured',
            statementKinds: ['query'],
            queryKinds: ['select'],
            clauseKinds: ['select', 'from', 'where', 'group-by', 'having', 'window', 'order-by'],
            relationKinds: ['table'],
            listRoles: ['select-items', 'group-by-items', 'order-by-items', 'other'],
            commentLeaves: [],
            requiredSlices: ['GROUP BY k', 'WINDOW w AS (PARTITION BY k)', 'ORDER BY c DESC'],
            opaqueSlices: [],
            diagnosticCodes: []
        }
    }),
    freezeCase({
        id: 'hive-unsupported-merge',
        dialect: 'hive',
        mode: 'document',
        source: 'MERGE INTO dst USING src ON dst.id = src.id WHEN MATCHED THEN UPDATE SET x = 1',
        expected: {
            outcome: 'statement-preserved',
            statementKinds: ['opaque'],
            queryKinds: [],
            clauseKinds: [],
            relationKinds: [],
            listRoles: [],
            commentLeaves: [],
            requiredSlices: ['MERGE INTO dst USING src ON dst.id = src.id WHEN MATCHED THEN UPDATE SET x = 1'],
            opaqueSlices: ['MERGE INTO dst USING src ON dst.id = src.id WHEN MATCHED THEN UPDATE SET x = 1'],
            diagnosticCodes: ['SYN_UNSUPPORTED_STATEMENT']
        }
    }),
    freezeCase({
        id: 'hive-unterminated-string',
        dialect: 'hive',
        mode: 'document',
        source: "SELECT 'unterminated FROM t",
        expected: {
            outcome: 'target-preserved',
            statementKinds: ['opaque'],
            queryKinds: [],
            clauseKinds: [],
            relationKinds: [],
            listRoles: [],
            commentLeaves: [],
            requiredSlices: ["SELECT 'unterminated FROM t"],
            opaqueSlices: ["SELECT 'unterminated FROM t"],
            diagnosticCodes: ['SYN_UNEXPECTED_TOKEN', 'LEX_UNTERMINATED_STRING']
        }
    })
]);
