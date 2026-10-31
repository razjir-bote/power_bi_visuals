
  
  create view "sample_shop"."staging"."stg_orders__dbt_tmp" as (
    with source as (

    select * from "sample_shop"."raw"."raw_orders"

),

renamed as (

    select
        id as order_id,
        user_id as customer_id,
        cast(order_date as date) as order_date,
        status
    from source

)

select * from renamed
  );
