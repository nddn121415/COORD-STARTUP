import type { TestProject } from 'vitest/node';
import { startTestPostgres } from '../scripts/postgres.js';
export default async function setup(project: TestProject) {
  if (process.env.COORD_TEST_DATABASE_URL) {
    project.provide('databaseUrl', process.env.COORD_TEST_DATABASE_URL);
    return;
  }
  const database = await startTestPostgres();
  project.provide('databaseUrl', database.url);
  return async () => {
    await database.stop();
  };
}
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
