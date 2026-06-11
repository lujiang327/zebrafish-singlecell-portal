# Zebrafish Single-Cell Portal

A lightweight web portal for interactively exploring the zebrafish single-cell `.h5ad` dataset in this repository.

The scaffold has two parts:

- `backend/`: FastAPI service for study metadata, cell coordinates, annotations, gene lookup, and `.h5ad` download.
- `frontend/`: React/Vite app with an interactive WebGL UMAP scatter plot.

## Data

The current source dataset is expected at:

```text
annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad
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
python backend/preprocess.py
```

This writes:

```text
data/processed/study.json
data/processed/cells.parquet
data/processed/genes.json
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
GET /api/download/h5ad
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
