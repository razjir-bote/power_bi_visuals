{#
    Restore a backup table over the model it was taken from. See runbooks/restore_backup.md.

        dbt run-operation restore_backup --args '{backup: fct_orders_20261024_150904, dry_run: true}'
        dbt run-operation restore_backup --args '{backup: fct_orders_20261024_150904}'
        dbt run-operation restore_backup --args '{backup: fct_orders, backup_schema: prior_run}'

    - The model is worked out from the backup name (suffix _YYYYMMDD_HHMMSS stripped) unless `model`
      is given, and its schema, table name and dist/index config come from the dbt project.
    - The current table is first copied to <safety_schema>.<table>_<YYYYMMDD_HHMMSS>, so a restore
      can itself be undone with this macro.
    - The backup is copied in under a temporary name and swapped in with renames, so the live table
      is only replaced once the copy has succeeded.
#}
{% macro restore_backup(backup, backup_schema='int_backups', model=none, target_schema=none, safety_schema='int_backups', dry_run=false) %}
    {% if not execute %}
        {{ return('') }}
    {% endif %}

    {% set plan = _restore_plan(backup, backup_schema, model, target_schema, safety_schema) %}

    {% if not _table_exists_now(plan.backup_schema, plan.backup) %}
        {{ exceptions.raise_compiler_error("restore_backup: backup table [" ~ plan.backup_schema ~ "].[" ~ plan.backup ~ "] does not exist") }}
    {% endif %}
    {% if _table_exists_now(plan.target_schema, plan.target_table ~ '__restore_old') %}
        {{ exceptions.raise_compiler_error("restore_backup: [" ~ plan.target_schema ~ "].[" ~ plan.target_table ~ "__restore_old] exists, left by an interrupted restore. Check it (and [" ~ plan.safety_schema ~ "]) before dropping it and retrying.") }}
    {% endif %}

    {% set target_exists = _table_exists_now(plan.target_schema, plan.target_table) %}
    {% set suffix = modules.datetime.datetime.now(backup_timezone()).strftime('%Y%m%d_%H%M%S') %}
    {% set backup_rows = run_query('select count_big(*) from [' ~ plan.backup_schema ~ '].[' ~ plan.backup ~ ']').rows[0][0] %}

    {{ log('restore_backup: [' ~ plan.backup_schema ~ '].[' ~ plan.backup ~ '] (' ~ backup_rows ~ ' rows) -> ['
           ~ plan.target_schema ~ '].[' ~ plan.target_table ~ '] with distribution = ' ~ plan.dist ~ ', ' ~ plan.index
           ~ (' (dry run)' if dry_run else ''), info=true) }}
    {% if not target_exists %}
        {{ log('restore_backup: target table does not exist yet; nothing to keep a safety copy of', info=true) }}
    {% endif %}

    {% for sql in _restore_statements(plan, target_exists, suffix, _table_exists_now(plan.target_schema, plan.target_table ~ '__restore_tmp')) %}
        {{ log(('restore_backup: would run: ' if dry_run else 'restore_backup: running: ') ~ sql, info=true) }}
        {% if not dry_run %}
            {% do run_query(sql) %}
        {% endif %}
    {% endfor %}

    {% if not dry_run %}
        {% set restored_rows = run_query('select count_big(*) from [' ~ plan.target_schema ~ '].[' ~ plan.target_table ~ ']').rows[0][0] %}
        {{ log('restore_backup: done, [' ~ plan.target_schema ~ '].[' ~ plan.target_table ~ '] now has ' ~ restored_rows ~ ' rows'
               ~ (' (previous table kept as [' ~ plan.safety_schema ~ '].[' ~ plan.target_table ~ '_' ~ suffix ~ '])' if target_exists else ''), info=true) }}
        {% if restored_rows != backup_rows %}
            {{ exceptions.raise_compiler_error('restore_backup: row count mismatch, backup has ' ~ backup_rows ~ ' rows but target has ' ~ restored_rows) }}
        {% endif %}
    {% endif %}
    {{ return('') }}
{% endmacro %}

{# Work out what to restore where, from the arguments and the dbt project. No database access. #}
{% macro _restore_plan(backup, backup_schema, model, target_schema, safety_schema) %}
    {% for name in [backup, backup_schema, model, target_schema, safety_schema] if name is not none %}
        {% if not modules.re.match('^[A-Za-z0-9_]+$', name | string) %}
            {{ exceptions.raise_compiler_error("restore_backup: invalid name '" ~ name ~ "' (letters, digits and underscores only)") }}
        {% endif %}
    {% endfor %}

    {% if model is none %}
        {% set suffix_match = modules.re.match('^(.+)_[0-9]{8}_[0-9]{6}$', backup) %}
        {% set model = suffix_match.group(1) if suffix_match else backup %}
    {% endif %}

    {% set nodes = graph.nodes.values() | selectattr('resource_type', 'in', ['model', 'seed', 'snapshot']) | selectattr('name', 'equalto', model) | list %}
    {% if nodes | length == 0 and target_schema is none %}
        {{ exceptions.raise_compiler_error("restore_backup: no model named '" ~ model ~ "' in this project. Pass model: <name>, or target_schema: <schema> to restore to [<schema>].[" ~ model ~ "].") }}
    {% endif %}
    {% set node = nodes[0] if nodes else none %}
    {% set node_config = node.config if node else {} %}

    {{ return({
        'backup': backup,
        'backup_schema': backup_schema,
        'target_schema': target_schema or node.schema,
        'target_table': (node.alias or node.name) if node else model,
        'safety_schema': safety_schema,
        'dist': node_config.get('dist') or 'ROUND_ROBIN',
        'index': node_config.get('index') or 'CLUSTERED COLUMNSTORE INDEX',
    }) }}
{% endmacro %}

{# The statements a restore runs, in order. No database access. #}
{% macro _restore_statements(plan, target_exists, suffix, tmp_exists=false) %}
    {% set target = '[' ~ plan.target_schema ~ '].[' ~ plan.target_table ~ ']' %}
    {% set tmp = '[' ~ plan.target_schema ~ '].[' ~ plan.target_table ~ '__restore_tmp]' %}
    {% set old = '[' ~ plan.target_schema ~ '].[' ~ plan.target_table ~ '__restore_old]' %}
    {% set safety = '[' ~ plan.safety_schema ~ '].[' ~ plan.target_table ~ '_' ~ suffix ~ ']' %}
    {% set with_clause = 'with (distribution = ' ~ plan.dist ~ ', ' ~ plan.index ~ ')' %}
    {% set statements = [] %}

    {% if target_exists %}
        {% do statements.append("if not exists (select 1 from sys.schemas where name = '" ~ plan.safety_schema ~ "') exec('create schema [" ~ plan.safety_schema ~ "]')") %}
        {% do statements.append('create table ' ~ safety ~ ' ' ~ with_clause ~ ' as select * from ' ~ target) %}
    {% endif %}
    {% if tmp_exists %}
        {% do statements.append('drop table ' ~ tmp) %}
    {% endif %}
    {% do statements.append('create table ' ~ tmp ~ ' ' ~ with_clause ~ ' as select * from [' ~ plan.backup_schema ~ '].[' ~ plan.backup ~ ']') %}
    {% if target_exists %}
        {% do statements.append('rename object ' ~ target ~ ' to [' ~ plan.target_table ~ '__restore_old]') %}
    {% endif %}
    {% do statements.append('rename object ' ~ tmp ~ ' to [' ~ plan.target_table ~ ']') %}
    {% if target_exists %}
        {% do statements.append('drop table ' ~ old) %}
    {% endif %}

    {{ return(statements) }}
{% endmacro %}

{% macro _table_exists_now(schema, identifier) %}
    {% set result = run_query('select case when ' ~ _table_exists(schema, identifier) ~ ' then 1 else 0 end') %}
    {{ return(result.rows[0][0] == 1) }}
{% endmacro %}
