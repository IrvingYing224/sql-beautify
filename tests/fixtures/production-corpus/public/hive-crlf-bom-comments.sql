select
`订单编号`, -- 保留中文行注释
case when `城市代码`='HZ' then '杭州' else '其他' end as `城市名称`
from `订单明细`
where `分区日期`='${bizdate}';
