#!/usr/bin/env node
/**
 * `atlas-broker` daemon entry point.
 *
 * Started by `provisioning/bin/broker-launcher.sh` as the `atlas-broker` OS
 * identity. Reads its config from the environment (keys dir, vault repo, anchor
 * path, socket path, and — per D20 — `ATLAS_TEST_MODE`), starts the Unix-socket
 * server, and runs until signalled. The launcher NEVER sets `ATLAS_TEST_MODE`,
 * so a production broker hard-rejects the fixture signer.
 */
import { BrokerService } from "../src/service.js";
import { startBrokerServer } from "../src/server.js";
import { loadBrokerConfigFromEnv } from "../src/keys.js";

async function main(): Promise<void> {
  const socketPath = process.env.ATLAS_BROKER_SOCKET;
  if (socketPath === undefined) throw new Error("ATLAS_BROKER_SOCKET is required");

  const config = loadBrokerConfigFromEnv();
  const service = new BrokerService(config);
  const server = await startBrokerServer(service, socketPath);

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // eslint-disable-next-line no-console
  console.error(`atlas-broker listening on ${socketPath} (testMode=${config.testMode})`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`atlas-broker failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(4);
});
