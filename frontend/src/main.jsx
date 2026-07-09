import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Plotly from "plotly.js-dist-min";
import { ArrowLeft, Download, Dna, Eye, EyeOff, Loader2, RefreshCcw, Search } from "lucide-react";
import "./styles.css";

const API_BASE =
  import.meta.env.VITE_API_BASE ?? `${window.location.protocol}//${window.location.hostname}:8000`;

const STUDIES = [
  {
    id: "zebrafish-singlecell",
    title: "Zebrafish Single-Cell Portal",
    species: "Zebrafish",
    tissue: "Single-cell RNA-seq",
    status: "Ready",
    description:
      "Interactive UMAP, annotation filters, gene expression, dot plots, and heat maps for the processed zebrafish single-cell study.",
  },
];

const EXPLORE_TABS = [
  { id: "scatter", label: "Scatter" },
  { id: "dotplot", label: "Dot plot" },
  { id: "violin", label: "Violin plot" },
  { id: "heatmap", label: "Heat map" },
];

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `Request failed: ${response.status}`);
  }
  return payload;
}

const HIDDEN_COLOR_COLUMNS = new Set(["sample"]);
const HIDDEN_CLUSTER_COLUMNS = new Set(["sample", "renamed_samples"]);
const COLUMN_LABELS = {
  renamed_samples: "samples",
  leiden: "cell clusters",
};

function titleCaseLabel(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayColumnName(name) {
  return titleCaseLabel(COLUMN_LABELS[name] ?? name);
}

function displayValue(value) {
  return titleCaseLabel(value || "Unannotated");
}

function visibleColorColumns(columns) {
  return columns.filter((column) => column.kind === "categorical" && !HIDDEN_COLOR_COLUMNS.has(column.name));
}

function visibleClusterColumns(columns) {
  return columns.filter((column) => column.kind === "categorical" && !HIDDEN_CLUSTER_COLUMNS.has(column.name));
}

function chooseDefaultColumn(columns) {
  const names = visibleColorColumns(columns).map((column) => column.name);
  const preferred = [
    "renamed_samples",
    "cell_type",
    "celltype",
    "cell_type_LEC_type",
    "leiden",
    "seurat_clusters",
    "cluster",
    "annotation",
  ];
  return preferred.find((name) => names.includes(name)) ?? names[0] ?? "";
}

function categoricalColorMap(labels) {
  const palette = [
    "#2563eb",
    "#dc2626",
    "#16a34a",
    "#9333ea",
    "#d97706",
    "#0891b2",
    "#be123c",
    "#4f46e5",
    "#65a30d",
    "#c2410c",
    "#0f766e",
    "#7c3aed",
  ];
  const unique = Array.from(new Set(labels.map((label) => label || "Unannotated"))).sort();
  return new Map(unique.map((label, index) => [label, palette[index % palette.length]]));
}

function sortedValues(values) {
  return [...values].sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    return String(a).localeCompare(String(b));
  });
}

function valueList(columns, name) {
  const column = columns.find((item) => item.name === name);
  return sortedValues((column?.top_values ?? []).map((item) => String(item.value)));
}

function splitParam(values) {
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function parseGenes(value) {
  return value
    .split(/[,\s]+/)
    .map((gene) => gene.trim())
    .filter(Boolean);
}

function activeGeneToken(value) {
  const match = value.match(/(?:^|[,\s]+)([^,\s]*)$/);
  return match ? match[1] : value.trim();
}

function replaceActiveGeneToken(value, gene) {
  const trimmedGene = gene.trim();
  if (!value.trim()) return trimmedGene;
  if (/[,\s]$/.test(value)) return `${value}${trimmedGene}`;
  return value.replace(/([^,\s]*)$/, trimmedGene);
}

function clusterLabelAnnotations(clusterLabels) {
  return clusterLabels.map((label) => ({
    x: label.x,
    y: label.y,
    text: displayValue(label.cluster),
    showarrow: false,
    xanchor: "center",
    yanchor: "middle",
    bgcolor: "rgba(255, 255, 255, 0.86)",
    bordercolor: "rgba(127, 29, 29, 0.7)",
    borderpad: 2,
    font: { color: "#dc2626", size: 14, family: "Arial Black, Inter, sans-serif" },
    captureevents: false,
  }));
}

function dotSizeFromPercent(value, maxSize = 8) {
  return Math.min(maxSize, Math.max(1.6, Math.sqrt(value) * maxSize * 0.1));
}

function dotPlotMaxSize(geneCount, groupCount) {
  const geneSpace = geneCount <= 2 ? 13 : geneCount <= 5 ? 11 : geneCount <= 12 ? 8 : 6;
  const groupSpace = groupCount <= 25 ? 11 : groupCount <= 60 ? 7 : groupCount <= 100 ? 4.8 : 3.6;
  return Math.max(2.4, Math.min(geneSpace, groupSpace));
}

function dotPlotHeight(groupCount) {
  return Math.max(620, Math.min(1800, groupCount * 11 + 260));
}

function StudyExplorer({ studyConfig = STUDIES[0] }) {
  const plotRef = useRef(null);
  const dotplotRef = useRef(null);
  const violinRef = useRef(null);
  const heatmapRef = useRef(null);
  const [study, setStudy] = useState(null);
  const [cells, setCells] = useState([]);
  const [clusterLabels, setClusterLabels] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [colorBy, setColorBy] = useState("");
  const [clusterColumn, setClusterColumn] = useState("leiden");
  const [selectedAnnotationValues, setSelectedAnnotationValues] = useState([]);
  const [filterOptions, setFilterOptions] = useState([]);
  const [geneQuery, setGeneQuery] = useState("");
  const [pendingGene, setPendingGene] = useState("");
  const [geneResult, setGeneResult] = useState(null);
  const [matrixResult, setMatrixResult] = useState(null);
  const [violinResult, setViolinResult] = useState(null);
  const [geneOptions, setGeneOptions] = useState([]);
  const [activeTab, setActiveTab] = useState("scatter");
  const [pointSize, setPointSize] = useState(2);
  const [showClusterLabels, setShowClusterLabels] = useState(true);
  const [loading, setLoading] = useState(true);
  const [plotLoading, setPlotLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function boot() {
      try {
        const studyPayload = await getJson("/api/study");
        const query = new URLSearchParams(window.location.search);
        const columns = studyPayload.metadata_columns ?? [];
        const colorColumnNames = visibleColorColumns(columns).map((column) => column.name);
        const clusterColumnNames = visibleClusterColumns(columns).map((column) => column.name);
        const defaultColumn = chooseDefaultColumn(studyPayload.metadata_columns ?? []);
        const urlAnnotation = query.get("annotation");
        const urlClusterColumn = query.get("cluster");
        const urlGenes = query.get("genes") || query.get("gene") || "";
        const urlTab = query.get("tab");

        setStudy(studyPayload);
        const selectedAnnotation = urlAnnotation && colorColumnNames.includes(urlAnnotation) ? urlAnnotation : defaultColumn;
        setColorBy(selectedAnnotation);
        if (urlClusterColumn && clusterColumnNames.includes(urlClusterColumn)) {
          setClusterColumn(urlClusterColumn);
        } else if (clusterColumnNames.includes("leiden")) {
          setClusterColumn("leiden");
        } else if (clusterColumnNames.length) {
          setClusterColumn(clusterColumnNames[0]);
        }
        const urlFilterValues = splitParam([
          ...query.getAll("annotationValue"),
          ...query.getAll("filterValue"),
          ...(selectedAnnotation === "sample" ? query.getAll("sample") : []),
        ]);
        setSelectedAnnotationValues(urlFilterValues);
        if (urlGenes) {
          const genes = parseGenes(urlGenes).join(", ");
          setGeneQuery(genes);
          setPendingGene(genes);
        }
        if (EXPLORE_TABS.some((tab) => tab.id === urlTab)) setActiveTab(urlTab);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    boot();
  }, []);

  useEffect(() => {
    if (!colorBy && !study) return;
    async function loadCells() {
      try {
        setPlotLoading(true);
        const geneToReload = pendingGene || geneQuery.trim() || geneResult?.gene || "";
        if (!geneToReload) {
          setGeneResult(null);
          setMatrixResult(null);
          setViolinResult(null);
        }
        const suffix = colorBy ? `?color=${encodeURIComponent(colorBy)}` : "";
        const params = new URLSearchParams(suffix);
        params.set("cluster_column", clusterColumn);
        if (colorBy) params.set("filter_column", colorBy);
        selectedAnnotationValues.forEach((value) => params.append("filter_value", value));
        const payload = await getJson(`/api/cells?${params.toString()}`);
        setCells(payload.cells);
        setClusterLabels(payload.cluster_labels ?? []);
        setMetrics(payload.metrics ?? null);
        setFilterOptions(payload.filter_options ?? []);
        if (geneToReload) {
          await loadGene(geneToReload);
          setPendingGene("");
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setPlotLoading(false);
      }
    }
    loadCells();
  }, [colorBy, study, clusterColumn, selectedAnnotationValues]);

  useEffect(() => {
    if (loading || !study) return;
    const params = new URLSearchParams();
    params.set("tab", activeTab);
    if (matrixResult?.genes?.length || geneQuery.trim()) params.set("genes", matrixResult?.genes?.join(",") ?? geneQuery.trim());
    if (colorBy) params.set("annotation", colorBy);
    if (clusterColumn) params.set("cluster", clusterColumn);
    params.set("subsample", "all");
    selectedAnnotationValues.forEach((value) => params.append("annotationValue", value));
    const nextUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", nextUrl);
  }, [activeTab, clusterColumn, colorBy, geneQuery, geneResult, loading, selectedAnnotationValues, study]);

  useEffect(() => {
    const query = activeGeneToken(geneQuery.trim());
    if (query.length < 1) {
      setGeneOptions([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const payload = await getJson(`/api/genes?q=${encodeURIComponent(query)}&limit=8`);
        setGeneOptions(payload.genes);
      } catch {
        setGeneOptions([]);
      }
    }, 180);
    return () => clearTimeout(handle);
  }, [geneQuery]);

  async function chooseGeneSuggestion(gene) {
    const nextQuery = replaceActiveGeneToken(geneQuery, gene);
    setGeneQuery(nextQuery);
    setGeneOptions([]);
    await loadGene(nextQuery);
  }

  async function loadGene(geneName = geneQuery) {
    const gene = geneName.trim();
    if (!gene) return;
    try {
      setPlotLoading(true);
      const params = new URLSearchParams({
        cluster_column: clusterColumn,
      });
      if (colorBy) params.set("filter_column", colorBy);
      selectedAnnotationValues.forEach((value) => params.append("filter_value", value));
      const genes = parseGenes(gene);
      const firstGene = genes[0];
      const payload = await getJson(`/api/expression/${encodeURIComponent(firstGene)}?${params.toString()}`);
      const matrixPayload = await getJson(
        `/api/matrix?genes=${encodeURIComponent(genes.join(","))}&group_by=${encodeURIComponent(clusterColumn)}&${params.toString()}`,
      );
      const violinPayload = await getJson(
        `/api/violin?genes=${encodeURIComponent(genes.join(","))}&group_by=${encodeURIComponent(clusterColumn)}&${params.toString()}`,
      );
      setGeneResult(payload);
      setMatrixResult(matrixPayload);
      setViolinResult(violinPayload);
      setGeneQuery(matrixPayload.genes.join(", "));
      setGeneOptions([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlotLoading(false);
    }
  }

  const colorColumns = visibleColorColumns(study?.metadata_columns ?? []);
  const clusterColumns = visibleClusterColumns(study?.metadata_columns ?? []);
  const visibleCellCount = metrics?.visible_cells ?? cells.length;
  const annotationFilterItems = filterOptions.map((item) => ({ ...item, value: String(item.value) }));
  const colorLabels = useMemo(
    () => (annotationFilterItems.length ? annotationFilterItems.map((item) => item.value) : cells.map((cell) => (colorBy ? cell[colorBy] || "Unannotated" : "Cells"))),
    [annotationFilterItems, cells, colorBy],
  );
  const colorMap = useMemo(() => categoricalColorMap(colorLabels), [colorLabels]);
  const legendItems = useMemo(() => {
    if (annotationFilterItems.length) {
      return annotationFilterItems.map((item) => ({
        label: item.value,
        count: item.count,
        color: colorMap.get(item.value) ?? "#64748b",
      }));
    }
    const counts = new Map();
    for (const label of colorLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
    return sortedValues([...counts.keys()]).map((label) => ({
      label,
      count: counts.get(label) ?? 0,
      color: colorMap.get(label) ?? "#64748b",
    }));
  }, [annotationFilterItems, colorLabels, colorMap]);
  const geneDisplay = matrixResult?.genes?.join(", ") || geneResult?.gene || geneQuery || "none";
  const isScatterTab = activeTab === "scatter";
  const isDotplotTab = activeTab === "dotplot";
  const isViolinTab = activeTab === "violin";
  const isHeatmapTab = activeTab === "heatmap";
  const sidebarTitle = isDotplotTab ? "Dot plot" : isViolinTab ? "Violin plot" : isHeatmapTab ? "Heat map" : "Scatter plot";
  const sidebarDescription = isDotplotTab
    ? "Compare selected gene expression across the current groups."
    : isViolinTab
      ? "Review per-cell expression distributions across the current groups."
      : isHeatmapTab
        ? "Review mean expression patterns across the current groups."
        : "Color, filter, and query expression across the current UMAP view.";
  const clearGeneLabel = isScatterTab ? "Clear gene color" : "Clear genes";
  const clearGeneTitle = isScatterTab
    ? "Clear gene expression overlay and return to annotation colors"
    : "Clear selected genes and reset expression plots";

  const plotData = useMemo(() => {
    const x = cells.map((cell) => cell.x);
    const y = cells.map((cell) => cell.y);
    const text = cells.map((cell) => {
      const annotation = colorBy ? `<br>${displayColumnName(colorBy)}: ${cell[colorBy] || "Unannotated"}` : "";
      return `${cell.cell_id}${annotation}`;
    });

    if (geneResult) {
      const traces = [
        {
          type: "scattergl",
          name: geneResult.gene,
          showlegend: false,
          mode: "markers",
          x,
          y,
          text,
          hoverinfo: "text",
          marker: {
            color: geneResult.values,
            colorscale: [
              [0, "#d1d5db"],
              [0.45, "#fde68a"],
              [1, "#dc2626"],
            ],
            showscale: true,
            colorbar: { title: geneResult.gene },
            cmin: geneResult.min,
            cmax: geneResult.max,
            size: pointSize,
            opacity: 0.78,
          },
        },
      ];

      return traces;
    }

    const labels = cells.map((cell) => (colorBy ? cell[colorBy] || "Unannotated" : "Cells"));
    const traces = [
      {
        type: "scattergl",
        name: colorBy || "Cells",
        showlegend: false,
        mode: "markers",
        x,
        y,
        text,
        hoverinfo: "text",
        marker: {
          color: labels.map((label) => colorMap.get(label) ?? "#64748b"),
          size: pointSize,
          opacity: 0.82,
        },
      },
    ];

    return traces;
  }, [cells, colorBy, geneResult, clusterLabels, pointSize, colorMap, showClusterLabels]);

  useEffect(() => {
    if (!plotRef.current || cells.length === 0) return;

    const layout = {
      autosize: true,
      margin: { l: 46, r: 18, t: 12, b: 42 },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      xaxis: {
        title: "UMAP 1",
        zeroline: true,
        zerolinecolor: "#555555",
        zerolinewidth: 1,
        showgrid: false,
      },
      yaxis: {
        title: "UMAP 2",
        zeroline: true,
        zerolinecolor: "#555555",
        zerolinewidth: 1,
        showgrid: false,
      },
      dragmode: "lasso",
      hovermode: "closest",
      showlegend: false,
      annotations: showClusterLabels ? clusterLabelAnnotations(clusterLabels) : [],
    };

    const config = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["sendDataToCloud"],
      toImageButtonOptions: { filename: geneResult ? `${geneResult.gene}-umap` : "umap", scale: 2 },
    };

    Plotly.react(plotRef.current, plotData, layout, config);
  }, [cells.length, plotData, showClusterLabels, clusterLabels]);

  useEffect(() => {
    if (!dotplotRef.current) return;
    if (!matrixResult) {
      Plotly.purge(dotplotRef.current);
      return;
    }

    const rows = matrixResult.rows ?? [];
    const geneIndex = new Map(matrixResult.genes.map((gene, index) => [gene, index]));
    const geneCount = Math.max(matrixResult.genes.length, 1);
    const groupCount = Math.max(matrixResult.groups.length, 1);
    const maxDotSize = dotPlotMaxSize(geneCount, groupCount);
    const plotHeight = dotPlotHeight(groupCount);
    const rowTickFontSize = groupCount > 100 ? 8 : groupCount > 70 ? 9 : 10;
    const xRange = geneCount <= 3 ? [-1.5, geneCount + 0.5] : [-0.6, geneCount - 0.4];
    const meanValues = rows.map((row) => row.mean_expression);
    const minMean = Math.min(...meanValues);
    const maxMean = Math.max(...meanValues);
    const expressionScale = rows.map((row) => (maxMean > minMean ? (row.mean_expression - minMean) / (maxMean - minMean) : 0));
    const data = [
      {
        type: "scatter",
        mode: "markers",
        showlegend: false,
        x: rows.map((row) => geneIndex.get(row.gene) ?? 0),
        y: rows.map((row) => row.group),
        text: rows.map(
          (row, index) =>
            `${row.gene}<br>${displayColumnName(clusterColumn)}: ${row.group}<br>Mean expression: ${row.mean_expression.toFixed(3)}<br>Relative expression: ${expressionScale[index].toFixed(3)}<br>Fraction expressing: ${row.pct_expressing.toFixed(1)}%<br>Cells: ${row.count.toLocaleString()}`,
        ),
        hoverinfo: "text",
        marker: {
          color: expressionScale,
          colorscale: [
            [0, "#d1d5db"],
            [0.45, "#fde68a"],
            [1, "#dc2626"],
          ],
          cmin: 0,
          cmax: 1,
          showscale: true,
          colorbar: { title: "Relative mean<br>expression", thickness: 12, len: 0.36, y: 0.77, yanchor: "middle", x: 1.02 },
          size: rows.map((row) => dotSizeFromPercent(row.pct_expressing, maxDotSize)),
          sizemode: "diameter",
          opacity: 0.95,
          line: { color: "#9ca3af", width: 0.5 },
        },
      },
    ];

    Plotly.react(
      dotplotRef.current,
      data,
      {
        autosize: true,
        height: plotHeight,
        margin: { l: groupCount > 70 ? 62 : 78, r: 112, t: 18, b: 118 },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        xaxis: {
          title: "",
          type: "linear",
          range: xRange,
          tickmode: "array",
          tickvals: matrixResult.genes.map((_, index) => index),
          ticktext: matrixResult.genes,
          automargin: true,
          tickangle: -90,
          tickfont: { size: 11 },
          showgrid: false,
          zeroline: false,
          showline: true,
          mirror: true,
          linecolor: "#475569",
          linewidth: 1,
        },
        yaxis: {
          title: "",
          type: "category",
          categoryarray: matrixResult.groups,
          autorange: "reversed",
          automargin: true,
          tickfont: { size: rowTickFontSize },
          showgrid: false,
          zeroline: false,
          showline: true,
          mirror: true,
          linecolor: "#475569",
          linewidth: 1,
        },
      },
      { responsive: true, displaylogo: false, toImageButtonOptions: { filename: "gene-dot-plot", scale: 2 } },
    );
  }, [matrixResult, clusterColumn]);

  useEffect(() => {
    if (!violinRef.current) return;
    if (!violinResult) {
      Plotly.purge(violinRef.current);
      return;
    }

    const rows = violinResult.rows ?? [];
    const groupCount = Math.max(violinResult.groups.length, 1);
    const rowTickFontSize = groupCount > 100 ? 8 : groupCount > 70 ? 9 : 10;
    const palette = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#d97706", "#0891b2"];
    const data = violinResult.genes.map((gene, index) => {
      const x = [];
      const y = [];
      const text = [];
      rows.filter((row) => row.gene === gene).forEach((row) => {
        row.values.forEach((value) => {
          x.push(value);
          y.push(row.group);
          text.push(`${gene}<br>${displayColumnName(clusterColumn)}: ${row.group}<br>Expression: ${Number(value).toFixed(3)}<br>Cells: ${row.count.toLocaleString()}<br>Sampled: ${row.sampled_count.toLocaleString()}`);
        });
      });
      return {
        type: "violin",
        name: gene,
        orientation: "h",
        x,
        y,
        text,
        hoverinfo: "text",
        points: false,
        box: { visible: true, width: 0.22 },
        meanline: { visible: true },
        spanmode: "soft",
        line: { color: palette[index % palette.length], width: 1.2 },
        fillcolor: palette[index % palette.length],
        opacity: violinResult.genes.length > 1 ? 0.58 : 0.72,
      };
    });

    Plotly.react(
      violinRef.current,
      data,
      {
        autosize: true,
        height: dotPlotHeight(groupCount),
        margin: { l: groupCount > 70 ? 62 : 78, r: violinResult.genes.length > 1 ? 122 : 28, t: 18, b: 54 },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        violinmode: "group",
        showlegend: violinResult.genes.length > 1,
        xaxis: {
          title: "Expression",
          automargin: true,
          showgrid: false,
          zeroline: true,
          zerolinecolor: "#cbd5e1",
        },
        yaxis: {
          title: "",
          type: "category",
          categoryarray: violinResult.groups,
          autorange: "reversed",
          automargin: true,
          tickfont: { size: rowTickFontSize },
          showgrid: false,
          zeroline: false,
          showline: true,
          mirror: true,
          linecolor: "#475569",
          linewidth: 1,
        },
        legend: {
          x: 1.02,
          y: 1,
          xanchor: "left",
          yanchor: "top",
          bgcolor: "rgba(255,255,255,0.86)",
          borderwidth: 0,
          font: { size: 11 },
        },
      },
      { responsive: true, displaylogo: false, toImageButtonOptions: { filename: "gene-violin-plot", scale: 2 } },
    );
  }, [violinResult, clusterColumn]);

  useEffect(() => {
    if (!heatmapRef.current) return;
    if (!matrixResult) {
      Plotly.purge(heatmapRef.current);
      return;
    }

    const z = matrixResult.genes.map((gene) =>
      matrixResult.groups.map((group) => {
        const row = matrixResult.rows.find((item) => item.gene === gene && item.group === group);
        return row?.mean_expression ?? 0;
      }),
    );
    const text = matrixResult.genes.map((gene) =>
      matrixResult.groups.map((group) => {
        const row = matrixResult.rows.find((item) => item.gene === gene && item.group === group);
        if (!row) return `${gene}<br>${displayColumnName(clusterColumn)}: ${group}`;
        return `${gene}<br>${displayColumnName(clusterColumn)}: ${group}<br>Mean: ${row.mean_expression.toFixed(3)}<br>Expressing: ${row.pct_expressing.toFixed(1)}%<br>Cells: ${row.count.toLocaleString()}`;
      }),
    );

    Plotly.react(
      heatmapRef.current,
      [
        {
          type: "heatmap",
          x: matrixResult.groups,
          y: matrixResult.genes,
          z,
          text,
          hoverinfo: "text",
          colorscale: "Viridis",
          colorbar: { title: "Mean" },
        },
      ],
      {
        autosize: true,
        margin: { l: 100, r: 20, t: 8, b: 62 },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        xaxis: { title: displayColumnName(clusterColumn), type: "category", automargin: true },
        yaxis: { automargin: true },
      },
      { responsive: true, displaylogo: false, toImageButtonOptions: { filename: "expression-heat-map", scale: 2 } },
    );
  }, [matrixResult, clusterColumn]);

  useEffect(() => {
    const node = plotRef.current;
    return () => {
      if (node) Plotly.purge(node);
      if (dotplotRef.current) Plotly.purge(dotplotRef.current);
      if (violinRef.current) Plotly.purge(violinRef.current);
      if (heatmapRef.current) Plotly.purge(heatmapRef.current);
    };
  }, []);

  function clearFilters() {
    setSelectedAnnotationValues([]);
    setGeneQuery("");
    setPendingGene("");
    setGeneOptions([]);
    setGeneResult(null);
    setMatrixResult(null);
    setViolinResult(null);
    setActiveTab("scatter");
    setError("");
  }

  function activePlotNode() {
    if (activeTab === "dotplot") return dotplotRef.current;
    if (activeTab === "violin") return violinRef.current;
    if (activeTab === "heatmap") return heatmapRef.current;
    return plotRef.current;
  }

  function downloadActivePlot() {
    const node = activePlotNode();
    if (!node) return;
    const filename = activeTab === "scatter" ? (geneResult ? `${geneResult.gene}-umap` : "umap") : activeTab;
    Plotly.downloadImage(node, { format: "png", filename, scale: 2 });
  }

  function toggleAnnotationValue(value) {
    setSelectedAnnotationValues((current) => {
      if (current.length === 0) return [value];
      if (current.includes(value)) return current.filter((item) => item !== value);
      return [...current.filter((item) => item !== "__none__"), value];
    });
  }

  if (loading) {
    return (
      <main className="loading-screen">
        <Loader2 className="spin" size={28} />
      </main>
    );
  }

  return (
    <main className="portal-shell">
      <header className="study-header">
        <div className="study-title-block">
          <p className="eyebrow">Single Cell Portal</p>
          <a className="back-link" href="/">
            <ArrowLeft size={15} />
            All Studies
          </a>
          <h1>{study?.title ?? studyConfig.title}</h1>
          <p>{study?.description ?? studyConfig.description}</p>
        </div>
        <div className="study-header-stats">
          <div>
            <strong>{study?.n_cells?.toLocaleString() ?? "-"}</strong>
            <span>Cells</span>
          </div>
          <div>
            <strong>{study?.n_genes?.toLocaleString() ?? "-"}</strong>
            <span>Genes</span>
          </div>
        </div>
      </header>
      <section className="explore-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Explore controls</p>
          <h2>{sidebarTitle}</h2>
          <p className="description">{sidebarDescription}</p>
        </div>

        <div className="stats">
          <div>
            <span>{study?.n_cells?.toLocaleString() ?? "-"}</span>
            <label>Cells</label>
          </div>
          <div>
            <span>{study?.n_genes?.toLocaleString() ?? "-"}</span>
            <label>Genes</label>
          </div>
          <div>
            <span>{visibleCellCount.toLocaleString()}</span>
            <label>Visible</label>
          </div>
          <div>
            <span>{metrics?.clusters?.length ?? "-"}</span>
            <label>Clusters</label>
          </div>
        </div>

        <section className="control-group">
          <label htmlFor="colorBy">{isScatterTab ? "Color by annotation" : "Subset cells by"}</label>
          <select
            id="colorBy"
            value={colorBy}
            onChange={(event) => {
              setColorBy(event.target.value);
              setSelectedAnnotationValues([]);
            }}
          >
            {colorColumns.map((column) => (
              <option key={column.name} value={column.name}>
                {displayColumnName(column.name)}
              </option>
            ))}
          </select>
        </section>

        <section className="control-group">
          <label htmlFor="clusterBy">{isScatterTab ? "Cluster labels" : "Group by"}</label>
          <select id="clusterBy" value={clusterColumn} onChange={(event) => setClusterColumn(event.target.value)}>
            {clusterColumns.map((column) => (
              <option key={column.name} value={column.name}>
                {displayColumnName(column.name)}
              </option>
            ))}
          </select>
          {isScatterTab && (
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={showClusterLabels}
                onChange={(event) => setShowClusterLabels(event.target.checked)}
              />
              Show {displayColumnName(clusterColumn)} on UMAP
            </label>
          )}
        </section>

        {isScatterTab && (
          <section className="control-group">
            <div className="range-heading">
              <label htmlFor="pointSize">Point size</label>
              <span>{pointSize.toFixed(1)}</span>
            </div>
            <input
              id="pointSize"
              className="range-input"
              type="range"
              min="0.8"
              max="5"
              step="0.2"
              value={pointSize}
              onChange={(event) => setPointSize(Number(event.target.value))}
            />
          </section>
        )}

        <section className="control-group">
          <div className="filter-heading">
            <label>{colorBy ? `${displayColumnName(colorBy)} ${isScatterTab ? "values" : "to include"}` : isScatterTab ? "Annotation values" : "Values to include"}</label>
            <div>
              <button type="button" onClick={() => setSelectedAnnotationValues([])} title="Show all values">
                <Eye size={15} />
              </button>
              <button type="button" onClick={() => setSelectedAnnotationValues(["__none__"])} title="Hide all values">
                <EyeOff size={15} />
              </button>
            </div>
          </div>
          <div className="annotation-list">
            {legendItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className={selectedAnnotationValues.length === 0 || selectedAnnotationValues.includes(item.label) ? "active" : ""}
                onClick={() => toggleAnnotationValue(item.label)}
              >
                <span style={{ backgroundColor: item.color }} />
                <strong>{item.label}</strong>
                <label>{item.count.toLocaleString()}</label>
              </button>
            ))}
          </div>
        </section>

        <section className="control-group">
          <label htmlFor="geneSearch">Gene expression</label>
          <div className="search-row">
            <Search size={17} />
            <input
              id="geneSearch"
              value={geneQuery}
              onChange={(event) => setGeneQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") loadGene();
              }}
              placeholder="Search gene or comma-separated genes"
            />
            <button type="button" onClick={() => loadGene()} title="Plot gene">
              <Dna size={17} />
            </button>
          </div>
          {geneOptions.length > 0 && (
            <div className="suggestions">
              {geneOptions.map((gene) => (
                <button key={gene} type="button" onClick={() => chooseGeneSuggestion(gene)}>
                  {gene}
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="actions">
          <button type="button" onClick={() => { setGeneQuery(""); setGeneOptions([]); setGeneResult(null); setMatrixResult(null); setViolinResult(null); }} title={clearGeneTitle}>
            <RefreshCcw size={17} />
            {clearGeneLabel}
          </button>
          <button type="button" onClick={downloadActivePlot} title="Download the active plot as PNG">
            <Download size={17} />
            Download plot
          </button>
        </div>

        <button type="button" className="clear-button" onClick={clearFilters}>
          Clear filters
        </button>

        {isScatterTab && geneResult && (
          <div className="metric-list">
            <div>
              <span>{geneResult.mean.toFixed(3)}</span>
              <label>Mean {geneResult.gene}</label>
            </div>
            <div>
              <span>{geneResult.pct_expressing.toFixed(1)}%</span>
              <label>Expressing</label>
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </aside>

      <section className="plot-panel">
        <div className="explore-summary">
          <div>
            <span>Genes</span>
            <strong>{geneDisplay}</strong>
          </div>
          <div>
            <span>{isScatterTab ? "Annotation" : "Subset"}</span>
            <strong>{colorBy ? displayColumnName(colorBy) : "none"}</strong>
          </div>
          <div>
            <span>{isScatterTab ? "Cluster" : "Group"}</span>
            <strong>{displayColumnName(clusterColumn)}</strong>
          </div>
          <div>
            <span>Subsample</span>
            <strong>all</strong>
          </div>
        </div>
        <div className="tabs">
          {EXPLORE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {isScatterTab && (
          <div className="plot-toolbar">
            <div>
              <strong>{geneResult ? geneResult.gene : displayColumnName(colorBy)}</strong>
              <span>{study?.embedding ?? "embedding"}</span>
            </div>
            {plotLoading && <Loader2 className="spin" size={18} />}
          </div>
        )}
        {!isScatterTab && plotLoading && (
          <div className="plot-toolbar compact status-toolbar">
            <Loader2 className="spin" size={18} />
          </div>
        )}
        <div ref={plotRef} className={activeTab === "scatter" ? "plot" : "plot hidden-panel"} />
        <div className={activeTab === "dotplot" ? "dotplot-panel" : "dotplot-panel hidden-panel"}>
          <div className="plot-toolbar compact">
            <div>
              <strong>{matrixResult ? "Gene dot plot" : "Dot plot"}</strong>
              <span>Selected genes across {displayColumnName(clusterColumn)}; color is expression, size is fraction expressing</span>
            </div>
          </div>
          <div ref={dotplotRef} className="dotplot">
            {!matrixResult && <span className="empty-state">Search one or more genes to show the dot plot.</span>}
          </div>
        </div>
        <div className={activeTab === "violin" ? "dotplot-panel" : "dotplot-panel hidden-panel"}>
          <div className="plot-toolbar compact">
            <div>
              <strong>{violinResult ? "Gene violin plot" : "Violin plot"}</strong>
              <span>Per-cell expression distributions across {displayColumnName(clusterColumn)}</span>
            </div>
          </div>
          <div ref={violinRef} className="dotplot">
            {!violinResult && <span className="empty-state">Search one or more genes to show the violin plot.</span>}
          </div>
        </div>
        <div className={activeTab === "heatmap" ? "dotplot-panel" : "dotplot-panel hidden-panel"}>
          <div className="plot-toolbar compact">
            <div>
              <strong>{matrixResult ? "Expression heat map" : "Heat map"}</strong>
              <span>Mean expression by {displayColumnName(clusterColumn)}, inspired by Morpheus matrix views</span>
            </div>
          </div>
          <div ref={heatmapRef} className="dotplot">
            {!matrixResult && <span className="empty-state">Search one or more genes to show the heat map.</span>}
          </div>
        </div>
      </section>
      <aside className="legend-panel">
        <div className="legend-card">
          <div>
            <p className="eyebrow">Legend</p>
            <h2>{activeTab === "dotplot" && matrixResult ? "Dot Plot" : activeTab === "violin" && violinResult ? "Violin Plot" : geneResult ? geneResult.gene : displayColumnName(colorBy)}</h2>
          </div>
          {activeTab === "dotplot" && matrixResult ? (
            <div className="legend-dotplot">
              <div>
                <strong>{matrixResult.genes.length}</strong>
                <span>Selected Genes</span>
              </div>
              <div>
                <strong>{matrixResult.groups.length}</strong>
                <span>{displayColumnName(clusterColumn)}</span>
              </div>
              <p>Dot color shows relative mean expression across the current plot. Dot size shows the fraction of cells expressing each gene in each group.</p>
              <div className="dot-size-legend" aria-label="Fraction of cells in group percent">
                <strong>Fraction of Cells</strong>
                <div>
                  {[20, 40, 60, 80, 100].map((value) => (
                    <span key={value}>
                      <i style={{ width: dotSizeFromPercent(value, 11), height: dotSizeFromPercent(value, 11) }} />
                      <label>{value}%</label>
                    </span>
                  ))}
                </div>
              </div>
              <div className="legend-gene-list">
                {matrixResult.genes.map((gene) => (
                  <span key={gene}>{gene}</span>
                ))}
              </div>
            </div>
          ) : activeTab === "violin" && violinResult ? (
            <div className="legend-dotplot">
              <div>
                <strong>{violinResult.genes.length}</strong>
                <span>Selected Genes</span>
              </div>
              <div>
                <strong>{violinResult.groups.length}</strong>
                <span>{displayColumnName(clusterColumn)}</span>
              </div>
              <p>Violin width shows the sampled per-cell expression distribution. Box marks the interquartile range and the center line marks the mean.</p>
              <div className="legend-gene-list">
                {violinResult.genes.map((gene) => (
                  <span key={gene}>{gene}</span>
                ))}
              </div>
            </div>
          ) : !geneResult ? (
            <div className="legend-list">
              {legendItems.slice(0, 80).map((item) => (
                <div key={item.label} className="legend-row">
                  <span style={{ backgroundColor: item.color }} />
                  <strong>{item.label}</strong>
                  <label>{item.count.toLocaleString()}</label>
                </div>
              ))}
            </div>
          ) : (
            <div className="legend-expression">
              <div>
                <strong>{geneResult.min.toFixed(3)}</strong>
                <span>Min</span>
              </div>
              <div>
                <strong>{geneResult.max.toFixed(3)}</strong>
                <span>Max</span>
              </div>
            </div>
          )}
        </div>
      </aside>
      </section>
    </main>
  );
}

function StudyListPage({ studies = STUDIES }) {
  return (
    <main className="study-list-shell">
      <header className="study-list-header">
        <div>
          <p className="eyebrow">Single Cell Portal</p>
          <h1>Studies</h1>
          <p>Choose a processed study to inspect embeddings, annotations, genes, and expression summaries.</p>
        </div>
      </header>

      <section className="study-browser" aria-label="Available studies">
        <div className="study-browser-heading">
          <span>{studies.length.toLocaleString()} study</span>
          <strong>Available datasets</strong>
        </div>
        <div className="study-list">
          {studies.map((studyItem) => (
            <a key={studyItem.id} className="study-row" href={`/study/${studyItem.id}?tab=scatter`}>
              <div>
                <strong>{studyItem.title}</strong>
                <span>{studyItem.description}</span>
              </div>
              <label>{studyItem.species}</label>
              <label>{studyItem.tissue}</label>
              <em>{studyItem.status}</em>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}

function App() {
  const pathname = window.location.pathname.replace(/\/+$/, "");
  const query = new URLSearchParams(window.location.search);
  const requestedStudy = STUDIES.find((studyItem) => pathname === `/study/${studyItem.id}`);
  const legacyExplorerUrl =
    pathname === "" && (query.has("tab") || query.has("genes") || query.has("gene") || query.has("annotation"));

  if (requestedStudy || legacyExplorerUrl) {
    return <StudyExplorer studyConfig={requestedStudy ?? STUDIES[0]} />;
  }

  return <StudyListPage studies={STUDIES} />;
}

createRoot(document.getElementById("root")).render(<App />);
