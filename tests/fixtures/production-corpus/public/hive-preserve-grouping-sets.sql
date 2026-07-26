SELECT region, city, count(*) AS order_count FROM dwd_orders GROUP BY region, city GROUPING SETS ((region,city),(region),());
