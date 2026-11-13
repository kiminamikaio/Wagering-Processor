# Architecture decisions

## Authentication

Authentication is intentionally deferred because it is outside the challenge's
scored scope. `AuthGuard` is currently a no-op extension point applied to wallet
and wagering endpoints; health endpoints remain public. A future deployment
should validate bearer tokens issued by an external OIDC identity provider
(such as Keycloak or Zitadel), rather than implement password storage in this
service.
