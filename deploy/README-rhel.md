# Production Deployment on RHEL 8.10 With Docker

This deployment runs two containers:

- `backend`: FastAPI API on the private Docker network.
- `frontend`: Nginx serving the React build and reverse-proxying `/api` to the backend.

The large `.h5ad` file is mounted from the host. It is not copied into either Docker image.

## Server Prerequisites

Recommended minimum server resources:

- RHEL 8.10
- 4 CPU cores
- 16 GB RAM or more
- Enough disk for Docker images, source `.h5ad` files, logs, and CSC expression caches (allow at least the combined size of the source datasets again)
- Open inbound firewall port for the published web port, usually `80` or `8080`

Install Docker Engine and Compose plugin from the Docker repository:

```bash
sudo dnf -y install dnf-utils
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Log out and back in so group membership updates, then verify:

```bash
docker --version
docker compose version
```

If the server uses SELinux enforcing mode, keep the `:Z` labels in `compose.yaml`; they let Docker relabel mounted project data for container access.


## Troubleshooting Docker Network/DNS During Build

If `docker compose build` gets stuck or prints errors like:

```text
Temporary failure in name resolution
Failed to establish a new connection
/simple/pip/
/simple/fastapi/
```

then the build container cannot resolve or reach package indexes. This is a Docker/server DNS or proxy issue, not a Python dependency issue.

First test DNS from a disposable container:

```bash
docker run --rm busybox nslookup pypi.org
docker run --rm busybox wget -S --spider https://pypi.org/simple/pip/
```

If DNS fails, configure Docker daemon DNS on RHEL:

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "dns": ["8.8.8.8", "1.1.1.1"]
}
EOF
sudo systemctl restart docker
```

Then retry:

```bash
docker compose build --progress=plain backend
```

If the server is behind an institutional proxy, configure Docker's systemd proxy instead. Replace the proxy URL with your local proxy address:

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://proxy.example.edu:8080"
Environment="HTTPS_PROXY=http://proxy.example.edu:8080"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
```

Then retry the build.

If DNS works on the host but still fails during `docker compose build`, this project sets `build.network: host` in `compose.yaml` so build steps use the host network stack on Linux. Make sure the server has the latest `compose.yaml`, then rebuild without cache:

```bash
git pull
docker compose build --no-cache --progress=plain backend
```

## Deploy the Project

Clone the project:

```bash
sudo mkdir -p /opt/zebrafish-singlecell-portal
sudo chown -R $USER:$USER /opt/zebrafish-singlecell-portal
git clone YOUR_REPO_URL /opt/zebrafish-singlecell-portal
cd /opt/zebrafish-singlecell-portal
```

Copy the `.h5ad` file onto the server. The default expected path is:

```text
/opt/zebrafish-singlecell-portal/annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad
```

Create the environment file:

```bash
cp .env.example .env
```

Edit `.env` if needed:

```bash
vi .env
```

For port 80 instead of 8080:

```text
PORT=80
```

## Build Images

```bash
docker compose build
```

## Preprocess the Dataset

Run this once after copying or replacing the `.h5ad` file:

```bash
mkdir -p data/processed
docker compose --profile tools run --rm preprocess
```

The first run builds a CSC expression cache for each dataset. This is intentionally memory- and disk-intensive, but it makes individual gene-expression API requests much faster. Later runs reuse caches whose source file size and modification time are unchanged.

This writes:

```text
data/processed/study.json
data/processed/cells.parquet
data/processed/genes.json
```

The preprocessing container runs as root so it can write to a fresh bind-mounted `data/processed` directory on RHEL. The backend serves these files read-only.

## Start the Portal

```bash
docker compose up -d
```

## Repeatable Redeployment

After the application is installed and all four H5AD files are present, run the checked-in deployment script from the project root:

```bash
chmod +x deploy/redeploy.sh
./deploy/redeploy.sh
```

The script pulls Git changes with `--ff-only`, validates the datasets, builds images, backs up current processed data, stops the old containers, preprocesses every dataset, starts the application, and verifies `/api/health`.

If application files were copied to the server manually and no Git pull is wanted:

```bash
./deploy/redeploy.sh --no-pull
```

On preprocessing failure, the script preserves the failed output, restores the previous processed-data backup when available, and attempts to restart the prior application.

Check status:

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
```

Open the site:

```text
http://SERVER_IP:8080
```

or, if `PORT=80`:

```text
http://SERVER_IP
```

## Firewall

For port 8080:

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

For port 80:

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --reload
```

## Updating the App

```bash
cd /opt/zebrafish-singlecell-portal
git pull
docker compose build
docker compose up -d
```

If the `.h5ad` file changed, rerun preprocessing first:

```bash
docker compose --profile tools run --rm preprocess
docker compose up -d
```

## Stopping

```bash
docker compose down
```

## Notes

- Do not commit `.h5ad` files or `data/processed/*.parquet` into git.
- The backend still needs the `.h5ad` at runtime for gene expression, dot plot, heat map, and file download endpoints.
- The frontend talks to `/api` on the same origin; the browser does not need direct access to backend port `8000`.
