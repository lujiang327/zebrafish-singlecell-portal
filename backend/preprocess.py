from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import anndata as ad
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_H5AD = ROOT / "annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad"
DEFAULT_OUT = ROOT / "data" / "processed"


def _json_safe(value: Any) -> Any:
    if pd.isna(value):
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    return str(value)


def _series_kind(series: pd.Series) -> str:
    if pd.api.types.is_numeric_dtype(series):
        return "numeric"
    return "categorical"


def _embedding_key(obsm_keys: list[str]) -> str:
    preferred = ["X_umap", "X_tsne", "X_pca"]
    for key in preferred:
        if key in obsm_keys:
            return key
    if not obsm_keys:
        raise ValueError("No embeddings found in adata.obsm. Expected X_umap, X_tsne, or similar.")
    return obsm_keys[0]


def preprocess(h5ad_path: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    adata = ad.read_h5ad(h5ad_path, backed="r")

    obs = adata.obs.copy()
    obs.insert(0, "cell_id", obs.index.astype(str))

    embedding_name = _embedding_key(list(adata.obsm.keys()))
    embedding = np.asarray(adata.obsm[embedding_name])
    if embedding.ndim != 2 or embedding.shape[1] < 2:
        raise ValueError(f"Embedding {embedding_name!r} must be a 2D matrix with at least two columns.")

    cells = pd.DataFrame(
        {
            "cell_id": obs["cell_id"].astype(str),
            "x": embedding[:, 0],
            "y": embedding[:, 1],
        }
    )

    metadata_columns: list[dict[str, Any]] = []
    for column in obs.columns:
        if column == "cell_id":
            continue

        series = obs[column]
        safe_name = str(column)
        cells[safe_name] = series.astype(str).replace({"nan": ""}).to_numpy()

        values = series.dropna()
        summary: dict[str, Any] = {
            "name": safe_name,
            "kind": _series_kind(series),
            "n_unique": int(values.nunique()),
        }
        if summary["kind"] == "categorical":
            counts = values.astype(str).value_counts().head(50)
            summary["top_values"] = [
                {"value": _json_safe(label), "count": int(count)}
                for label, count in counts.items()
            ]
        else:
            summary["min"] = _json_safe(values.min()) if len(values) else None
            summary["max"] = _json_safe(values.max()) if len(values) else None
        metadata_columns.append(summary)

    cells.to_parquet(out_dir / "cells.parquet", index=False)

    genes = pd.Index(adata.var_names.astype(str)).drop_duplicates().tolist()
    (out_dir / "genes.json").write_text(json.dumps(genes), encoding="utf-8")

    study = {
        "title": "Zebrafish Single-Cell Portal",
        "description": "Interactive viewer for the annotated zebrafish single-cell dataset.",
        "source_file": h5ad_path.name,
        "n_cells": int(adata.n_obs),
        "n_genes": int(adata.n_vars),
        "embedding": embedding_name,
        "metadata_columns": metadata_columns,
        "obsm_keys": list(map(str, adata.obsm.keys())),
    }
    (out_dir / "study.json").write_text(json.dumps(study, indent=2), encoding="utf-8")

    print(f"Wrote {out_dir / 'study.json'}")
    print(f"Wrote {out_dir / 'cells.parquet'}")
    print(f"Wrote {out_dir / 'genes.json'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Preprocess an h5ad file for the web portal.")
    parser.add_argument("--h5ad", type=Path, default=DEFAULT_H5AD)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    preprocess(args.h5ad.resolve(), args.out.resolve())


if __name__ == "__main__":
    main()
