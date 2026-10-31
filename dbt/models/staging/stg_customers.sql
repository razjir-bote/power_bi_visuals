with source as (

    select * from {{ ref('raw_customers') }}

),

renamed as (

    select
        id as customer_id,
        first_name,
        last_name,
        lower(email) as email,
        cast(created_at as date) as created_at
    from source

)

select * from renamed
