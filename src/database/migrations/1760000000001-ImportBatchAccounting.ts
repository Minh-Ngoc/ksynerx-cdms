import { MigrationInterface, QueryRunner } from 'typeorm';

export class ImportBatchAccounting1760000000001 implements MigrationInterface {
  name = 'ImportBatchAccounting1760000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE import_batch_accounting (
        import_id uuid NOT NULL REFERENCES import_jobs(id),
        batch_id varchar(255) NOT NULL,
        rows_processed integer NOT NULL,
        rows_succeeded integer NOT NULL,
        rows_failed integer NOT NULL,
        accounted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (import_id, batch_id),
        CONSTRAINT ck_import_batch_accounting_rows_processed_non_negative CHECK (rows_processed >= 0),
        CONSTRAINT ck_import_batch_accounting_rows_succeeded_non_negative CHECK (rows_succeeded >= 0),
        CONSTRAINT ck_import_batch_accounting_rows_failed_non_negative CHECK (rows_failed >= 0),
        CONSTRAINT ck_import_batch_accounting_processed_sum CHECK (rows_processed = rows_succeeded + rows_failed)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE import_batch_accounting');
  }
}
