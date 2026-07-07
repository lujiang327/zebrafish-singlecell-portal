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
- Enough disk for Docker images, processed files, logs, and the `.h5ad` file
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
