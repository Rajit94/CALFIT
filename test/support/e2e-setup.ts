import { configureE2eEnvironment } from './e2e-env.js';

// Runs before every e2e test file. If TEST_DATABASE_URL is missing or unsafe, the run stops here.
configureE2eEnvironment();