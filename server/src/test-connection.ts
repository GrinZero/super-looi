import "dotenv/config";
import pg from "pg";

const { Client } = pg;
const ref = "lqswbjdnqjflndcnbmjm";
const password = process.env.DB_PASSWORD;

const regions = [
  "us-east-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "eu-west-1",
  "us-west-1",
  "ap-south-1",
];

async function tryConnect() {
  for (const region of regions) {
    const host = `aws-0-${region}.pooler.supabase.com`;
    console.log(`Trying ${host}...`);
    const client = new Client({
      host,
      port: 6543,
      database: "postgres",
      user: `postgres.${ref}`,
      password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      console.log(`✅ Connected via ${region}!`);
      await client.end();
      return region;
    } catch (e: any) {
      console.log(`  ❌ ${e.message.slice(0, 80)}`);
    }
  }

  // Try direct connection (port 5432) via hostname
  console.log("\nTrying direct connection (port 5432)...");
  const directClient = new Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });
  try {
    await directClient.connect();
    console.log("✅ Connected directly!");
    await directClient.end();
    return "direct";
  } catch (e: any) {
    console.log(`  ❌ Direct: ${e.message.slice(0, 100)}`);
  }

  return null;
}

tryConnect().then(r => {
  if (!r) {
    console.log("\n❌ Could not connect to Supabase PostgreSQL from this network.");
    console.log("The database tables need to be created manually via Supabase SQL Editor.");
    console.log("Run the SQL in: supabase/migrations/001_init.sql");
  }
});
