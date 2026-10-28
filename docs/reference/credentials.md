# Credentials

## Credentials and the secret key

Zerodot encrypts credentials with AES-256-GCM. The key is `ZERODOT_SECRET_KEY` (32 bytes, base64). Services do not start without it. Keep a copy: with a lost key, saved credentials cannot be opened.

To change the key:

```sh
ZERODOT_SECRET_KEY=<old key> ZERODOT_NEW_SECRET_KEY=<new key> DATABASE_URL=<url> pnpm run rotate-key
```

Then set `ZERODOT_SECRET_KEY` to the new key in every service and restart them.

## Test before save

When you save a credential, zerodot tests it first. A credential that fails its test is not saved, and the form shows the error. An `OAuth2` credential cannot be tested before you connect it, so it saves without a test. An open credential also tests itself.

## OAuth2 credentials

Use the `OAuth2` credential to connect an account of a service that uses OAuth2. A node that accepts it (today `HTTP Request` and `HTTP Poll`) sends the access token as `Authorization: Bearer <token>`.

1. At the service, make an OAuth app. Set its redirect URL to `<ZERODOT_BASE_URL>/oauth2/callback`. The credential form shows the exact address.
2. In zerodot, open Credentials, pick `OAuth2`, and enter the client id, the client secret, the authorize URL, the token URL, and the scopes (separated by spaces). Choose "Save and connect" and allow access at the service.

Zerodot refreshes the access token before a run, when it is less than 60 seconds from its end. Many runs at the same time make one refresh request. If the service refuses the refresh token, the credential shows "Reconnect needed", and runs that use it fail until you connect again. The authorize and token URLs must use HTTPS (HTTP is allowed for `localhost`). Zerodot uses PKCE (S256).

Some services need extra settings. For Google, a refresh token comes only when the authorize request has `access_type=offline` and `prompt=consent`, and an app in "testing" mode loses its refresh tokens after 7 days.
