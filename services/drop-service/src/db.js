const fs = require('fs');
const { Pool } = require('pg');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: Environment variable ${name} is required but not set.`);
    process.exit(1);
  }
  return value;
}

const DB_HOST = requireEnv('DB_HOST');
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = requireEnv('DB_USER');
const DB_PASSWORD = requireEnv('DB_PASSWORD');
const DB_NAME = process.env.DB_NAME || 'drop_db';

const isSslRequired = process.env.PGSSLMODE === 'require' ||
                      process.env.NODE_ENV === 'production' ||
                      (!['localhost', '127.0.0.1'].includes(DB_HOST));

const rdsCaPath = process.env.RDS_CA_PATH || '/etc/ssl/certs/rds-ca-bundle.pem';
let sslConfig = false;

if (isSslRequired) {
  if (fs.existsSync(rdsCaPath)) {
    sslConfig = {
      rejectUnauthorized: true,
      ca: fs.readFileSync(rdsCaPath).toString(),
    };
  } else {
    sslConfig = {
      rejectUnauthorized: false,
    };
  }
}

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  ssl: sslConfig,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client (drop-service):', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  requireEnv,
};
