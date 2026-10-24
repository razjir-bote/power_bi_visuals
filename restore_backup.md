# Runbook: restore a model from a backup

Use this when a dbt run has written bad data to a model's table, and you need to put back an earlier copy.

Backups are in the `int_backups` schema, named `<table>_<YYYYMMDD_HHMMSS>` (Brisbane time). The `backup_to_int_backups` post-hook takes one after each successful build, and `cleanup_int_backups` deletes them after 90 days.

Restores are done with the `restore_backup` run-operation (`macros/restore_backup.sql`).

**Time needed:** about 15 minutes, plus copy time for large tables.

## What a restore does

1. Copies the current table to `int_backups.<table>_<now>`, as a safety copy you can roll back to.
2. Copies the backup into `<schema>.<table>__restore_tmp`, using the model's own distribution and index settings.
3. Renames the current table to `<table>__restore_old`, renames `__restore_tmp` to `<table>`, then drops `__restore_old`.
4. Checks that the restored table has the same row count as the backup.

If anything fails before step 3, the live table is untouched.

## Before you start

- [ ] Your environment is set up as in the README: `.venv` is activated, `DBT_PROFILES_DIR`, `SYNAPSE_HOST` and `SYNAPSE_DATABASE` are set, and `dbt debug` passes.
- [ ] Your login can `SELECT` from the backup schema, `CREATE TABLE` in the target and `int_backups` schemas, and `ALTER`/`DROP` tables in the target schema.
- [ ] The dedicated SQL pool is running, not paused.
- [ ] **Scheduled dbt runs are paused.** The next `dbt build` or `dbt run` rebuilds the model from its sources and will overwrite your restore. Keep runs paused until step 7.

## 1. Find the backup

Run this in Synapse Studio, SSMS or Azure Data Studio. Replace `fct[_]orders` with your table name, keeping `[_]` for each underscore:

```sql
select t.name as backup_table, t.create_date as created_utc
from sys.tables t
inner join sys.schemas s on s.schema_id = t.schema_id
where s.name = 'int_backups' and t.name like 'fct[_]orders[_][0-9]%'
order by t.create_date desc;
```

The timestamp in a backup's name is the Brisbane time it was taken, which is just after the model finished building. To roll back the most recent run, pick the backup from the run *before* the bad one.

## 2. Check the backup

Confirm the backup has the data you expect before restoring it:

```sql
select count_big(*) from int_backups.fct_orders_20261024_150904;
select top 20 * from int_backups.fct_orders_20261024_150904;

-- compare with what's live now
select count_big(*) from marts.fct_orders;
```

## 3. Dry run

```powershell
dbt run-operation restore_backup --args '{backup: fct_orders_20261024_150904, dry_run: true}'
```

Check the output:

- The **target** is the right schema and table, e.g. `[marts].[fct_orders]`.
- The **row count** of the backup is what you expect.
- The statements listed are the ones you expect to run. Nothing is changed in a dry run.

If the macro can't work out the model from the backup name, pass it explicitly with `model: fct_orders`. To restore a table that isn't a dbt model, pass `target_schema: <schema>`; the table name is then taken from the backup name.

## 4. Restore

Run the same command without `dry_run`:

```powershell
dbt run-operation restore_backup --args '{backup: fct_orders_20261024_150904}'
```

When it finishes, the output ends with:

```
restore_backup: done, [marts].[fct_orders] now has 600 rows (previous table kept as [int_backups].[fct_orders_20261024_161230])
```

**Write down the safety copy name.** You need it to undo the restore.

## 5. Verify

```powershell
dbt test --select fct_orders
```

Also spot-check the data the incident was about, for example the rows or totals that were wrong.

## 6. Rebuild downstream models

Tables built from the restored model still contain data from the bad run. Views read the restored table straight away. Rebuild the tables downstream of the model, but not the model itself:

```powershell
dbt build --select fct_orders+ --exclude fct_orders
```

For example, restoring `fct_orders` means `dim_customers` needs rebuilding.

## 7. Resume scheduled runs

Before re-enabling scheduled runs, decide what the next run should do with this model:

- **The cause is fixed upstream** (sources corrected, model code reverted): resume runs as normal. The model is rebuilt from the fixed inputs.
- **The cause is not fixed yet:** exclude the model from scheduled runs (`--exclude fct_orders+`) until it is. Otherwise the next run writes the bad data again.

On the next run, the post-hook will take a new timestamped backup as usual.

## Undo a restore

Restore the safety copy from step 4 in the same way:

```powershell
dbt run-operation restore_backup --args '{backup: fct_orders_20261024_161230}'
```

## Troubleshooting

**`backup table [...] does not exist`.** Check the name and schema against step 1. Backups in `int_backups` older than 90 days are deleted by `cleanup_int_backups`.

**`no model named '...' in this project`.** The name before the timestamp doesn't match a model name, for example because the model has an alias or was renamed. Pass `model: <model name>`, or `target_schema: <schema>` for a table outside dbt.

**`[...__restore_old] exists, left by an interrupted restore`.** A previous restore stopped between the renames. Check the live table:

- If `<schema>.<table>` exists and looks right, the restore got as far as the final rename. Drop `<table>__restore_old`.
- If `<schema>.<table>` is missing, rename `<table>__restore_old` back:
  `rename object [marts].[fct_orders__restore_old] to [fct_orders];`

Then retry. The safety copy in `int_backups` from the interrupted attempt is still there if needed.

**`row count mismatch`.** The swap happened but the row counts differ, which shouldn't occur. Check whether anything else wrote to the table during the restore. If in doubt, undo the restore using the safety copy.

**Leftover `<table>__restore_tmp`.** It's dropped automatically at the start of the next restore.

## Things to know

- **Structure comes with the data.** A backup has the columns the model had when the backup was taken. If the model has changed since then, the restored table has the old columns until the next dbt run rebuilds it.
- **Incremental models** continue from the restored data on their next run. That's usually what you want after a bad load.
- **Seeds** are restored the same way, but the next `dbt seed` reloads them from the CSV.
- **Safety copies are named like ordinary backups**, so `cleanup_int_backups` deletes them after 90 days too.
