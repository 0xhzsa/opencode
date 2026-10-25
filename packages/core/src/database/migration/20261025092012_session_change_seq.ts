import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261025092012_session_change_seq",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tombstone\` (
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`row_id\` text NOT NULL,
          \`ordinal\` integer DEFAULT 0 NOT NULL,
          \`change_seq\` integer NOT NULL,
          CONSTRAINT \`session_tombstone_pk\` PRIMARY KEY(\`session_id\`, \`kind\`, \`row_id\`, \`ordinal\`),
          CONSTRAINT \`fk_session_tombstone_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_inbox\` ADD \`change_seq\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_message\` ADD \`change_seq\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_part\` ADD \`change_seq\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`change_seq\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_message_session_change_seq_idx\` ON \`session_message\` (\`session_id\`,\`change_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_part_session_change_seq_idx\` ON \`session_part\` (\`session_id\`,\`change_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_tombstone_session_change_seq_idx\` ON \`session_tombstone\` (\`session_id\`,\`change_seq\`);`,
      )
    })
  },
}

export default migration
