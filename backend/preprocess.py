from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import anndata as ad
import numpy as np
import pandas as pd
from scipy import sparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_H5AD = ROOT / "annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad"
DEFAULT_OUT = ROOT / "data" / "processed"
EXPRESSION_CACHE_NAME = "expression.h5ad"

try:
    from backend.datasets import DATASETS, DEFAULT_DATASET_ID, public_dataset
except ModuleNotFoundError:
    from datasets import DATASETS, DEFAULT_DATASET_ID, public_dataset


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


def _expression_source(adata: ad.AnnData) -> tuple[Any, str]:
    if adata.raw is not None:
        return adata.raw, "raw"
    return adata, "X"


def _expression_cache_is_current(cache_path: Path, source_path: Path, expected_shape: tuple[int, int]) -> bool:
    if not cache_path.exists():
        return False

    cache: ad.AnnData | None = None
    try:
        cache = ad.read_h5ad(cache_path, backed="r")
        stat = source_path.stat()
        return (
            cache.shape == expected_shape
            and str(cache.uns.get("storage_format", "")) == "csc"
            and int(cache.uns.get("source_size", -1)) == stat.st_size
            and int(cache.uns.get("source_mtime_ns", -1)) == stat.st_mtime_ns
        )
    except (OSError, ValueError, KeyError):
        return False
    finally:
        if cache is not None and cache.file.is_open:
            cache.file.close()


def write_expression_cache(
    adata: ad.AnnData,
    source_path: Path,
    out_dir: Path,
    force: bool = False,
) -> Path:
    source, source_name = _expression_source(adata)
    cache_path = out_dir / EXPRESSION_CACHE_NAME
    expected_shape = (adata.n_obs, source.n_vars)
    if not force and _expression_cache_is_current(cache_path, source_path, expected_shape):
        print(f"Reusing {cache_path}")
        return cache_path

    print(f"Building CSC expression cache from adata.{source_name}; this can take several minutes.")
    matrix = source.X
    if hasattr(matrix, "to_memory"):
        matrix = matrix.to_memory()
    if sparse.issparse(matrix):
        matrix = matrix.tocsc(copy=False)
    else:
        matrix = sparse.csc_matrix(np.asarray(matrix))

    stat = source_path.stat()
    cache = ad.AnnData(
        X=matrix,
        obs=pd.DataFrame(index=pd.Index(adata.obs_names.astype(str), name=adata.obs_names.name)),
        var=pd.DataFrame(index=pd.Index(source.var_names.astype(str), name=source.var_names.name)),
    )
    cache.uns["expression_source"] = source_name
    cache.uns["storage_format"] = "csc"
    cache.uns["source_file"] = source_path.name
    cache.uns["source_size"] = stat.st_size
    cache.uns["source_mtime_ns"] = stat.st_mtime_ns

    temporary_path = cache_path.with_suffix(".h5ad.tmp")
    temporary_path.unlink(missing_ok=True)
    try:
        cache.write_h5ad(temporary_path, compression="gzip", compression_opts=4)
        temporary_path.replace(cache_path)
    finally:
        temporary_path.unlink(missing_ok=True)

    print(f"Wrote {cache_path}")
    return cache_path


def preprocess(
    h5ad_path: Path,
    out_dir: Path,
    dataset: dict[str, Any] | None = None,
    expression_cache: bool = False,
    force_expression_cache: bool = False,
) -> dict[str, Any]:
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

    public = public_dataset(dataset) if dataset else None
    study = {
        "id": public["id"] if public else "custom",
        "label": public["label"] if public else h5ad_path.stem,
        "title": public.get("study_title", "Single Cell Portal") if public else "Single Cell Portal",
        "description": public["description"] if public else "Interactive viewer for the annotated zebrafish single-cell dataset.",
        "source_file": h5ad_path.name,
        "n_cells": int(adata.n_obs),
        "n_genes": int(adata.n_vars),
        "embedding": embedding_name,
        "metadata_columns": metadata_columns,
        "obsm_keys": list(map(str, adata.obsm.keys())),
        "default_color": public.get("default_color") if public else None,
        "default_cluster": public.get("default_cluster") if public else None,
        "expression_label": public.get("expression_label") if public else None,
        "expression_description": public.get("expression_description") if public else None,
    }
    (out_dir / "study.json").write_text(json.dumps(study, indent=2), encoding="utf-8")

    print(f"Wrote {out_dir / 'study.json'}")
    print(f"Wrote {out_dir / 'cells.parquet'}")
    print(f"Wrote {out_dir / 'genes.json'}")
    if expression_cache:
        write_expression_cache(adata, h5ad_path, out_dir, force=force_expression_cache)
    if adata.file.is_open:
        adata.file.close()
    return study


def preprocess_all(out_dir: Path, expression_cache: bool = False, force_expression_cache: bool = False) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    dataset_summaries: list[dict[str, Any]] = []
    for dataset in DATASETS:
        dataset_out = out_dir / dataset["id"]
        summary = preprocess(
            Path(dataset["h5ad"]).resolve(),
            dataset_out.resolve(),
            dataset,
            expression_cache=expression_cache,
            force_expression_cache=force_expression_cache,
        )
        dataset_summaries.append(
            {
                "id": summary["id"],
                "study_id": public_dataset(dataset).get("study_id"),
                "label": summary["label"],
                "description": summary["description"],
                "source_file": summary["source_file"],
                "n_cells": summary["n_cells"],
                "n_genes": summary["n_genes"],
                "default_color": summary.get("default_color"),
                "default_cluster": summary.get("default_cluster"),
            }
        )

    index = {
        "title": "Single Cell Portal",
        "description": "Interactive viewer for retinal single-cell studies and focused datasets.",
        "default_dataset": DEFAULT_DATASET_ID,
        "datasets": dataset_summaries,
    }
    (out_dir / "study.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"Wrote {out_dir / 'study.json'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Preprocess h5ad files for the web portal.")
    parser.add_argument("--h5ad", type=Path, default=DEFAULT_H5AD)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--all", action="store_true", help="Preprocess all registered study datasets.")
    parser.add_argument(
        "--expression-cache",
        action="store_true",
        help="Build a CSC expression cache optimized for gene-column API queries.",
    )
    parser.add_argument(
        "--force-expression-cache",
        action="store_true",
        help="Rebuild the CSC expression cache even when it matches the source H5AD.",
    )
    args = parser.parse_args()
    if args.all:
        preprocess_all(args.out.resolve(), args.expression_cache, args.force_expression_cache)
    else:
        preprocess(
            args.h5ad.resolve(),
            args.out.resolve(),
            expression_cache=args.expression_cache,
            force_expression_cache=args.force_expression_cache,
        )


if __name__ == "__main__":
    main()
