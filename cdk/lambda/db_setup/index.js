const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { Client } = require("pg");
const crypto = require("crypto");
const path = require("path");
const migrate = require("node-pg-migrate").default;

const sm = new SecretsManagerClient();

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
  // Use SSL with relaxed certificate validation for RDS Proxy self-signed certificates
  const dbUrl = `postgresql://${encodeURIComponent(
    db.username
  )}:${encodeURIComponent(db.password)}@${db.host}:${db.port || 5432}/${
    db.dbname
  }?sslmode=require`;
  
  try {
    await migrate({
      databaseUrl: dbUrl,
      dir: path.join(__dirname, "migrations"),
      direction,
      count,
      migrationsTable: "pgmigrations",
      logger: console,
      createSchema: false,
      // Pass SSL config via databaseUrlConfig for node-pg-migrate
      databaseUrlConfig: {
        ssl: { rejectUnauthorized: false }, // Accept RDS Proxy self-signed certificates
      },
    });
    console.log("Database migrations completed successfully with SSL/TLS");
  } catch (error) {
    console.error("Error running migrations:", error);
    console.error("Migration connection details:", {
      host: db.host,
      port: db.port || 5432,
      database: db.dbname,
      sslMode: 'require',
    });
    throw error;
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
  // Use SSL with relaxed certificate validation for RDS Proxy self-signed certificates
  const adminClient = new Client({
    user: adminDb.username,
    password: adminDb.password,
    host: adminDb.host,
    database: adminDb.dbname,
    port: adminDb.port || 5432,
    ssl: { rejectUnauthorized: false }, // Accept RDS Proxy self-signed certificates
  });
  
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

  // Create/update users with parameterized passwords to prevent SQL injection.
  // Passwords are passed as $1 parameters, never interpolated into SQL strings.
  const createOrUpdateUserSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RW_NAME}') THEN
        EXECUTE format('CREATE USER ${RW_NAME} WITH PASSWORD %L', $1);
      ELSE
        EXECUTE format('ALTER USER ${RW_NAME} WITH PASSWORD %L', $1);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TC_NAME}') THEN
        EXECUTE format('CREATE USER ${TC_NAME} WITH PASSWORD %L', $2);
      ELSE
        EXECUTE format('ALTER USER ${TC_NAME} WITH PASSWORD %L', $2);
      END IF;
    END$$;
  `;

  await adminClient.query("BEGIN");
  try {
    await adminClient.query(sql);
    // Create/update users with parameterized passwords (S-M6 fix)
    await adminClient.query(createOrUpdateUserSql, [rwPass, tcPass]);
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
