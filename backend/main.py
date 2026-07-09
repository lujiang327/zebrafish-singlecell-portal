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


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "processed"
H5AD_PATH = Path(os.getenv("H5AD_PATH", ROOT / "annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad"))

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


def _require_processed() -> None:
    missing = [path.name for path in [DATA_DIR / "study.json", DATA_DIR / "cells.parquet", DATA_DIR / "genes.json"] if not path.exists()]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"Processed data missing: {', '.join(missing)}. Run `python backend/preprocess.py` first.",
        )


@lru_cache(maxsize=1)
def _study() -> dict[str, Any]:
    _require_processed()
    return json.loads((DATA_DIR / "study.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _cells() -> pd.DataFrame:
    _require_processed()
    return pd.read_parquet(DATA_DIR / "cells.parquet")


@lru_cache(maxsize=1)
def _genes() -> list[str]:
    _require_processed()
    return json.loads((DATA_DIR / "genes.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _adata() -> ad.AnnData:
    if not H5AD_PATH.exists():
        raise HTTPException(status_code=503, detail=f"h5ad file not found: {H5AD_PATH}")
    return ad.read_h5ad(H5AD_PATH, backed="r")


def _dense_vector(matrix: Any) -> np.ndarray:
    if sparse.issparse(matrix):
        matrix = matrix.toarray()
    return np.asarray(matrix).reshape(-1)


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
) -> pd.DataFrame:
    df = _cells()
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
def study() -> dict[str, Any]:
    return _study()


@app.get("/api/genes")
def genes(q: str = "", limit: int = 25) -> dict[str, Any]:
    query = q.strip().lower()
    gene_names = _genes()
    if not query:
        return {"genes": gene_names[:limit]}

    starts = [gene for gene in gene_names if gene.lower().startswith(query)]
    contains = [gene for gene in gene_names if query in gene.lower() and gene not in starts]
    return {"genes": (starts + contains)[:limit]}


@app.get("/api/cells")
def cells(
    color: str | None = None,
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
) -> dict[str, Any]:
    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value)
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
        "filter_options": _column_counts(_cells(), filter_column or color) if (filter_column or color) else [],
        "metrics": {
            "visible_cells": int(len(df)),
            "samples": _column_counts(df, sample_column),
            "clusters": _column_counts(df, cluster_column),
        },
    }


@app.get("/api/expression/{gene}")
def expression(
    gene: str,
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
) -> dict[str, Any]:
    adata = _adata()
    var_names = pd.Index(adata.var_names.astype(str))
    matches = np.where(var_names.str.lower() == gene.lower())[0]
    if len(matches) == 0:
        raise HTTPException(status_code=404, detail=f"Gene not found: {gene}")

    idx = int(matches[0])
    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value)
    cell_indices = df.index.to_numpy()
    values = _dense_vector(adata[cell_indices, idx].X)
    values = np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)
    return {
        "gene": str(var_names[idx]),
        "min": float(values.min()) if values.size else 0.0,
        "max": float(values.max()) if values.size else 0.0,
        "mean": float(values.mean()) if values.size else 0.0,
        "pct_expressing": float((values > 0).mean() * 100) if values.size else 0.0,
        "values": values.astype(float).tolist(),
    }


@app.get("/api/dotplot/{gene}")
def dotplot(
    gene: str,
    group_by: str = "leiden",
    sample: list[str] = Query(default=[]),
    cluster: list[str] = Query(default=[]),
    filter_value: list[str] = Query(default=[]),
    filter_column: str | None = None,
    sample_column: str = "sample",
    cluster_column: str = "leiden",
) -> dict[str, Any]:
    adata = _adata()
    var_names = pd.Index(adata.var_names.astype(str))
    matches = np.where(var_names.str.lower() == gene.lower())[0]
    if len(matches) == 0:
        raise HTTPException(status_code=404, detail=f"Gene not found: {gene}")

    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value)
    if group_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Unknown metadata column: {group_by}")

    idx = int(matches[0])
    values = _dense_vector(adata[df.index.to_numpy(), idx].X)
    values = np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)

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

    adata = _adata()
    var_names = pd.Index(adata.var_names.astype(str))
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

    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value)
    if group_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Unknown metadata column: {group_by}")

    groups = df[group_by].astype(str).to_numpy()
    ordered_groups = sorted(pd.unique(groups), key=lambda v: (not str(v).isdigit(), int(v) if str(v).isdigit() else str(v)))
    cell_indices = df.index.to_numpy()
    rows: list[dict[str, Any]] = []

    for gene_name, gene_idx in gene_indices:
        values = _dense_vector(adata[cell_indices, gene_idx].X)
        values = np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)
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
        "rows": rows,
    }


@app.get("/api/violin")
def violin_expression(
    genes: str,
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

    adata = _adata()
    var_names = pd.Index(adata.var_names.astype(str))
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

    df = _filtered_cells(sample, cluster, sample_column, cluster_column, filter_column, filter_value)
    if group_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Unknown metadata column: {group_by}")

    groups = df[group_by].astype(str).to_numpy()
    ordered_groups = sorted(pd.unique(groups), key=lambda v: (not str(v).isdigit(), int(v) if str(v).isdigit() else str(v)))
    cell_indices = df.index.to_numpy()
    rng = np.random.default_rng(7)
    rows: list[dict[str, Any]] = []

    for gene_name, gene_idx in gene_indices:
        values = _dense_vector(adata[cell_indices, gene_idx].X)
        values = np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0).astype(float)
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
        "rows": rows,
    }
