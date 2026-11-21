import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool } from './db.js';

try {
  const sql = await readFile(
    new URL('./001_initial.sql', import.meta.url),
    'utf8'
  );

  await pool.query(sql);

  console.log('Database migration completed successfully.');

} catch (error) {
  console.error('Database migration failed:', error);
  process.exitCode = 1;

} finally {
  await pool.end();
}
