from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import anndata as ad
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from scipy import sparse

try:
    from backend.datasets import DATASETS, DEFAULT_DATASET_ID, dataset_for, public_dataset
except ModuleNotFoundError:
    from datasets import DATASETS, DEFAULT_DATASET_ID, dataset_for, public_dataset


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "processed"
H5AD_PATH = Path(os.getenv("H5AD_PATH", ROOT / "annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad"))
EXPRESSION_CACHE_NAME = "expression.h5ad"

cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
allow_all_origins = cors_origins == ["*"]

app = FastAPI(title="Zebrafish Single-Cell Portal API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=not allow_all_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _dataset_dir(dataset: str | None) -> Path:
    return DATA_DIR / dataset_for(dataset)["id"]


def _require_processed(dataset: str | None = None) -> None:
    data_dir = _dataset_dir(dataset)
    missing = [path.name for path in [data_dir / "study.json", data_dir / "cells.parquet", data_dir / "genes.json"] if not path.exists()]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"Processed data missing: {', '.join(missing)}. Run `python backend/preprocess.py` first.",
        )


@lru_cache(maxsize=None)
def _study(dataset: str | None = None) -> dict[str, Any]:
    selected = dataset_for(dataset)
    _require_processed(selected["id"])
    payload = json.loads((_dataset_dir(selected["id"]) / "study.json").read_text(encoding="utf-8"))
    payload["default_color"] = selected.get("default_color")
    payload["default_cluster"] = selected.get("default_cluster")
    payload["expression_label"] = selected.get("expression_label")
    payload["expression_description"] = selected.get("expression_description")
    payload["default_dataset"] = DEFAULT_DATASET_ID
    payload["datasets"] = _datasets_summary()
    return payload


@lru_cache(maxsize=None)
def _cells(dataset: str | None = None) -> pd.DataFrame:
    selected = dataset_for(dataset)
    _require_processed(selected["id"])
    return pd.read_parquet(_dataset_dir(selected["id"]) / "cells.parquet")


@lru_cache(maxsize=None)
def _genes(dataset: str | None = None) -> list[str]:
    selected = dataset_for(dataset)
    _require_processed(selected["id"])
    return json.loads((_dataset_dir(selected["id"]) / "genes.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def _adata(dataset: str | None = None) -> ad.AnnData:
    selected = dataset_for(dataset)
    h5ad_path = Path(selected["h5ad"])
    if selected["id"] == DEFAULT_DATASET_ID and os.getenv("H5AD_PATH"):
        h5ad_path = H5AD_PATH
    if not h5ad_path.exists():
        raise HTTPException(status_code=503, detail=f"h5ad file not found: {h5ad_path}")
    return ad.read_h5ad(h5ad_path, backed="r")


@lru_cache(maxsize=None)
def _expression_adata(dataset: str | None = None) -> ad.AnnData:
    selected = dataset_for(dataset)
    cache_path = _dataset_dir(selected["id"]) / EXPRESSION_CACHE_NAME
    if cache_path.exists():
        cache = ad.read_h5ad(cache_path, backed="r")
        if cache.n_obs == len(_cells(selected["id"])):
            return cache
        cache.file.close()
    return _adata(selected["id"])


def _datasets_summary() -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for dataset in DATASETS:
        public = public_dataset(dataset)
        study_path = _dataset_dir(dataset["id"]) / "study.json"
        if study_path.exists():
            payload = json.loads(study_path.read_text(encoding="utf-8"))
            public["n_cells"] = payload.get("n_cells")
            public["n_genes"] = payload.get("n_genes")
        summaries.append(public)
    return summaries


def _dense_vector(matrix: Any) -> np.ndarray:
    if sparse.issparse(matrix):
        matrix = matrix.toarray()
    return np.asarray(matrix).reshape(-1)


def _expression_var_names(adata: ad.AnnData) -> pd.Index:
    source = adata.raw if adata.raw is not None else adata
    return pd.Index(source.var_names.astype(str))


def _expression_values(adata: ad.AnnData, cell_indices: np.ndarray, gene_idx: int) -> np.ndarray:
    if getattr(adata.X, "format", None) == "csc":
        full_column = _dense_vector(adata.X[:, gene_idx])
        values = full_column[cell_indices]
    elif adata.raw is not None:
        values = _dense_vector(adata.raw.X[cell_indices, gene_idx])
    else:
        values = _dense_vector(adata[cell_indices, gene_idx].X)
    if _expression_source_name(adata) == "raw":
        values = np.clip(values, 0, None)
    return np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0).astype(float)


def _expression_source_name(adata: ad.AnnData) -> str:
    cached_source = adata.uns.get("expression_source")
    if cached_source:
        return str(cached_source)
    return "raw" if adata.raw is not None else "X"


def _values_filter(df: pd.DataFrame, column: str, values: list[str]) -> pd.Series:
    if not values:
        return pd.Series(True, index=df.index)
    if column not in df.columns:
        raise HTTPException(status_code=404, detail=f"Unknown metadata column: {column}")
    return df[column].astype(str).isin(values)


def _filtered_cells(
    sample: list[str],
    cluster: list[str],
    sample_column: str,
    cluster_column: str,
    filter_column: str | None = None,
    filter_value: list[str] | None = None,
    dataset: str | None = None,
) -> pd.DataFrame:
    df = _cells(dataset)
    mask = _values_filter(df, sample_column, sample) & _values_filter(df, cluster_column, cluster)
    if filter_column and filter_value:
        mask = mask & _values_filter(df, filter_column, filter_value)
    return df.loc[mask]


def _column_counts(df: pd.DataFrame, column: str) -> list[dict[str, Any]]:
    if column not in df.columns:
        return []
    counts = df[column].astype(str).replace({"": "Unannotated"}).value_counts()
    return [{"value": str(value), "count": int(count)} for value, count in counts.items()]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/study")
def study(dataset: str | None = None) -> dict[str, Any]:
    return _study(dataset)


@app.get("/api/genes")
def genes(q: str = "", limit: int = 25, dataset: str | None = None) -> dict[str, Any]:
    query = q.strip().lower()
    gene_names = _genes(dataset)
    if not query:
        return {"genes": gene_names[:limit]}

    starts = [gene for gene in gene_names if gene.lower().startswith(query)]
    contains = [gene for gene in gene_names if query in gene.lower() and gene not in starts]
    return {"genes": (starts + contains)[:limit]}


@app.get("/api/cells")
def cells(
    color: str | None = None,
    dataset: str | None = None,
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
) -> dict[str, Any]:
    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value, dataset)
    columns = ["cell_id", "x", "y"]
    if color:
        if color not in df.columns:
            raise HTTPException(status_code=404, detail=f"Unknown metadata column: {color}")
        columns.append(color)
    for column in [sample_column, cluster_column]:
        if column in df.columns and column not in columns:
            columns.append(column)

    labels: list[dict[str, Any]] = []
    if cluster_column in df.columns:
        centroids = (
            df.assign(_cluster=df[cluster_column].astype(str))
            .groupby("_cluster", observed=True)
            .agg(x=("x", "median"), y=("y", "median"), count=("cell_id", "count"))
            .reset_index()
            .sort_values("_cluster", key=lambda s: s.map(lambda v: (not v.isdigit(), int(v) if v.isdigit() else v)))
        )
        labels = [
            {
                "cluster": str(row["_cluster"]),
                "x": float(row["x"]),
                "y": float(row["y"]),
                "count": int(row["count"]),
            }
            for _, row in centroids.iterrows()
        ]

    records = df[columns].replace({np.nan: None}).to_dict(orient="records")
    return {
        "cells": records,
        "color": color,
        "cluster_labels": labels,
        "filter_options": _column_counts(_cells(dataset), filter_column or color) if (filter_column or color) else [],
        "metrics": {
            "visible_cells": int(len(df)),
            "samples": _column_counts(df, sample_column),
            "clusters": _column_counts(df, cluster_column),
        },
    }


@app.get("/api/expression/{gene}")
def expression(
    gene: str,
    dataset: str | None = None,
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
) -> dict[str, Any]:
    adata = _expression_adata(dataset)
    var_names = _expression_var_names(adata)
    matches = np.where(var_names.str.lower() == gene.lower())[0]
    if len(matches) == 0:
        raise HTTPException(status_code=404, detail=f"Gene not found: {gene}")

    idx = int(matches[0])
    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value, dataset)
    cell_indices = df.index.to_numpy()
    values = _expression_values(adata, cell_indices, idx)
    return {
        "gene": str(var_names[idx]),
        "min": float(values.min()) if values.size else 0.0,
        "max": float(values.max()) if values.size else 0.0,
        "mean": float(values.mean()) if values.size else 0.0,
        "pct_expressing": float((values > 0).mean() * 100) if values.size else 0.0,
        "values": values.astype(float).tolist(),
        "expression_source": _expression_source_name(adata),
    }


@app.get("/api/dotplot/{gene}")
def dotplot(
    gene: str,
    dataset: str | None = None,
    group_by: str = "leiden",
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
) -> dict[str, Any]:
    adata = _expression_adata(dataset)
    var_names = _expression_var_names(adata)
    matches = np.where(var_names.str.lower() == gene.lower())[0]
    if len(matches) == 0:
        raise HTTPException(status_code=404, detail=f"Gene not found: {gene}")

    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value, dataset)
    if group_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Unknown metadata column: {group_by}")

    idx = int(matches[0])
    values = _expression_values(adata, df.index.to_numpy(), idx)

    summary = pd.DataFrame({"group": df[group_by].astype(str).to_numpy(), "expression": values})
    grouped = (
        summary.groupby("group", observed=True)
        .agg(
            mean_expression=("expression", "mean"),
            pct_expressing=("expression", lambda s: float((s > 0).mean() * 100)),
            count=("expression", "size"),
        )
        .reset_index()
    )
    grouped = grouped.sort_values("group", key=lambda s: s.map(lambda v: (not v.isdigit(), int(v) if v.isdigit() else v)))

    return {
        "gene": str(var_names[idx]),
        "group_by": group_by,
        "expression_source": _expression_source_name(adata),
        "points": [
            {
                "group": str(row["group"]),
                "mean_expression": float(row["mean_expression"]),
                "pct_expressing": float(row["pct_expressing"]),
                "count": int(row["count"]),
            }
            for _, row in grouped.iterrows()
        ],
    }


@app.get("/api/matrix")
def expression_matrix(
    genes: str,
    dataset: str | None = None,
    group_by: str = "leiden",
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
) -> dict[str, Any]:
    requested = [gene.strip() for gene in genes.split(",") if gene.strip()]
    if not requested:
        raise HTTPException(status_code=400, detail="At least one gene is required.")

    adata = _expression_adata(dataset)
    var_names = _expression_var_names(adata)
    lower_lookup = {name.lower(): i for i, name in enumerate(var_names)}
    gene_indices: list[tuple[str, int]] = []
    missing: list[str] = []
    for gene in requested:
        idx = lower_lookup.get(gene.lower())
        if idx is None:
            missing.append(gene)
        else:
            gene_indices.append((str(var_names[idx]), int(idx)))

    if not gene_indices:
        raise HTTPException(status_code=404, detail=f"No requested genes found: {', '.join(missing)}")

    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value, dataset)
    if group_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Unknown metadata column: {group_by}")

    groups = df[group_by].astype(str).to_numpy()
    ordered_groups = sorted(pd.unique(groups), key=lambda v: (not str(v).isdigit(), int(v) if str(v).isdigit() else str(v)))
    cell_indices = df.index.to_numpy()
    rows: list[dict[str, Any]] = []

    for gene_name, gene_idx in gene_indices:
        values = _expression_values(adata, cell_indices, gene_idx)
        summary = pd.DataFrame({"group": groups, "expression": values})
        grouped = summary.groupby("group", observed=True).agg(
            mean_expression=("expression", "mean"),
            pct_expressing=("expression", lambda s: float((s > 0).mean() * 100)),
            count=("expression", "size"),
        )
        for group in ordered_groups:
            row = grouped.loc[group]
            rows.append(
                {
                    "gene": gene_name,
                    "group": str(group),
                    "mean_expression": float(row["mean_expression"]),
                    "pct_expressing": float(row["pct_expressing"]),
                    "count": int(row["count"]),
                }
            )

    return {
        "genes": [gene for gene, _ in gene_indices],
        "missing": missing,
        "group_by": group_by,
        "groups": [str(group) for group in ordered_groups],
        "expression_source": _expression_source_name(adata),
        "rows": rows,
    }


@app.get("/api/violin")
def violin_expression(
    genes: str,
    dataset: str | None = None,
    group_by: str = "leiden",
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
    max_points_per_group: int = Query(default=400, ge=50, le=1200),
) -> dict[str, Any]:
    requested = [gene.strip() for gene in genes.split(",") if gene.strip()]
    if not requested:
        raise HTTPException(status_code=400, detail="At least one gene is required.")

    adata = _expression_adata(dataset)
    var_names = _expression_var_names(adata)
    lower_lookup = {name.lower(): i for i, name in enumerate(var_names)}
    gene_indices: list[tuple[str, int]] = []
    missing: list[str] = []
    for gene in requested:
        idx = lower_lookup.get(gene.lower())
        if idx is None:
            missing.append(gene)
        else:
            gene_indices.append((str(var_names[idx]), int(idx)))

    if not gene_indices:
        raise HTTPException(status_code=404, detail=f"No requested genes found: {', '.join(missing)}")

    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value, dataset)
    if group_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Unknown metadata column: {group_by}")

    groups = df[group_by].astype(str).to_numpy()
    ordered_groups = sorted(pd.unique(groups), key=lambda v: (not str(v).isdigit(), int(v) if str(v).isdigit() else str(v)))
    cell_indices = df.index.to_numpy()
    rng = np.random.default_rng(7)
    rows: list[dict[str, Any]] = []

    for gene_name, gene_idx in gene_indices:
        values = _expression_values(adata, cell_indices, gene_idx)
        for group in ordered_groups:
            group_mask = groups == group
            group_values = values[group_mask]
            count = int(group_values.size)
            if count > max_points_per_group:
                selected = rng.choice(count, size=max_points_per_group, replace=False)
                sampled = group_values[selected]
            else:
                sampled = group_values
            rows.append(
                {
                    "gene": gene_name,
                    "group": str(group),
                    "values": sampled.astype(float).tolist(),
                    "count": count,
                    "sampled_count": int(sampled.size),
                    "mean_expression": float(group_values.mean()) if count else 0.0,
                    "pct_expressing": float((group_values > 0).mean() * 100) if count else 0.0,
                }
            )

    return {
        "genes": [gene for gene, _ in gene_indices],
        "missing": missing,
        "group_by": group_by,
        "groups": [str(group) for group in ordered_groups],
        "max_points_per_group": max_points_per_group,
        "expression_source": _expression_source_name(adata),
        "rows": rows,
    }
