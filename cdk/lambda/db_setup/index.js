const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { Client } = require("pg");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const migrate = require("node-pg-migrate").default;

const sm = new SecretsManagerClient();

const RDS_CA_BUNDLE_PATH =
  process.env.RDS_CA_BUNDLE_PATH ||
  path.join(__dirname, "certs", "global-bundle.pem");

let rdsCaCert;
function getRdsCaCert() {
  if (!rdsCaCert) {
    rdsCaCert = fs.readFileSync(RDS_CA_BUNDLE_PATH);
  }
  return rdsCaCert;
}

function dbConnectionConfig(secret, hostOverride) {
  const host = hostOverride || secret.host;
  const useProxy =
    Boolean(process.env.RDS_PROXY_ENDPOINT) &&
    host === process.env.RDS_PROXY_ENDPOINT;

  return {
    user: secret.username,
    password: secret.password,
    host,
    database: secret.dbname,
    port: secret.port || 5432,
    // RDS Proxy uses ACM certificates (public CA chain). The RDS CA bundle is for
    // direct RDS instance connections only.
    ssl: useProxy
      ? { rejectUnauthorized: true }
      : { ca: getRdsCaCert(), rejectUnauthorized: true },
  };
}

async function getSecret(name) {
  const data = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  return JSON.parse(data.SecretString);
}

async function putSecret(name, secret) {
  await sm.send(
    new PutSecretValueCommand({
      SecretId: name,
      SecretString: JSON.stringify(secret),
    })
  );
}


async function runMigrations(db, direction = "up", count = Infinity) {
  const client = new Client(dbConnectionConfig(db, process.env.RDS_PROXY_ENDPOINT));
  await client.connect();

  try {
    await migrate({
      dbClient: client,
      dir: path.join(__dirname, "migrations"),
      direction,
      count,
      migrationsTable: "pgmigrations",
      logger: console,
      createSchema: false,
      singleTransaction: false,
    });
    console.log("Database migrations completed successfully with SSL/TLS");
  } catch (error) {
    console.error("Error running migrations:", error);
    console.error("Migration connection details:", {
      host: client.host,
      port: client.port,
      database: client.database,
      sslEnabled: true,
    });
    throw error;
  } finally {
    await client.end();
  }
}

async function ensureBaselineOrMigrate(db, direction, count) {
  await runMigrations(db, direction, count);
}

async function createAppUsers(
  adminDb,
  dbSecretName,
  userSecretName,
  tableCreatorSecretName
) {
  const adminClient = new Client(
    dbConnectionConfig(adminDb, process.env.RDS_PROXY_ENDPOINT),
  );
  
  try {
    await adminClient.connect();
    console.log("Admin client connected successfully with SSL/TLS");
  } catch (error) {
    console.error("Error connecting admin client:", error);
    console.error("Admin connection details:", {
      host: adminDb.host,
      port: adminDb.port || 5432,
      database: adminDb.dbname,
      sslEnabled: true,
    });
    throw error;
  }

  // Stable usernames; rotate passwords idempotently
  const RW_NAME = "app_rw";
  const TC_NAME = "app_tc";
  const rwPass = crypto.randomBytes(16).toString("hex");
  const tcPass = crypto.randomBytes(16).toString("hex");

  // Safe quoting for DB identifier inside SQL
  const dbIdent = adminDb.dbname.replace(/"/g, '""');

  const sql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readwrite') THEN
        CREATE ROLE readwrite;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tablecreator') THEN
        CREATE ROLE tablecreator;
      END IF;
    END$$;

    GRANT CONNECT ON DATABASE "${dbIdent}" TO readwrite;
    GRANT CONNECT ON DATABASE "${dbIdent}" TO tablecreator;

    GRANT USAGE ON SCHEMA public TO readwrite;
    GRANT USAGE ON SCHEMA public TO tablecreator;
    GRANT CREATE ON SCHEMA public TO tablecreator;

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO readwrite;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tablecreator;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tablecreator;

    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO readwrite;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tablecreator;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO tablecreator;

    GRANT readwrite TO ${RW_NAME};
    GRANT tablecreator TO ${TC_NAME};
  `;

  // Passwords are random hex strings; embed via format(%L) inside the DO block.
  const createOrUpdateUserSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RW_NAME}') THEN
        EXECUTE format('CREATE USER ${RW_NAME} WITH PASSWORD %L', '${rwPass}');
      ELSE
        EXECUTE format('ALTER USER ${RW_NAME} WITH PASSWORD %L', '${rwPass}');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TC_NAME}') THEN
        EXECUTE format('CREATE USER ${TC_NAME} WITH PASSWORD %L', '${tcPass}');
      ELSE
        EXECUTE format('ALTER USER ${TC_NAME} WITH PASSWORD %L', '${tcPass}');
      END IF;
    END$$;
  `;

  await adminClient.query("BEGIN");
  try {
    // Create/update users first so they exist before granting roles
    await adminClient.query(createOrUpdateUserSql);
    await adminClient.query(sql);
    await adminClient.query("COMMIT");
  } catch (e) {
    await adminClient.query("ROLLBACK");
    throw e;
  } finally {
    await adminClient.end();
  }

  // Update Secrets Manager with the rotated creds
  const base = await getSecret(dbSecretName);
  await putSecret(tableCreatorSecretName, {
    ...base,
    username: TC_NAME,
    password: tcPass,
  });
  await putSecret(userSecretName, {
    ...base,
    username: RW_NAME,
    password: rwPass,
  });
}

exports.handler = async function (event = {}) {
  const { DB_SECRET_NAME, DB_USER_SECRET_NAME, DB_TABLE_CREATOR_SECRET_NAME } =
    process.env;
  const adminDb = await getSecret(DB_SECRET_NAME);

  // Allow manual invocation with { "direction": "down", "count": 1 } for rollbacks.
  // Normal CDK-triggered runs omit these fields and default to up/all.
  const direction = event.direction || "up";
  const count = event.count !== undefined ? event.count : Infinity;

  await ensureBaselineOrMigrate(adminDb, direction, count);

  // Only re-create app users on "up" runs; no-op for rollbacks.
  if (direction !== "down") {
  await createAppUsers(
    adminDb,
    DB_SECRET_NAME,
    DB_USER_SECRET_NAME,
    DB_TABLE_CREATOR_SECRET_NAME
  );
  }
  return { status: "ok", direction, count };
};
