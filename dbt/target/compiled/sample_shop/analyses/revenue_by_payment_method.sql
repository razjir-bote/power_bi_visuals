select
    payment_method,
    count(*) as payment_count,
    sum(amount) as total_amount
from "sample_shop"."staging"."stg_payments"
group by payment_method
order by total_amount desc