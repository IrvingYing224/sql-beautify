UPDATE ads_daily_orders SET user_id='masked' WHERE ds='${bizdate}' AND user_id IS NULL;
