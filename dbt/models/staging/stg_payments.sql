{{ config(meta={'source_system': 'payment_gateway', 'contains_pii': false}) }}

with source as (

    select * from {{ ref('raw_payments') }}

),

renamed as (

    select
        id as payment_id,
        order_id,
        payment_method,
        {{ cents_to_dollars('amount') }} as amount
    from source

)

select * from renamed
