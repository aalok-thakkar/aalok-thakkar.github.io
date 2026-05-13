#!/usr/bin/env python3
"""
Site linter for aalok-thakkar.github.io.

Checks every .html file for the kinds of issues that were found during the
last review: broken local hrefs and src paths, empty hrefs, missing protocols
on bare-host links, mismatched/duplicate tags, unknown tags, hand-rolled
broken footers, missing <meta charset>/<meta viewport>, and stale references
to deleted directories.

Usage:
    python3 lint.py                   # run from the repo root
    python3 lint.py path/to/file.html # check specific file(s)

Exit code is the number of issues found (capped at 255).
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, unquote

REPO_ROOT = Path(__file__).resolve().parent

# Tags treated as the canonical bold/italic markers. <bf> is a common typo.
KNOWN_INLINE_TAGS = {"b", "strong", "i", "em", "u", "br", "span", "font", "sup", "sub", "a", "img"}
INVALID_TAGS = {"bf", "Article"}  # extend if more pop up

# Tags whose openers/closers we balance per file (loose, line-level).
BALANCE_TAGS = ["body", "html", "head"]

# Files / directories the linter should ignore.
IGNORE_DIRS = {".git", "webpage_files", ".vscode"}


class Issue:
    __slots__ = ("path", "line", "code", "message")

    def __init__(self, path: Path, line: int, code: str, message: str):
        self.path = path
        self.line = line
        self.code = code
        self.message = message

    def __str__(self) -> str:
        rel = self.path.relative_to(REPO_ROOT) if self.path.is_absolute() else self.path
        return f"{rel}:{self.line}: [{self.code}] {self.message}"


def iter_html_files(targets: list[Path]) -> list[Path]:
    if targets:
        out = []
        for t in targets:
            if t.is_dir():
                out.extend(sorted(t.rglob("*.html")))
            elif t.suffix == ".html":
                out.append(t)
        return out
    files: list[Path] = []
    for root, dirs, names in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for n in names:
            if n.endswith(".html"):
                files.append(Path(root) / n)
    return sorted(files)


def check_hrefs_and_srcs(path: Path, lines: list[str]) -> list[Issue]:
    issues: list[Issue] = []
    href_re = re.compile(r"""\b(href|src)\s*=\s*["']([^"']*)["']""", re.IGNORECASE)
    for lineno, line in enumerate(lines, start=1):
        for m in href_re.finditer(line):
            attr, value = m.group(1).lower(), m.group(2).strip()
            if value == "" or value == "#":
                if attr == "href":
                    issues.append(Issue(path, lineno, "empty-href", "empty href=\"\""))
                continue
            if value.startswith(("data:", "mailto:", "tel:", "javascript:", "#")):
                # mailto sanity: catch the >" / extra trailing chars we saw.
                if value.startswith("mailto:") and any(c in value for c in '<>"'):
                    issues.append(Issue(path, lineno, "malformed-mailto",
                                        f"mailto contains stray character: {value!r}"))
                continue
            parsed = urlparse(value)
            if parsed.scheme in {"http", "https"}:
                continue
            if parsed.scheme:
                continue  # other URI schemes (ftp, etc.) — leave alone
            if parsed.netloc:
                continue  # protocol-relative
            # Bare hostnames like "turnitin.com" or "doi.org/..."
            if not value.startswith(("/", "./", "../")) and "/" not in value.split("?")[0]:
                # purely a relative file name — fine (e.g., "index.html")
                pass
            if not value.startswith(("/", "./", "../")) and "." in value.split("/")[0] and not value.lower().endswith(
                (".html", ".htm", ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".css", ".js",
                 ".bib", ".txt", ".key", ".woff", ".woff2", ".otf", ".ttf")
            ):
                issues.append(Issue(path, lineno, "missing-protocol",
                                    f"{attr}=\"{value}\" looks like a URL without scheme"))
                continue
            # Resolve relative path against the file's directory.
            base = path.parent if value.startswith((".", "")) and not value.startswith("/") else REPO_ROOT
            target_str = value.split("#", 1)[0].split("?", 1)[0]
            if not target_str:
                continue
            target_str = unquote(target_str)
            if value.startswith("/"):
                target = (REPO_ROOT / target_str.lstrip("/")).resolve()
            else:
                target = (path.parent / target_str).resolve()
            # Allow either a literal file or an index.html under a directory.
            if not target.exists():
                # Special case: links like "./index.html" already point at a file; nothing to do.
                issues.append(Issue(path, lineno, "broken-link",
                                    f"{attr}=\"{value}\" -> missing {target.relative_to(REPO_ROOT) if REPO_ROOT in target.parents or target == REPO_ROOT else target}"))
    return issues


def check_tags(path: Path, content: str, lines: list[str]) -> list[Issue]:
    issues: list[Issue] = []
    # Invalid tag names (e.g., <bf>, <Article>).
    for tag in INVALID_TAGS:
        for m in re.finditer(rf"<{tag}\b[^>]*>", content):
            lineno = content.count("\n", 0, m.start()) + 1
            issues.append(Issue(path, lineno, "invalid-tag",
                                f"unknown HTML tag <{tag}> — did you mean <b>/<strong>?"))
        for m in re.finditer(rf"</{tag}\s*>", content):
            lineno = content.count("\n", 0, m.start()) + 1
            issues.append(Issue(path, lineno, "invalid-tag",
                                f"unknown closing tag </{tag}>"))

    # Duplicate </body> / </html> / </head>.
    for tag in BALANCE_TAGS:
        opens = list(re.finditer(rf"<{tag}\b", content, re.IGNORECASE))
        closes = list(re.finditer(rf"</{tag}\s*>", content, re.IGNORECASE))
        if len(closes) > 1:
            for extra in closes[1:]:
                lineno = content.count("\n", 0, extra.start()) + 1
                issues.append(Issue(path, lineno, "duplicate-close",
                                    f"duplicate </{tag}>"))
        if len(opens) > 1:
            for extra in opens[1:]:
                lineno = content.count("\n", 0, extra.start()) + 1
                issues.append(Issue(path, lineno, "duplicate-open",
                                    f"duplicate <{tag}>"))

    # Catch stray </b>, </strong>, </em>, </font> with no matching opener
    # (line-level, not full parse — flags obvious cases).
    for tag in ("b", "strong", "em", "font"):
        # walk through tokens, track depth
        depth = 0
        for m in re.finditer(rf"<(/)?{tag}(\b[^>]*)?>", content, re.IGNORECASE):
            is_close = m.group(1) == "/"
            if is_close:
                depth -= 1
                if depth < 0:
                    lineno = content.count("\n", 0, m.start()) + 1
                    issues.append(Issue(path, lineno, "stray-close",
                                        f"</{tag}> without matching opener"))
                    depth = 0
            else:
                depth += 1

    # Hand-rolled broken footer signature.
    if re.search(r'\.\./\.\./(publications|research|contact|teaching|more)\.html', content):
        lineno = next(
            (i + 1 for i, ln in enumerate(lines)
             if re.search(r"\.\./\.\./(publications|research|contact|teaching|more)\.html", ln)),
            1,
        )
        issues.append(Issue(path, lineno, "hand-rolled-footer",
                            "footer references ../../section.html — use /webpage_files/footer.html"))

    # Reference to deleted infosec directory.
    if re.search(r'/teaching/spring2026/infosec/', content):
        lineno = next(
            (i + 1 for i, ln in enumerate(lines) if "teaching/spring2026/infosec" in ln),
            1,
        )
        issues.append(Issue(path, lineno, "stale-ref",
                            "reference to deleted teaching/spring2026/infosec/"))

    return issues


def check_meta(path: Path, content: str) -> list[Issue]:
    issues: list[Issue] = []
    if "<head" not in content.lower():
        return issues
    if not re.search(r'<meta\s+[^>]*charset', content, re.IGNORECASE):
        issues.append(Issue(path, 1, "missing-charset",
                            "missing <meta charset=\"utf-8\"> in <head>"))
    if not re.search(r'<meta\s+[^>]*name\s*=\s*["\']viewport', content, re.IGNORECASE):
        issues.append(Issue(path, 1, "missing-viewport",
                            "missing <meta name=\"viewport\"> in <head>"))
    return issues


def lint_file(path: Path) -> list[Issue]:
    try:
        content = path.read_text(encoding="utf-8")
    except Exception as e:
        return [Issue(path, 1, "read-error", f"could not read file: {e}")]
    lines = content.splitlines()
    issues = []
    issues += check_hrefs_and_srcs(path, lines)
    issues += check_tags(path, content, lines)
    issues += check_meta(path, content)
    return issues


def main(argv: list[str]) -> int:
    targets = [Path(a).resolve() for a in argv[1:]]
    files = iter_html_files(targets)
    if not files:
        print("no html files found", file=sys.stderr)
        return 1
    all_issues: list[Issue] = []
    for f in files:
        all_issues.extend(lint_file(f))
    for issue in all_issues:
        print(issue)
    counts: dict[str, int] = {}
    for issue in all_issues:
        counts[issue.code] = counts.get(issue.code, 0) + 1
    print(f"\n{len(all_issues)} issue(s) in {len(files)} file(s)")
    for code, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d}  {code}")
    return min(len(all_issues), 255)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
