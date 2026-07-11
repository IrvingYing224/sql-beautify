import { HiveSQL } from 'dt-sql-parser';

export default function create_hive_parser() {
    return new HiveSQL();
}
