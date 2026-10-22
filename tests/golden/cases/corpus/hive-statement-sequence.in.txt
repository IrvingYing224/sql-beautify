select a,b from source_table where enabled=true;
set hive.exec.dynamic.partition=true;
insert into table target partition (ds=${hiveconf:run_date}) select a,b from source_table;
