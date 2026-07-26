select
account_id, -- account identifier
gross_amount, -- trailing comma must remain attached to this item
from daily_account_summary
where ds='${bizdate}';
