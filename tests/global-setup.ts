import 'dotenv/config';
import { execFileSync } from 'node:child_process';

/** Apply migrations to the test database once before the suite runs. */
export default function setup() {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    console.warn('TEST_DATABASE_URL is not set; integration tests will be skipped.');
    return;
  }
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });
}
