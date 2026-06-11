import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Plotly from "plotly.js-dist-min";
import { Download, Dna, Eye, EyeOff, Link, Loader2, RefreshCcw, Search } from "lucide-react";
import "./styles.css";

const API_BASE =
  import.meta.env.VITE_API_BASE ?? `${window.location.protocol}//${window.location.hostname}:8000`;

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `Request failed: ${response.status}`);
  }
  return payload;
}

function chooseDefaultColumn(columns) {
  const names = columns.map((column) => column.name);
  const preferred = [
    "sample",
    "renamed_samples",
    "cell_type",
    "celltype",
    "cell_type_LEC_type",
    "leiden",
    "seurat_clusters",
    "cluster",
    "annotation",
    "sample",
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

function App() {
  const plotRef = useRef(null);
  const dotplotRef = useRef(null);
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
  const [dotplotResult, setDotplotResult] = useState(null);
  const [matrixResult, setMatrixResult] = useState(null);
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
        const names = columns.map((column) => column.name);
        const defaultColumn = chooseDefaultColumn(studyPayload.metadata_columns ?? []);
        const urlAnnotation = query.get("annotation");
        const urlClusterColumn = query.get("cluster");
        const urlGenes = query.get("genes") || query.get("gene") || "";
        const urlTab = query.get("tab");

        setStudy(studyPayload);
        const selectedAnnotation = urlAnnotation && names.includes(urlAnnotation) ? urlAnnotation : defaultColumn;
        setColorBy(selectedAnnotation);
        if (urlClusterColumn && names.includes(urlClusterColumn)) {
          setClusterColumn(urlClusterColumn);
        } else if (names.includes("leiden")) {
          setClusterColumn("leiden");
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
        if (urlTab === "dotplot" || urlTab === "scatter" || urlTab === "heatmap") setActiveTab(urlTab);
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
          setDotplotResult(null);
          setMatrixResult(null);
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
    const query = geneQuery.trim();
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
      const dotPayload = await getJson(
        `/api/dotplot/${encodeURIComponent(firstGene)}?group_by=${encodeURIComponent(clusterColumn)}&${params.toString()}`,
      );
      const matrixPayload = await getJson(
        `/api/matrix?genes=${encodeURIComponent(genes.join(","))}&group_by=${encodeURIComponent(clusterColumn)}&${params.toString()}`,
      );
      setGeneResult(payload);
      setDotplotResult(dotPayload);
      setMatrixResult(matrixPayload);
      setGeneQuery(matrixPayload.genes.join(", "));
      setGeneOptions([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlotLoading(false);
    }
  }

  const categoricalColumns = (study?.metadata_columns ?? []).filter((column) => column.kind === "categorical");
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

  const plotData = useMemo(() => {
    const x = cells.map((cell) => cell.x);
    const y = cells.map((cell) => cell.y);
    const text = cells.map((cell) => {
      const annotation = colorBy ? `<br>${colorBy}: ${cell[colorBy] || "Unannotated"}` : "";
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
            colorscale: "Viridis",
            showscale: true,
            colorbar: { title: geneResult.gene },
            size: pointSize,
            opacity: 0.78,
          },
        },
      ];

      if (showClusterLabels && clusterLabels.length > 0) {
        traces.push({
          type: "scatter",
          name: "Cluster labels",
          showlegend: false,
          mode: "text",
          x: clusterLabels.map((label) => label.x),
          y: clusterLabels.map((label) => label.y),
          text: clusterLabels.map((label) => label.cluster),
          hoverinfo: "skip",
          textfont: { color: "#111827", size: 14, family: "Inter, sans-serif" },
        });
      }

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

    if (showClusterLabels && clusterLabels.length > 0) {
      traces.push({
        type: "scatter",
        name: "Cluster labels",
        showlegend: false,
        mode: "text",
        x: clusterLabels.map((label) => label.x),
        y: clusterLabels.map((label) => label.y),
        text: clusterLabels.map((label) => label.cluster),
        hoverinfo: "skip",
        textfont: { color: "#111827", size: 14, family: "Inter, sans-serif" },
      });
    }

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
        showgrid: true,
        gridcolor: "#eceff3",
        gridwidth: 1,
      },
      yaxis: {
        title: "UMAP 2",
        zeroline: true,
        zerolinecolor: "#555555",
        zerolinewidth: 1,
        showgrid: true,
        gridcolor: "#eceff3",
        gridwidth: 1,
      },
      dragmode: "lasso",
      hovermode: "closest",
      showlegend: false,
    };

    const config = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["toImage", "sendDataToCloud"],
    };

    Plotly.react(plotRef.current, plotData, layout, config);
  }, [cells.length, plotData]);

  useEffect(() => {
    if (!dotplotRef.current) return;
    if (!dotplotResult) {
      Plotly.purge(dotplotRef.current);
      return;
    }

    const points = dotplotResult.points ?? [];
    const data = [
      {
        type: "scatter",
        mode: "markers",
        x: points.map((point) => point.group),
        y: points.map(() => dotplotResult.gene),
        text: points.map(
          (point) =>
            `${clusterColumn}: ${point.group}<br>Mean: ${point.mean_expression.toFixed(3)}<br>Expressing: ${point.pct_expressing.toFixed(1)}%<br>Cells: ${point.count.toLocaleString()}`,
        ),
        hoverinfo: "text",
        marker: {
          color: points.map((point) => point.mean_expression),
          colorscale: "Viridis",
          showscale: true,
          colorbar: { title: "Mean" },
          size: points.map((point) => Math.max(6, Math.sqrt(point.pct_expressing) * 3.2)),
          sizemode: "diameter",
          opacity: 0.9,
          line: { color: "#334155", width: 0.4 },
        },
      },
    ];

    Plotly.react(
      dotplotRef.current,
      data,
      {
        autosize: true,
        margin: { l: 90, r: 20, t: 8, b: 46 },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        xaxis: { title: clusterColumn, type: "category", automargin: true },
        yaxis: { automargin: true },
      },
      { responsive: true, displaylogo: false },
    );
  }, [dotplotResult, clusterColumn]);

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
        if (!row) return `${gene}<br>${clusterColumn}: ${group}`;
        return `${gene}<br>${clusterColumn}: ${group}<br>Mean: ${row.mean_expression.toFixed(3)}<br>Expressing: ${row.pct_expressing.toFixed(1)}%<br>Cells: ${row.count.toLocaleString()}`;
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
        xaxis: { title: clusterColumn, type: "category", automargin: true },
        yaxis: { automargin: true },
      },
      { responsive: true, displaylogo: false },
    );
  }, [matrixResult, clusterColumn]);

  useEffect(() => {
    const node = plotRef.current;
    return () => {
      if (node) Plotly.purge(node);
      if (dotplotRef.current) Plotly.purge(dotplotRef.current);
      if (heatmapRef.current) Plotly.purge(heatmapRef.current);
    };
  }, []);

  function clearFilters() {
    setSelectedAnnotationValues([]);
  }

  function toggleAnnotationValue(value) {
    setSelectedAnnotationValues((current) => {
      if (current.length === 0) return [value];
      if (current.includes(value)) return current.filter((item) => item !== value);
      return [...current.filter((item) => item !== "__none__"), value];
    });
  }

  async function shareView() {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      window.prompt("Copy this view URL", window.location.href);
    }
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
          <h1>{study?.title ?? "Zebrafish Single-Cell Portal"}</h1>
          <p>{study?.description}</p>
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
          <a href={`${API_BASE}/api/download/h5ad`}>
            <Download size={16} />
            Download
          </a>
        </div>
      </header>

      <nav className="study-tabs">
        <button type="button">Study Summary</button>
        <button type="button" className="active">Explore</button>
        <button type="button">Files</button>
      </nav>

      <section className="explore-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Explore controls</p>
          <h2>Scatter plot</h2>
          <p className="description">Color, filter, and query expression across the current UMAP view.</p>
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
          <label htmlFor="colorBy">Color by annotation</label>
          <select
            id="colorBy"
            value={colorBy}
            onChange={(event) => {
              setColorBy(event.target.value);
              setSelectedAnnotationValues([]);
            }}
          >
            {categoricalColumns.map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
        </section>

        <section className="control-group">
          <label htmlFor="clusterBy">Cluster numbering</label>
          <select id="clusterBy" value={clusterColumn} onChange={(event) => setClusterColumn(event.target.value)}>
            {categoricalColumns.map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showClusterLabels}
              onChange={(event) => setShowClusterLabels(event.target.checked)}
            />
            Show numbers on UMAP
          </label>
        </section>

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

        <section className="control-group">
          <div className="filter-heading">
            <label>{colorBy || "Annotation"} values</label>
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
                <button key={gene} type="button" onClick={() => loadGene(gene)}>
                  {gene}
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="actions">
          <button type="button" onClick={() => { setGeneResult(null); setDotplotResult(null); setMatrixResult(null); }} title="Return to annotation coloring">
            <RefreshCcw size={17} />
            Annotation color
          </button>
          <a href={`${API_BASE}/api/download/h5ad`}>
            <Download size={17} />
            h5ad
          </a>
        </div>

        <button type="button" className="clear-button" onClick={shareView}>
          <Link size={16} />
          Share view
        </button>

        <button type="button" className="clear-button" onClick={clearFilters}>
          Clear filters
        </button>

        {geneResult && (
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
            <span>Annotation</span>
            <strong>{colorBy || "none"}</strong>
          </div>
          <div>
            <span>Cluster</span>
            <strong>{clusterColumn}</strong>
          </div>
          <div>
            <span>Subsample</span>
            <strong>all</strong>
          </div>
        </div>
        <div className="tabs">
          <button type="button" className={activeTab === "scatter" ? "active" : ""} onClick={() => setActiveTab("scatter")}>
            Scatter
          </button>
          <button type="button" className={activeTab === "dotplot" ? "active" : ""} onClick={() => setActiveTab("dotplot")}>
            Dot plot
          </button>
          <button type="button" className={activeTab === "heatmap" ? "active" : ""} onClick={() => setActiveTab("heatmap")}>
            Heat map
          </button>
        </div>
        <div className="plot-toolbar">
          <div>
            <strong>{geneResult ? geneResult.gene : colorBy}</strong>
            <span>{study?.embedding ?? "embedding"}</span>
          </div>
          {plotLoading && <Loader2 className="spin" size={18} />}
        </div>
        <div ref={plotRef} className={activeTab === "scatter" ? "plot" : "plot hidden-panel"} />
        <div className={activeTab === "dotplot" ? "dotplot-panel" : "dotplot-panel hidden-panel"}>
          <div className="plot-toolbar compact">
            <div>
              <strong>{dotplotResult ? `${dotplotResult.gene} dot plot` : "Dot plot"}</strong>
              <span>Mean expression and percent expressing by {clusterColumn}</span>
            </div>
          </div>
          <div ref={dotplotRef} className="dotplot">
            {!dotplotResult && <span className="empty-state">Search a gene to show the dot plot.</span>}
          </div>
        </div>
        <div className={activeTab === "heatmap" ? "dotplot-panel" : "dotplot-panel hidden-panel"}>
          <div className="plot-toolbar compact">
            <div>
              <strong>{matrixResult ? "Expression heat map" : "Heat map"}</strong>
              <span>Mean expression by {clusterColumn}, inspired by Morpheus matrix views</span>
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
            <h2>{geneResult ? geneResult.gene : colorBy}</h2>
          </div>
          {!geneResult ? (
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

createRoot(document.getElementById("root")).render(<App />);
