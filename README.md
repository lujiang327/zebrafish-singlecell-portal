# Zebrafish Single-Cell Portal

A lightweight web portal for interactively exploring zebrafish full cell type and subtype `.h5ad` datasets in this repository.

The scaffold has two parts:

- `backend/`: FastAPI service for study metadata, cell coordinates, annotations, gene lookup, and expression summaries.
- `frontend/`: React/Vite app with an interactive WebGL UMAP scatter plot.

## Data

The current source datasets are expected at:

```text
annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad
AC_subtypes_reproduced.h5ad
bc_9_sample_guca1b_gt2_mikiko_no_contam_26_28.h5ad
corrected_RGC_annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad
```

Large `.h5ad` files are ignored by git in this scaffold.

## Setup

Create and activate the conda environment:

```bash
conda env create -f environment.yml
conda activate zebrafish-singlecell-portal
```

If you prefer `venv`, use Python 3.11 or newer:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

Avoid using macOS system Python 3.9 for this project; newer `anndata` and scientific Python packages are easiest to install with Python 3.11.

Install frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

## Preprocess the h5ad

Run this once before starting the API:

```bash
conda activate zebrafish-singlecell-portal
python backend/preprocess.py --all
```

This writes:

```text
data/processed/study.json
data/processed/full-cell-types/{study.json,cells.parquet,genes.json}
data/processed/ac-subtypes/{study.json,cells.parquet,genes.json}
data/processed/bc-subtypes/{study.json,cells.parquet,genes.json}
data/processed/rgc-subtypes/{study.json,cells.parquet,genes.json}
```

The preprocessing script chooses the first available embedding from this order:

```text
X_umap, X_tsne, X_pca, otherwise the first adata.obsm key
```

## Run Locally

Start the backend:

```bash
conda activate zebrafish-singlecell-portal
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend in another terminal:

```bash
cd frontend
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Share on Local Network

To let colleagues on the same Wi-Fi or LAN view the portal from your Mac, find your local IP address:

```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

Then start the backend so it accepts browser requests from the local network:

```bash
conda activate zebrafish-singlecell-portal
CORS_ORIGINS="*" uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Start the frontend in another terminal:

```bash
conda activate zebrafish-singlecell-portal
cd frontend
npm run dev:lan -- --port 5173
```

Your colleagues can open:

```text
http://YOUR_LOCAL_IP:5173
```

For example, if your Mac's local IP is `192.168.1.24`, they open:

```text
http://192.168.1.24:5173
```

Keep both terminal windows running while colleagues use the site. If macOS asks whether to allow incoming network connections for Python or Node, choose allow.


## Production Deployment With Docker

This project includes a Docker Compose setup for production deployment on Linux servers such as RHEL 8.10. The production layout is:

```text
frontend container: Nginx serves the built React app and proxies /api
backend container: FastAPI serves data and expression endpoints
host-mounted data: large .h5ad files plus generated data/processed files
```

The large `.h5ad` files are intentionally not copied into Docker images. Keep them on the server and mount them into the backend container.

Quick start on the server:

```bash
cp .env.example .env
mkdir -p data/processed
docker compose build
docker compose --profile tools run --rm preprocess
docker compose up -d
```

By default, the site is published on:

```text
http://SERVER_IP:8080
```

Set `PORT=80` in `.env` if you want to serve on normal HTTP port 80. See [deploy/README-rhel.md](deploy/README-rhel.md) for RHEL 8.10 prerequisites, firewall commands, SELinux notes, and update instructions.

## API

Useful endpoints:

```text
GET /api/health
GET /api/study
GET /api/cells?color=cell_type
GET /api/cells?color=sample&filter_column=sample&filter_value=Zebra
GET /api/genes?q=pax
GET /api/expression/{gene}
GET /api/dotplot/{gene}?group_by=leiden
```

## Explorer Features

- UMAP cluster labels are shown at cluster centroids using the `leiden` column.
- UMAP defaults to coloring by `sample`.
- The annotation-value list follows the selected color annotation and controls which cells are visible.
- Gene search recolors the UMAP by expression and renders a dot plot by cluster.
- The sidebar reports total cells, genes, visible cells, cluster count, and gene expression metrics after a gene search.
- The current view is reflected in the URL, similar to Broad Single Cell Portal Explore links.

Example shareable URL:

```text
http://10.65.118.91:5173/?genes=actn3b&annotation=sample&cluster=leiden&annotationValue=Zebra&subsample=all&tab=scatter
```

Supported URL parameters:

```text
genes=actn3b
annotation=sample
cluster=leiden
annotationValue=Zebra
tab=scatter
tab=dotplot
tab=heatmap
```

## Next Improvements

- Add multiple embeddings if the `.h5ad` has UMAP, tSNE, and PCA.
- Add selected-cell download.
- Add dataset description, paper citation, lab contact, and methods.
- Cache gene expression responses for common marker genes.
