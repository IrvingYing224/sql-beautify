create table audit_events (event_id bigint,event_name string) partitioned by (ds string,region string) stored as orc;
