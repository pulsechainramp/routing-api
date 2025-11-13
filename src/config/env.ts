import dotenv from 'dotenv';

const ENV_SENTINEL = '__PULSECHAIN_ROUTER_ENV_INITIALIZED__';

const loadEnv = () => {
  dotenv.config();
  process.env[ENV_SENTINEL] = 'true';
};

if (!process.env[ENV_SENTINEL]) {
  loadEnv();
}

/**
 * Allows tests to re-read .env by clearing the sentinel and reloading config.
 */
export const resetEnvConfig = (): void => {
  delete process.env[ENV_SENTINEL];
  loadEnv();
};
