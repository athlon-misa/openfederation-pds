import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "openfederation-pds";
export default defineRailway(() => {
  const openfederationPds = service("openfederation-pds", {
    source: github("athlon-misa/openfederation-pds", { branch: "main", checkSuites: false }),
    // Built from the repository Dockerfile (multi-stage, runs as the node user).
    // Railway uses it whenever it is present, so this states what really runs.
    // buildCommand is ignored by the Dockerfile builder; it stays here only because
    // Railway cannot clear a stored value, and the file should match the service.
    build: { buildCommand: "npm ci --include=dev && npm run build", buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: { "us-west2": 1 },
    domains: ["pds.openfederation.net"],
  });

  // PLC directory (plc-server/), Nixpacks.
  const openfederationPlc = service("openfederation-plc", {
    source: github("athlon-misa/openfederation-pds", { branch: "main", checkSuites: false, rootDirectory: "/plc-server" }),
    build: { buildCommand: "npm install", buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "npm start",
    replicas: { "us-west2": 1 },
    domains: ["plc.openfederation.net"],
  });

  // Admin dashboard (web-interface/), Nixpacks.
  const openfederationWeb = service("openfederation-web", {
    source: github("athlon-misa/openfederation-pds", { branch: "main", checkSuites: false, rootDirectory: "/web-interface" }),
    build: { buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "npm start",
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["beta.openfederation.net"],
    networking: { privateNetworkEndpoint: "valiant-forgiveness" },
  });

  return project("pds.openfederation.net", {
    variables: { managed: false },
    resources: [openfederationPds, openfederationPlc, openfederationWeb],
  });
});
