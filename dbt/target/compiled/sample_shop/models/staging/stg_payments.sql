

with source as (

    select * from "sample_shop"."raw"."raw_payments"

),

renamed as (

    select
        id as payment_id,
        order_id,
        payment_method,
        
    round(cast(amount as decimal(18, 4)) / 100, 2)
 as amount
    from source

)

select * from renamed