from __future__ import annotations

import math
from pathlib import Path

from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "single-cell-portal-architecture-data-flow.pdf"
PAGE_W, PAGE_H = landscape(letter)

NAVY = HexColor("#18324A")
INK = HexColor("#263746")
MUTED = HexColor("#5B6B79")
LINE = HexColor("#91A4B5")
BLUE = HexColor("#DCEEFF")
TEAL = HexColor("#DDF4F0")
GREEN = HexColor("#E4F3E5")
ORANGE = HexColor("#FFF0D9")
PURPLE = HexColor("#EEE7FA")
GRAY = HexColor("#F2F5F7")
RED = HexColor("#B9473F")


def wrap_lines(text: str, font: str, size: float, max_width: float) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            candidate = f"{current} {word}"
            if stringWidth(candidate, font, size) <= max_width:
                current = candidate
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def draw_wrapped(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    max_width: float,
    font: str = "Helvetica",
    size: float = 8.5,
    color: Color = INK,
    leading: float | None = None,
    align: str = "left",
) -> float:
    leading = leading or size * 1.25
    c.setFont(font, size)
    c.setFillColor(color)
    for line in wrap_lines(text, font, size, max_width):
        if align == "center":
            c.drawCentredString(x + max_width / 2, y, line)
        elif align == "right":
            c.drawRightString(x + max_width, y, line)
        else:
            c.drawString(x, y, line)
        y -= leading
    return y


def box(
    c: canvas.Canvas,
    x: float,
    y: float,
    w: float,
    h: float,
    title: str,
    body: str,
    fill: Color,
    stroke: Color = LINE,
    title_size: float = 10,
    body_size: float = 8,
) -> None:
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(1)
    c.roundRect(x, y, w, h, 7, fill=1, stroke=1)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", title_size)
    c.drawString(x + 10, y + h - 17, title)
    draw_wrapped(c, body, x + 10, y + h - 31, w - 20, size=body_size, color=INK, leading=body_size * 1.25)


def boundary(c: canvas.Canvas, x: float, y: float, w: float, h: float, title: str) -> None:
    c.saveState()
    c.setStrokeColor(HexColor("#648096"))
    c.setLineWidth(1.2)
    c.setDash(5, 3)
    c.roundRect(x, y, w, h, 10, fill=0, stroke=1)
    c.restoreState()
    c.setFillColor(white)
    c.rect(x + 12, y + h - 8, min(w - 24, 300), 17, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 18, y + h - 3, title)


def arrow(c: canvas.Canvas, x1: float, y1: float, x2: float, y2: float, label: str = "", dashed: bool = False) -> None:
    c.saveState()
    c.setStrokeColor(HexColor("#47677E"))
    c.setFillColor(HexColor("#47677E"))
    c.setLineWidth(1.3)
    if dashed:
        c.setDash(4, 3)
    c.line(x1, y1, x2, y2)
    angle = math.atan2(y2 - y1, x2 - x1)
    head = 7
    for offset in (2.55, -2.55):
        c.line(x2, y2, x2 + head * math.cos(angle + offset), y2 + head * math.sin(angle + offset))
    c.restoreState()
    if label:
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2
        c.setFillColor(white)
        label_w = stringWidth(label, "Helvetica", 7.5) + 8
        c.rect(mx - label_w / 2, my - 5, label_w, 11, fill=1, stroke=0)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.5)
        c.drawCentredString(mx, my - 2, label)


def header(c: canvas.Canvas, title: str, subtitle: str, page_num: int) -> None:
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(28, PAGE_H - 35, title)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 9)
    c.drawString(28, PAGE_H - 51, subtitle)
    c.setStrokeColor(HexColor("#C9D4DD"))
    c.line(28, PAGE_H - 61, PAGE_W - 28, PAGE_H - 61)
    c.setFont("Helvetica", 7.5)
    c.setFillColor(MUTED)
    c.drawRightString(PAGE_W - 28, 18, f"Single-Cell Study Portal | Architecture review | Page {page_num}")


def page_one(c: canvas.Canvas) -> None:
    header(
        c,
        "Single-Cell Study Portal - Production Architecture",
        "Prepared for U-M public hosting review | 23 July 2026 | Implemented components are solid; proposed ingress is marked",
        1,
    )

    boundary(c, 408, 58, 356, 474, "U-M RHEL 8.10 host: kec-ap-ps1a.med.umich.edu")

    box(c, 28, 435, 145, 68, "Public researcher", "Browser-based, anonymous read-only exploration", BLUE)
    box(c, 216, 425, 152, 88, "U-M public HTTPS ingress", "Public DNS + TLS termination / reverse proxy\nPROPOSED - confirm with HITS", PURPLE, stroke=HexColor("#8066A6"))

    box(c, 438, 428, 294, 74, "Frontend container - Nginx", "Published web port. Serves React/CSS/JS and proxies same-origin /api requests.", BLUE)
    box(c, 438, 304, 294, 90, "Backend container - FastAPI / Uvicorn", "Private Docker port 8000; GET endpoints only; non-root app user; validates filters and computes expression results.", TEAL)
    box(c, 438, 157, 294, 108, "Host-mounted scientific data", "Processed: study.json, genes.json, cells.parquet\nSource: 4 H5AD files\nRuntime mounts are read-only with SELinux :Z labels.", GREEN)
    box(c, 438, 82, 294, 46, "On-demand preprocess container", "Tools profile only; reads H5AD and writes derived processed files.", ORANGE, body_size=7.6)

    box(c, 28, 80, 145, 68, "Authorized operator", "SSH / server administration; dataset publishing and container maintenance", GRAY)

    arrow(c, 173, 469, 216, 469, "1. HTTPS GET")
    arrow(c, 368, 469, 438, 469, "2. approved port")
    arrow(c, 585, 428, 585, 394, "3. /api")
    arrow(c, 585, 304, 585, 265, "4. read only")
    arrow(c, 173, 114, 438, 105, "operator action", dashed=True)
    arrow(c, 585, 128, 585, 157, "derived data")

    c.setFillColor(HexColor("#F8FAFB"))
    c.setStrokeColor(HexColor("#D5DEE5"))
    c.roundRect(28, 245, 340, 135, 7, fill=1, stroke=1)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, 360, "Public exposure and trust boundaries")
    bullets = [
        "Only the Nginx frontend port is host-published.",
        "FastAPI is reachable only on the private Docker network.",
        "No upload, mutation, account, or H5AD download endpoint exists.",
        "Figures are rendered and exported in the researcher's browser.",
        "U-M DNS/TLS/ingress details remain to be approved.",
    ]
    y = 340
    for item in bullets:
        c.setFillColor(HexColor("#2B6F77"))
        c.circle(44, y + 2, 2, fill=1, stroke=0)
        y = draw_wrapped(c, item, 52, y, 300, size=8.3, color=INK, leading=13) - 2

    c.setFillColor(MUTED)
    c.setFont("Helvetica-Oblique", 7.5)
    c.drawString(28, 40, "Data classification assumption: zebrafish scientific data only; no PHI, PII, credentials, or human-subject data. Data owner to confirm.")
    c.showPage()


def flow_card(c: canvas.Canvas, x: float, y: float, number: str, title: str, body: str, fill: Color) -> None:
    c.setFillColor(fill)
    c.setStrokeColor(LINE)
    c.roundRect(x, y, 128, 82, 6, fill=1, stroke=1)
    c.setFillColor(NAVY)
    c.circle(x + 16, y + 64, 10, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 8)
    c.drawCentredString(x + 16, y + 61, number)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 8.7)
    c.drawString(x + 31, y + 61, title)
    draw_wrapped(c, body, x + 10, y + 45, 108, size=7.4, color=INK, leading=9.2)


def page_two(c: canvas.Canvas) -> None:
    header(
        c,
        "Data Flow, Controls, and Review Decisions",
        "Normal public traffic is read-only; dataset publication is a separate authorized administrative workflow",
        2,
    )

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(28, 530, "A. Normal public request path")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8)
    c.drawString(218, 530, "No user data is uploaded or persisted by the application")

    public_cards = [
        (30, "1", "Load application", "Browser requests the public HTTPS URL; Nginx returns static React assets.", BLUE),
        (176, "2", "Request data", "Browser sends same-origin GET requests under /api.", BLUE),
        (322, "3", "Proxy internally", "Nginx forwards /api to backend:8000 over Docker DNS.", PURPLE),
        (468, "4", "Read data", "FastAPI reads cached JSON/Parquet and requested H5AD gene slices.", TEAL),
        (614, "5", "Render result", "JSON returns to Plotly; figures and PNG exports are generated client-side.", GREEN),
    ]
    for x, number, title, body, fill in public_cards:
        flow_card(c, x, 427, number, title, body, fill)
    for left, right in zip(public_cards, public_cards[1:]):
        arrow(c, left[0] + 128, 468, right[0], 468)

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(28, 385, "B. Controlled dataset publication path")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8)
    c.drawString(250, 385, "Not reachable from the public web application")

    admin_cards = [
        (30, "1", "Approve dataset", "Data owner confirms content and transfers H5AD to protected host storage.", GRAY),
        (176, "2", "Preprocess", "Operator runs the transient Compose tools profile.", ORANGE),
        (322, "3", "Create derivatives", "Generate study.json, genes.json, and cells.parquet.", ORANGE),
        (468, "4", "Mount read-only", "Runtime backend receives source and processed files as read-only mounts.", GREEN),
        (614, "5", "Publish update", "Restart/redeploy containers and complete application validation.", TEAL),
    ]
    for x, number, title, body, fill in admin_cards:
        flow_card(c, x, 282, number, title, body, fill)
    for left, right in zip(admin_cards, admin_cards[1:]):
        arrow(c, left[0] + 128, 323, right[0], 323)

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(28, 240, "Implemented controls")
    controls = [
        (28, "Network", "One public web port; backend not host-published; same-origin API proxy."),
        (214, "Data", "Read-only runtime mounts; no H5AD download; no write API."),
        (400, "Runtime", "Non-root backend user; health check; restart unless stopped."),
        (586, "Application", "GET-only API; no accounts, uploads, database, or server-side figure files."),
    ]
    for x, title, body in controls:
        box(c, x, 157, 174, 65, title, body, GRAY, title_size=9, body_size=7.3)

    c.setFillColor(HexColor("#FFF9ED"))
    c.setStrokeColor(HexColor("#D8B56B"))
    c.roundRect(28, 52, 732, 83, 7, fill=1, stroke=1)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, 116, "Decisions requested from U-M hosting/security")
    questions = [
        "1. Public subdomain and DNS owner",
        "2. TLS certificate / ingress service",
        "3. Approved host port and firewall path",
        "4. Scanning, patching, logs, and monitoring requirements",
        "5. Confirmation that anonymous public access is acceptable",
    ]
    col_positions = [(40, 96), (285, 96), (530, 96), (40, 73), (400, 73)]
    widths = [220, 220, 205, 335, 330]
    for question, (x, y), width in zip(questions, col_positions, widths):
        draw_wrapped(c, question, x, y, width, size=7.8, color=INK, leading=9.5)

    c.showPage()


def build() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("Single-Cell Study Portal - Architecture and Data Flow")
    c.setAuthor("Zebrafish Single-Cell Portal project team")
    c.setSubject("Architecture and data flow for U-M public hosting review")
    page_one(c)
    page_two(c)
    c.save()
    print(OUTPUT)


if __name__ == "__main__":
    build()
