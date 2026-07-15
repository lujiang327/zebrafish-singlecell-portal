from __future__ import annotations

from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

DATASETS: list[dict[str, Any]] = [
    {
        "id": "full-cell-types",
        "label": "Full Cell Types",
        "description": "All annotated zebrafish cells after doublet removal.",
        "h5ad": ROOT / "annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad",
        "default_color": "renamed_samples",
        "default_cluster": "celltype",
    },
    {
        "id": "ac-subtypes",
        "label": "AC Subtypes",
        "description": "Amacrine cell subtype-focused zebrafish dataset.",
        "h5ad": ROOT / "AC_subtypes_reproduced.h5ad",
        "default_color": "renamed_samples",
        "default_cluster": "ac_subtype_cluster",
    },
    {
        "id": "bc-subtypes",
        "label": "BC Subtypes",
        "description": "Bipolar cell subtype-focused zebrafish dataset.",
        "h5ad": ROOT / "bc_9_sample_guca1b_gt2_mikiko_no_contam_26_28.h5ad",
        "default_color": "renamed_samples",
        "default_cluster": "leiden_mikiko_merged",
    },
    {
        "id": "rgc-subtypes",
        "label": "RGC Subtypes",
        "description": "Retinal ganglion cell subtype-focused zebrafish dataset.",
        "h5ad": ROOT / "corrected_RGC_annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad",
        "default_color": "renamed_samples",
        "default_cluster": "celltype",
    },
]

DEFAULT_DATASET_ID = DATASETS[0]["id"]
DATASET_BY_ID = {dataset["id"]: dataset for dataset in DATASETS}


def dataset_for(dataset_id: str | None) -> dict[str, Any]:
    return DATASET_BY_ID.get(dataset_id or DEFAULT_DATASET_ID, DATASET_BY_ID[DEFAULT_DATASET_ID])


def public_dataset(dataset: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": dataset["id"],
        "label": dataset["label"],
        "description": dataset["description"],
        "source_file": Path(dataset["h5ad"]).name,
        "default_color": dataset.get("default_color"),
        "default_cluster": dataset.get("default_cluster"),
    }
