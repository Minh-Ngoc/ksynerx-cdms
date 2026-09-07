import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialCdmsSchema1760000000000 implements MigrationInterface {
  name = 'InitialCdmsSchema1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_products (
        id varchar(128) PRIMARY KEY,
        sku varchar(128) NOT NULL,
        name varchar(255) NOT NULL,
        price numeric(18,2) NOT NULL,
        quantity integer NOT NULL,
        version integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_inventory_products_sku UNIQUE (sku),
        CONSTRAINT ck_inventory_products_version_positive CHECK (version >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE product_state (
        product_id varchar(128) PRIMARY KEY,
        version integer NOT NULL,
        fingerprint varchar(128) NOT NULL,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT ck_product_state_version_positive CHECK (version >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE product_changes (
        id uuid PRIMARY KEY,
        product_id varchar(128) NOT NULL,
        version integer NOT NULL,
        fingerprint varchar(128) NOT NULL,
        source varchar(32) NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_product_changes_version_positive CHECK (version >= 1),
        CONSTRAINT ck_product_changes_source CHECK (source IN ('POLLING', 'WEBHOOK', 'EXCEL')),
        CONSTRAINT uq_product_changes_product_id_version UNIQUE (product_id, version)
      )
    `);

    // The unique constraint is only product/version: fingerprints can repeat across products or payloads.
    // Making fingerprint globally unique would reject valid independent changes that canonicalize identically.
    await queryRunner.query(`
      CREATE INDEX idx_product_changes_product_id_created_at
      ON product_changes (product_id, created_at)
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY,
        aggregate_id varchar(128) NOT NULL,
        event_type varchar(128) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(32) NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz NULL,
        last_error text NULL,
        CONSTRAINT ck_outbox_events_status CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
        CONSTRAINT ck_outbox_events_attempts_non_negative CHECK (attempts >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_outbox_events_status_created_at
      ON outbox_events (status, created_at)
    `);

    await queryRunner.query(`
      CREATE TABLE import_jobs (
        id uuid PRIMARY KEY,
        filename varchar(255) NOT NULL,
        status varchar(32) NOT NULL,
        rows_read integer NOT NULL DEFAULT 0,
        rows_processed integer NOT NULL DEFAULT 0,
        rows_succeeded integer NOT NULL DEFAULT 0,
        rows_failed integer NOT NULL DEFAULT 0,
        total_rows integer NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NULL,
        error text NULL,
        enqueue_completed_at timestamptz NULL,
        CONSTRAINT ck_import_jobs_status CHECK (status IN ('CREATED', 'UPLOADING', 'PROCESSING', 'COMPLETED', 'FAILED')),
        CONSTRAINT ck_import_jobs_rows_read_non_negative CHECK (rows_read >= 0),
        CONSTRAINT ck_import_jobs_rows_processed_non_negative CHECK (rows_processed >= 0),
        CONSTRAINT ck_import_jobs_rows_succeeded_non_negative CHECK (rows_succeeded >= 0),
        CONSTRAINT ck_import_jobs_rows_failed_non_negative CHECK (rows_failed >= 0),
        CONSTRAINT ck_import_jobs_total_rows_non_negative CHECK (total_rows IS NULL OR total_rows >= 0),
        CONSTRAINT ck_import_jobs_processed_not_above_read CHECK (rows_processed <= rows_read),
        CONSTRAINT ck_import_jobs_processed_sum CHECK (rows_processed = rows_succeeded + rows_failed)
      )
    `);

    // enqueue_completed_at means the ingestion producer finished successfully; Task 20 still owns
    // the separate PROCESSING -> COMPLETED transition after all enqueued rows reach terminal outcomes.
    await queryRunner.query(`
      CREATE INDEX idx_import_jobs_status_created_at
      ON import_jobs (status, created_at)
    `);

    await queryRunner.query(`
      CREATE TABLE polling_checkpoints (
        name varchar(100) PRIMARY KEY,
        updated_at timestamptz NOT NULL,
        product_id varchar(128) NOT NULL
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE polling_checkpoints');
    await queryRunner.query('DROP INDEX idx_import_jobs_status_created_at');
    await queryRunner.query('DROP TABLE import_jobs');
    await queryRunner.query('DROP INDEX idx_outbox_events_status_created_at');
    await queryRunner.query('DROP TABLE outbox_events');
    await queryRunner.query('DROP INDEX idx_product_changes_product_id_created_at');
    await queryRunner.query('DROP TABLE product_changes');
    await queryRunner.query('DROP TABLE product_state');
    await queryRunner.query('DROP TABLE inventory_products');
  }
}
