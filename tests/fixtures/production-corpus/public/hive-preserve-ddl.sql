CREATE TABLE IF NOT EXISTS ads_daily_orders (order_id string, user_id string) PARTITIONED BY (ds string) STORED AS ORC;
