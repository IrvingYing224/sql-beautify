set hive.exec.dynamic.partition=true;
insert into table warehouse.daily_orders partition (ds='${bizdate}')
select order_id, city_code from staging.orders;
