import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "openfederation-pds";
export default defineRailway(() => {
  const openfederationPds = service("openfederation-pds", {
    source: github("athlon-misa/openfederation-pds", { branch: "main", checkSuites: false }),
    build: { buildCommand: "npm ci --include=dev && npm run build", buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: { "us-west2": 1 },
    domains: ["pds.openfederation.net"],
  });

  return project("pds.openfederation.net", {
    variables: { managed: false },
    resources: [openfederationPds],
  });
});
