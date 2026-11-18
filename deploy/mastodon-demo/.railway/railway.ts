import { defineRailway, image, postgres, project, redis, service, volume } from "railway/iac";

// Live demo: a Mastodon at mastodon.openfederation.net whose only way in is
// "sign in with your AT Protocol account" through pds.openfederation.net's
// OpenID Connect provider (docs/OIDC.md, ADR-005). Lives in the production
// project next to the PDS, as its own partial: the repository's own
// .railway/railway.ts never touches it, and it never touches the PDS.
//
// Variables are unmanaged (set with `railway variable set`, see
// deploy/mastodon-demo/README.md), so no secret is in this file.
export const partial = "mastodon-demo";

export default defineRailway(() => {
  const db = postgres("mastodon-postgres");
  const cache = redis("mastodon-redis");
  // In the service's region: a service with a volume runs where the volume is.
  const media = volume("mastodon-media-us", { region: "us-west2", sizeMB: 5000 });

  // Web and background jobs in one container, so both see the media volume
  // (a Railway volume mounts on one service). No streaming server: the web
  // app falls back to polling.
  const mastodon = service("mastodon", {
    source: image("ghcr.io/mastodon/mastodon:v4.5.8"),
    start: "bash -c 'bundle exec rails db:prepare && (bundle exec sidekiq -c 5 &) && exec bundle exec puma -C config/puma.rb'",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    deploy: { restartPolicyType: "ALWAYS" },
    replicas: { "us-west2": 1 },
    volumeMounts: { "mastodon-media-us": { mountPath: "/opt/mastodon/public/system" } },
    // Custom domain mastodon.openfederation.net (port 3000): added with
    // `railway domain`, not config (Railway does not register custom domains
    // from configuration).
  });

  return project("pds.openfederation.net", {
    variables: { managed: false },
    resources: [db, cache, media, mastodon],
  });
});
