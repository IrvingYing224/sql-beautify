WITH source_orders AS
(
    SELECT  o.user_id
           ,o.order_id
           ,CASE
                WHEN o.city_id IN (
                        1001, -- city one
                        1002  -- city two
                    ) THEN concat_ws(',', o.city_name, o.region_name)
                ELSE
                    'unknown'
            END                                                                                  AS city_label
           ,ROW_NUMBER() OVER(PARTITION BY o.user_id ORDER BY  o.pay_time DESC, o.order_id DESC) AS rn
    FROM dwd_order_detail o
    LEFT JOIN dim_user_profile u
         ON -- user join
            o.user_id = u.user_id
        AND u.ds = '${bizdate}'
    WHERE o.ds = '${bizdate}'
      AND o.status IN (1, 2, 3)
)
SELECT  user_id
       ,order_id
       ,city_label
FROM source_orders
WHERE rn = 1;
