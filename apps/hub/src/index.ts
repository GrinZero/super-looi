import { config } from "dotenv";
import { fileURLToPath } from "node:url";
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { buildApp } from "./app.js";
import { createHomeConnection } from "./home/connection.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const home = createHomeConnection();
const app = buildApp({ persistState: true, seedDemo: process.env.SEED_DEMO === "1", homeGateway: home.gateway, refreshHome: home.refresh });
home.register(app);

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error("Hub failed to start:", err);
    process.exit(1);
  }
  console.log(`[Super-LOOI Hub] Server listening at ${address}`);
});
