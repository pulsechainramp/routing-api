import dotenv from 'dotenv';

const ENV_SENTINEL = '__PULSECHAIN_ROUTER_ENV_INITIALIZED__';

if (!process.env[ENV_SENTINEL]) {
  dotenv.config();
  process.env[ENV_SENTINEL] = 'true';
}
