import { parseServerConfig, HelpRequested } from "./config";
import { createServer } from "./server";
import { Storage } from "./storage";

async function main(): Promise<void> {
  let storage: Storage | undefined;
  try {
    const config = parseServerConfig(process.argv.slice(2));
    storage = await Storage.open(config.databaseUrl);
    const server = createServer(storage, {
      port: config.port,
      ...(config.hostname !== undefined ? { hostname: config.hostname } : {}),
    });
    console.log(`token-tracker API listening on http://${server.hostname}:${server.port}`);

    const shutdown = async () => {
      await server.stop();
      await storage?.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return;
    }
    console.error(error);
    await storage?.close();
    process.exitCode = 1;
  }
}

await main();
