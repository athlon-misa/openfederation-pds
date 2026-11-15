import { defineRailway, github, postgres, project, service, volume } from "railway/iac";

// Public demo servers (docs/DEMO-SERVERS.md). Everything here is wiped every
// night by demo mode (DEMO_MODE=true). Variables are unmanaged: they are set
// on Railway directly, so secrets never live in this file.
const REPO = "athlon-misa/openfederation-pds";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 50000 });

  // Demo PLC directory (plc-server/), never plc.openfederation.net.
  const plc = service("plc-demo", {
    source: github(REPO, { branch: "main", checkSuites: false, rootDirectory: "/plc-server" }),
    build: { buildCommand: "npm install", buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "npm start",
    deploy: { restartPolicyType: "ALWAYS" },
    replicas: { "us-west2": 1 },
    // Custom domain plc-demo.openfederation.net: added with `railway domain`, not config.
  });

  const pds = (name: string, host: string) =>
    service(name, {
      source: github(REPO, { branch: "main", checkSuites: false }),
      build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
      healthcheck: "/health",
      healthcheckTimeout: 300,
      // The nightly reset ends with exit code 75; Always brings it back on an empty database.
      deploy: { restartPolicyType: "ALWAYS" },
      replicas: { "us-west2": 1 },
      // Custom domains `host` and `*.host`: added with `railway domain`, not config.
    });

  const pdsOpenFederation = pds("pds-demo-openfederation", "demo.openfederation.net");
  const pdsOpenNewsrooms = pds("pds-demo-opennewsrooms", "demo.opennewsrooms.com");

  return project("openfederation-demo", {
    variables: { managed: false },
    resources: [Postgres, postgresVolume, plc, pdsOpenFederation, pdsOpenNewsrooms],
  });
});
