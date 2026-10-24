{#
    Post-hook: copy the model's freshly built table to a timestamped table in another schema,
    e.g. int_backups.fct_orders_20261024_143015.

        {{ config(post_hook="{{ backup_to_int_backups() }}") }}

    - The suffix is the current datetime (YYYYMMDD_HHMMSS) in var('backup_timezone') when the hook runs.
    - Does nothing for view models.
    - Backups accumulate; nothing here drops old ones.
    - The copy uses the model's dist/index config unless overridden.
#}
{% macro backup_to_int_backups(backup_schema='int_backups', dist=none, index=none) -%}
    {%- set dist = dist or config.get('dist', 'ROUND_ROBIN') -%}
    {%- set index = index or config.get('index', 'CLUSTERED COLUMNSTORE INDEX') -%}
    {%- set suffix = modules.datetime.datetime.now(backup_timezone()).strftime('%Y%m%d_%H%M%S') -%}
    {%- set source = '[' ~ this.schema ~ '].[' ~ this.identifier ~ ']' -%}
    {%- set backup = '[' ~ backup_schema ~ '].[' ~ this.identifier ~ '_' ~ suffix ~ ']' -%}

    if not exists (select 1 from sys.schemas where name = '{{ backup_schema }}')
        exec('create schema [{{ backup_schema }}]');

    if {{ _table_exists(this.schema, this.identifier) }}
        exec('create table {{ backup }} with (distribution = {{ dist }}, {{ index }}) as select * from {{ source }}');
{%- endmacro %}
