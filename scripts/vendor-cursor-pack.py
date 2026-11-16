#!/usr/bin/env python3
"""Vendor selected Cursor plugin skills into the cursor-pack builtin catalog.

Reads a local checkout of https://github.com/cursor/plugins. Does not write the
router, local-plugin, mcp-servers, or references/skipped.md.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

NOTE = (
    "RavenClaw note: upstream MIT text from https://github.com/cursor/plugins. "
    "Ignore Cursor stop hooks, cloud agents, canvases, and model slugs. "
    "Use the cursor-pack router limits."
)
FALLBACK_DESCRIPTION = "Upstream Cursor plugin skill."
ALLOWED_EXT = {
    ".md",
    ".mdc",
    ".json",
    ".txt",
    ".yml",
    ".yaml",
    ".py",
    ".ts",
    ".js",
    ".toml",
    ".html",
    ".css",
    ".sh",
    ".csv",
}
BUILTIN_NAMES = {
    "review",
    "test",
    "commit",
    "debug",
    "tdd",
    "plan",
    "frontend-design",
    "mcp-builder",
    "gamedev",
    "game-design",
    "team-design",
    "cursor-pack",
}
ORIGINAL_CATALOG = {"local-plugin", "mcp-servers"}
SOURCES = [
    ("advisor", "advisor/skills", set()),
    ("agent-compatibility", "agent-compatibility/skills", set()),
    ("cli-for-agent", "cli-for-agent/skills", set()),
    ("continual-learning", "continual-learning/skills", set()),
    ("cursor-team-kit", "cursor-team-kit/skills", {"pr-review-canvas"}),
    ("dyl-stack", "dyl-stack/skills", set()),
    ("grok-voice", "grok-voice/skills", set()),
    ("pstack", "pstack/skills", set()),
    ("benny", "pstack/automations/benny/skills", set()),
    ("ralph-loop", "ralph-loop/skills", set()),
    ("teaching", "teaching/skills", set()),
    ("thermos", "thermos/skills", set()),
]
BLOCK_MARK = re.compile(r"^([>|])([+\-]?)$")
BANNED = re.compile(r"claude|anthropic", re.IGNORECASE)

LICENSE = """MIT License

Copyright (c) 2026 Cursor
Copyright (c) 2026 Lauren Tan
Copyright (c) 2026 Dylan Gattey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

NOTICE = """Upstream: https://github.com/cursor/plugins

Copyright (c) 2026 Cursor
Copyright (c) 2026 Lauren Tan
Copyright (c) 2026 Dylan Gattey

Catalog bodies are modified upstream MIT text.
The router, local-plugin, and mcp-servers are original.
"""


def scrub(text: str) -> str:
    text = re.sub(r"CLAUDE\.md", "RAVEN.md", text, flags=re.IGNORECASE)
    text = re.sub(r"AGENTS\.md", ".ravenclaw/RAVEN.md", text, flags=re.IGNORECASE)
    text = text.replace(".cursor/", ".ravenclaw/")
    text = re.sub(r"claude", "agent", text, flags=re.IGNORECASE)
    text = re.sub(r"anthropic", "model-provider", text, flags=re.IGNORECASE)
    return text


def split_frontmatter(text: str) -> tuple[str | None, str]:
    match = re.match(r"^---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", text, re.DOTALL)
    if not match:
        return None, text
    return match.group(1), text[match.end() :]


def parse_double_quoted(raw: str) -> str:
    out: list[str] = []
    i = 1
    while i < len(raw):
        char = raw[i]
        if char == '"':
            break
        if char == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            out.append({"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}.get(nxt, nxt))
            i += 2
            continue
        out.append(char)
        i += 1
    return "".join(out)


def parse_single_quoted(raw: str) -> str:
    inner = raw[1:]
    if inner.endswith("'"):
        inner = inner[:-1]
    return inner.replace("''", "'")


def extract_description(block: str) -> str:
    lines = block.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^description\s*:\s*(.*)$", line)
        if not match:
            continue
        raw = match.group(1).strip()
        if BLOCK_MARK.match(raw):
            chunks: list[str] = []
            for nxt in lines[index + 1 :]:
                if nxt.strip() == "":
                    chunks.append(" ")
                    continue
                if nxt[:1] not in (" ", "\t"):
                    break
                chunks.append(nxt.strip())
            return " ".join(chunks)
        if raw.startswith('"'):
            return parse_double_quoted(raw)
        if raw.startswith("'"):
            return parse_single_quoted(raw)
        return raw
    return ""


def flatten_description(text: str) -> str:
    text = scrub(text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace('"', "")
    text = scrub(text)
    if len(text) > 180:
        text = text[:180]
    if len(text) < 9 or text in (">", "|"):
        return FALLBACK_DESCRIPTION
    return text


def rewrite_skill(text: str, dest_name: str) -> str:
    block, body = split_frontmatter(text)
    description = flatten_description(extract_description(block) if block is not None else "")
    return f'---\nname: {dest_name}\ndescription: "{description}"\n---\n{NOTE}\n{body}'


def read_text(path: Path) -> str:
    with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        return handle.read()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def copy_skill(src: Path, dest: Path, dest_name: str) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    for dirpath, _dirnames, filenames in os_walk(src):
        rel = dirpath.relative_to(src)
        for filename in filenames:
            if Path(filename).suffix.lower() not in ALLOWED_EXT:
                continue
            source = dirpath / filename
            target = dest / rel / filename
            if filename == "SKILL.md" and rel == Path("."):
                text = rewrite_skill(read_text(source), dest_name)
            else:
                text = read_text(source)
            text = scrub(text)
            write_text(target, text)


def os_walk(root: Path):
    import os

    for dirpath, dirnames, filenames in os.walk(root):
        yield Path(dirpath), dirnames, filenames


def dest_name(plugin: str, skill: str, counts: Counter[str]) -> str:
    if counts[skill] > 1:
        return f"{plugin}--{skill}"
    if skill in BUILTIN_NAMES:
        return f"{plugin}-{skill}"
    return skill


def collect_skills(upstream: Path) -> list[tuple[str, Path]]:
    found: list[tuple[str, str, Path]] = []
    for plugin, rel, skip in SOURCES:
        base = upstream / rel
        if not base.is_dir():
            raise SystemExit(f"missing skill root: {base}")
        for child in sorted(base.iterdir()):
            if not child.is_dir() or child.name in skip:
                continue
            if not (child / "SKILL.md").is_file():
                continue
            found.append((plugin, child.name, child))
    counts = Counter(skill for _plugin, skill, _path in found)
    planned: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for plugin, skill, path in found:
        name = dest_name(plugin, skill, counts)
        if name in ORIGINAL_CATALOG or name in seen:
            raise SystemExit(f"destination name collision: {name}")
        seen.add(name)
        planned.append((name, path))
    return planned


def string_map(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, str] = {}
    for key, item in value.items():
        if isinstance(item, str):
            out[str(key)] = item
        elif isinstance(item, bool):
            out[str(key)] = "true" if item else "false"
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            out[str(key)] = str(item)
    return out or None


_HEADER_LITERAL = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def header_map(value: object) -> dict[str, str] | None:
    raw = string_map(value)
    if raw is None:
        return None
    kept = {
        key: item
        for key, item in raw.items()
        if item == "" or "${" in item or _HEADER_LITERAL.fullmatch(item)
    }
    return kept or None


def collect_mcp(upstream: Path) -> list[dict[str, object]]:
    root = upstream / "third_party"
    raw_entries: list[tuple[str, str, dict[str, object]]] = []
    for plugin_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        manifest = plugin_dir / "mcp.json"
        if not manifest.is_file():
            continue
        data = json.loads(read_text(manifest))
        servers = data.get("mcpServers")
        if not isinstance(servers, dict):
            continue
        for name, server in servers.items():
            if not isinstance(name, str) or not name or not isinstance(server, dict):
                continue
            raw_entries.append((plugin_dir.name, name, server))
    counts = Counter(name for _plugin, name, _server in raw_entries)
    emitted: list[dict[str, object]] = []
    for plugin, name, server in raw_entries:
        final_name = f"{plugin}--{name}" if counts[name] > 1 else name
        command = server.get("command")
        url = server.get("url")
        command_text = command if isinstance(command, str) and command else None
        url_text = url if isinstance(url, str) and url else None
        if command_text is not None:
            transport = "stdio"
        elif url_text is not None:
            upstream_type = server.get("type")
            transport = upstream_type if upstream_type in ("http", "sse") else "http"
        else:
            continue
        entry: dict[str, object] = {
            "name": final_name,
            "plugin": plugin,
            "type": transport,
        }
        if url_text is not None:
            entry["url"] = url_text
        if command_text is not None:
            entry["command"] = command_text
        args = server.get("args")
        if isinstance(args, list) and args:
            entry["args"] = [item if isinstance(item, str) else str(item) for item in args]
        headers = header_map(server.get("headers"))
        if headers is not None:
            entry["headers"] = headers
        env = string_map(server.get("env"))
        if env is not None:
            entry["env"] = env
        emitted.append(entry)
    emitted.sort(key=lambda item: (str(item["plugin"]), str(item["name"])))
    return emitted


def write_index(catalog: Path, names: list[str]) -> None:
    path = catalog.parent / "references" / "catalog-index.md"
    extras: list[str] = []
    if path.exists():
        previous = path.read_text(encoding="utf-8")
        for extra in ("local-plugin", "mcp-servers"):
            if re.search(rf"(^|\s)`?{re.escape(extra)}`?(\s|$)", previous):
                extras.append(extra)
    lines = ["# Catalog index", ""]
    for name in sorted(names):
        lines.append(f"- `{name}`")
    for extra in extras:
        if extra not in names:
            lines.append(f"- `{extra}`")
    write_text(path, "\n".join(lines) + "\n")


def assert_clean(root: Path) -> None:
    import os

    for dirpath, _dirnames, filenames in os.walk(root):
        for filename in filenames:
            text = read_text(Path(dirpath) / filename).lower()
            if "claude" in text or "anthropic" in text:
                raise SystemExit(f"banned substring remains in {dirpath}/{filename}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/vendor-cursor-pack.py /path/to/cursor-plugins")
    upstream = Path(sys.argv[1]).resolve()
    if not upstream.is_dir():
        raise SystemExit(f"upstream checkout not found: {upstream}")
    pack = Path(__file__).resolve().parents[1] / "packages/core/src/skills/builtin/cursor-pack"
    catalog = pack / "catalog"
    catalog.mkdir(parents=True, exist_ok=True)
    for child in catalog.iterdir():
        if child.name in ORIGINAL_CATALOG:
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    planned = collect_skills(upstream)
    for name, source in planned:
        copy_skill(source, catalog / name, name)
    servers = collect_mcp(upstream)
    write_text(
        pack / "references" / "mcp-servers.json",
        json.dumps(servers, indent=2, ensure_ascii=False) + "\n",
    )
    write_text(pack / "LICENSE", LICENSE)
    write_text(pack / "NOTICE", NOTICE)
    write_index(catalog, [name for name, _source in planned])
    assert_clean(pack)
    print(f"catalog_dirs={len(planned)} mcp_servers={len(servers)}")


if __name__ == "__main__":
    main()
