{#
    Pre-hook: copy the model's current table (the previous run's output) into another schema
    before dbt rebuilds it.

        {{ config(pre_hook="{{ backup_to_prior_run() }}") }}

    - Does nothing when the table doesn't exist yet (first run) or when the model is a view.
    - The copy is built under a temporary name and swapped in only after it succeeds, so a failed
      copy leaves the previous backup in place.
    - The copy uses the model's dist/index config unless overridden.
#}
{% macro backup_to_prior_run(backup_schema='prior_run', dist=none, index=none) -%}
    {%- set dist = dist or config.get('dist', 'ROUND_ROBIN') -%}
    {%- set index = index or config.get('index', 'CLUSTERED COLUMNSTORE INDEX') -%}
    {%- set source = '[' ~ this.schema ~ '].[' ~ this.identifier ~ ']' -%}
    {%- set backup = '[' ~ backup_schema ~ '].[' ~ this.identifier ~ ']' -%}
    {%- set staging = '[' ~ backup_schema ~ '].[' ~ this.identifier ~ '__prior_run_tmp]' -%}

    if not exists (select 1 from sys.schemas where name = '{{ backup_schema }}')
        exec('create schema [{{ backup_schema }}]');

    if {{ _table_exists(this.schema, this.identifier) }}
    begin
        if {{ _table_exists(backup_schema, this.identifier ~ '__prior_run_tmp') }}
            exec('drop table {{ staging }}');

        exec('create table {{ staging }} with (distribution = {{ dist }}, {{ index }}) as select * from {{ source }}');

        if {{ _table_exists(backup_schema, this.identifier) }}
            exec('drop table {{ backup }}');

        exec('rename object {{ staging }} to [{{ this.identifier }}]');
    end
{%- endmacro %}

