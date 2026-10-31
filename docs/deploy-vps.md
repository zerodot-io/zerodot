# Deploy on a VPS

You need:

- A new Ubuntu or Debian VPS with 2 GB RAM or more.
- A domain name.

## Quick install

1. Add a DNS record: `A  zerodot.example.com  <VPS IP>`.
   If you use Cloudflare, set the SSL mode to **Full**. The mode "Flexible" causes redirect loops.
2. Run the script on the VPS as root:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/zerodot-io/zerodot/main/scripts/install.sh -o install.sh
   bash install.sh zerodot.example.com
   ```

   In Docker mode the script pulls the prebuilt image from GHCR (`ghcr.io/zerodot-io/zerodot`). The web, api, worker and sandbox services all use this one image. It does not build on the server. If the pull fails, it builds the image on the server instead. That takes about 10 minutes and needs 4 GB of RAM or more.

3. Open `https://zerodot.example.com` and sign up. The first user is the instance admin.
   Then open **System > Access** and turn **Public signup** off.

Save a copy of `ZERODOT_SECRET_KEY` from `.env` in the install folder. If you lose it, nobody can open the saved credentials.

## What the script checks

Before it changes anything, the script looks at the server and prints a list with ✔ (good), ! (warning) and ✘ (problem):

- Operating system (Ubuntu 22.04+ or Debian 12+), CPU type, systemd.
- RAM, swap and free disk space. It adds swap when RAM is low.
- Who uses ports 80 and 443. If a program other than Caddy has them, the script does not install Caddy and prints the proxy rule for you to add.
- Docker and Docker Compose (2.24 or newer).
- **Postgres on the server.** Version 13 or newer can be shared. The script makes a separate database and user for Zerodot and does not touch the others.
- **Valkey or Redis on the server.** It checks the version and the `maxmemory-policy` (the job queue needs `noeviction`).
- Caddy, the firewall, and the DNS record of your domain.

At the end it prints tips, for example which mode fits this server.
To only look, and change nothing, run:

```sh
bash install.sh --check
```

## Docker or without Docker

|                    | Docker (default)                                 | Native (`--native`)                                                                                                                                     |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What runs          | Containers for Zerodot, Postgres 17 and Valkey 8 | systemd services: web, api, worker, sandbox                                                                                                             |
| Database and queue | Own containers                                   | Uses Postgres and Valkey on the server if found. Installs them if not.                                                                                  |
| Node and pnpm      | Inside the image                                 | Node 22 and the exact pnpm version of the repository. A private copy goes to `/opt` when the server has none that fits. The system Node is not changed. |
| Best for           | Most servers. Easy to move.                      | Small servers (less RAM), servers that already run Postgres, container VPS where Docker fails                                                           |

Without a flag, the script asks and recommends one.

On a terminal the questions are dialog screens (menus and input boxes). Add `--no-tui` for plain questions, or `--yes` to accept all defaults without asking.

```sh
bash install.sh zerodot.example.com --docker
bash install.sh zerodot.example.com --native
```

Native mode can use your own database and queue. Set these before you run the script:

```sh
DATABASE_URL=postgres://user:pass@host:5432/zerodot VALKEY_URL=redis://host:6379/1 \
  bash install.sh zerodot.example.com --native
```

Native mode runs the API, worker and sandbox on `127.0.0.1` only (`ZERODOT_BIND_HOST`). The sandbox runs user code, so it must never be reachable from the internet.

## Update, or another instance

Run the script again. If it finds a Zerodot install, it asks:

- **Update** an install that exists. It pulls the new code and images, and restarts. It keeps `.env` and secrets.
- **Set up another instance.** Each instance has its own name, folder, domain, ports, database and services. Example:

  ```sh
  bash install.sh staging.example.com --new --name zerodot-staging
  ```

To skip the question: `--update` or `--new`. If you give the domain of an existing install, the script updates that one:

```sh
bash /var/www/zerodot/scripts/install.sh zerodot.example.com
```

## Image versions

Each release tag (`v0.1.0`) publishes four images to GHCR with the tags `latest`, `0.1.0` and `0.1`. Compose uses `latest`. To pin a release, set it in `.env`:

```sh
ZERODOT_VERSION=0.1.0
```

Then run `docker compose pull && docker compose up -d`.

## All options

Run `bash install.sh --help`. The main ones: `--docker`, `--native`, `--update`, `--new`, `--name`, `--dir`, `--no-proxy`, `--check`, `--yes`, `--no-tui`.

## Manual steps

These are the Docker steps, done by hand.

## 1. DNS

Add this record:

```
A  zerodot.example.com  <VPS IP>
```

If you use Cloudflare, set the SSL mode to **Full** or **Full (strict)**. The mode "Flexible" causes redirect loops. Error 525 means Caddy has no certificate yet.

## 2. Prepare the server

```sh
ssh root@<VPS IP>
apt update && apt install -y git ufw
curl -fsSL https://get.docker.com | sh
```

Open only SSH, HTTP and HTTPS:

```sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

If the VPS has less than 4 GB RAM, add swap:

```sh
fallocate -l 3G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 3. Get the code

```sh
mkdir -p /var/www && cd /var/www
git clone https://github.com/zerodot-io/zerodot.git zerodot && cd zerodot
```

## 4. Settings

```sh
cp .env.example .env
sed -i "s|^ZERODOT_SECRET_KEY=.*|ZERODOT_SECRET_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 32)|" .env
sed -i "s|^ZERODOT_BASE_URL=.*|ZERODOT_BASE_URL=https://zerodot.example.com|" .env
sed -i "s|^ZERODOT_TRUST_PROXY=.*|ZERODOT_TRUST_PROXY=true|" .env
sed -i "s|^ZERODOT_BLOB_DIR=.*|ZERODOT_BLOB_DIR=/blobs|" .env
sed -i "s|^ZERODOT_DB_PASSWORD=.*|ZERODOT_DB_PASSWORD=$(openssl rand -hex 24)|" .env
sed -i "s|^ZERODOT_VALKEY_PASSWORD=.*|ZERODOT_VALKEY_PASSWORD=$(openssl rand -hex 24)|" .env
chmod 600 .env
```

Save a copy of `ZERODOT_SECRET_KEY` in a safe place. If you lose it, nobody can open the saved credentials.

`ZERODOT_DB_PASSWORD` and `ZERODOT_VALKEY_PASSWORD` protect the database and Valkey inside the Docker network. Postgres reads its password only at the first start. Set it before the first `docker compose up`.

### Change the database password of an older install

An install from before `ZERODOT_DB_PASSWORD` has the password `zerodot`. To change it:

```sh
NEW=$(openssl rand -hex 24)
docker compose exec postgres psql -U zerodot -c "alter user zerodot with password '$NEW'"
sed -i "s|^ZERODOT_DB_PASSWORD=.*|ZERODOT_DB_PASSWORD=$NEW|" .env
grep -q '^ZERODOT_DB_PASSWORD=' .env || echo "ZERODOT_DB_PASSWORD=$NEW" >> .env
docker compose up -d
```

To give Valkey a password, set `ZERODOT_VALKEY_PASSWORD` in `.env` and run `docker compose up -d`.

## 5. Bind the proxy to localhost

The compose file publishes port 3000. Docker skips `ufw` for published ports, so port 3000 would be open to the internet over plain HTTP. Bind it to localhost:

```sh
cat > docker-compose.override.yml <<'CONF'
services:
  proxy:
    ports: !override
      - "127.0.0.1:3000:3000"
CONF
```

If port 3000 is in use on the host, change the left side (for example `127.0.0.1:3100:3000`) and use the same port in step 7.

## 6. Pull and start

```sh
docker compose pull
docker compose up -d
docker compose ps
curl -sI http://127.0.0.1:3000/
```

The images come from GHCR. The first pull takes about 1 minute. To build on the server instead, run `docker compose up -d --build`. The first build takes about 10 minutes and needs 4 GB of RAM or more. All services must show `Up`. The `curl` command must answer `307` with `Location: /sign-in`.

## 7. Caddy

No Caddy on the host yet:

```sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Put this in `/etc/caddy/Caddyfile`:

```caddy
zerodot.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
```

Caddy already runs on the host: add the same block to the end of its Caddyfile. If you use a `log` directive with a file, create the file and run `chown caddy:caddy` on it first. Without this, the reload fails.

`flush_interval -1` is for live event streams. Keep it.

Then load the new configuration:

```sh
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

## 8. First sign-in

1. Open `https://zerodot.example.com` and sign up. The first user is the instance admin.
2. Open **System > Access** and turn **Public signup** off. Invited people can still join.

You can also set `ZERODOT_SIGNUP_DISABLED=true` in `.env`. Then signup stays off and the switch is locked.

## Update

```sh
cd /var/www/zerodot && git pull && docker compose pull && docker compose up -d
```

## Back up

```sh
docker compose exec -T postgres pg_dump -U zerodot zerodot | gzip > zerodot-$(date +%F).sql.gz
```

Also keep `.env`. To restore on a new server, use the same `ZERODOT_SECRET_KEY` and `BETTER_AUTH_SECRET`.

## Notes

- Postgres and Valkey have no published ports.
- Keep `ZERODOT_ENABLE_EXECUTE_COMMAND=false` unless you trust everyone who can edit workflows.
- Run more code sandboxes with `SANDBOX_REPLICAS` in `.env`.
- Run more workers with `WORKER_REPLICAS` in `.env`, or more runs in each worker with `ZERODOT_WORKER_CONCURRENCY`.
