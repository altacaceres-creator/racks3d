#!/usr/bin/env python3
"""Pre-publication privacy check for racks3d.

Scans every file that would be published (tracked + untracked-but-not-ignored
when inside a git repository, otherwise every file) and fails when it finds:

  * IPv4 addresses outside the documentation ranges (192.0.2.0/24,
    198.51.100.0/24, 203.0.113.0/24) and a few harmless ones (0.0.0.0, 127.0.0.1)
  * MAC addresses
  * strings that look like serial numbers
  * words from tools/blocklist.txt (one per line, case-insensitive, NOT versioned)
  * image files (no photos or downloaded pictures in the public repo), except PNG
    screenshots of this app itself in docs/screenshots/, taken with the sample data
  * private data files that are tracked by git (data/private-*.js, private/)

Third-party vendor code (js/vendor/) is only checked against the blocklist.

Usage:  python3 tools/check_public.py        exit code 0 = clean, 1 = findings
"""
import ipaddress
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BLOCKLIST = os.path.join(ROOT, "tools", "blocklist.txt")
DOC_NETS = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
ALLOWED_IPS = {"0.0.0.0", "127.0.0.1"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg", ".ico", ".heic", ".avif"}
SKIP_PATTERNS_UNDER = ("js/vendor/",)
SKIP_FILES = {"tools/blocklist.txt", "tools/check_public.py"}
SCREENSHOTS = "docs/screenshots/"

RE_IP = re.compile(r"(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])")
RE_MAC = re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b|\b(?:[0-9A-Fa-f]{4}\.){2}[0-9A-Fa-f]{4}\b")
# 8-20 uppercase letters and digits, at least 3 of each, no separators (e.g. "ABC1234X5YZ")
RE_SERIAL = re.compile(r"\b(?=(?:[A-Z0-9]*[0-9]){3})(?=(?:[A-Z0-9]*[A-Z]){3})[A-Z0-9]{8,20}\b")


def published_files():
    try:
        out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                             cwd=ROOT, capture_output=True, check=True).stdout.decode()
        files = [f for f in out.split("\0") if f]
        tracked = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode()
        return files, [f for f in tracked.split("\0") if f]
    except (OSError, subprocess.CalledProcessError):
        files = []
        for base, dirs, names in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d not in (".git", "private", "node_modules")]
            for n in names:
                rel = os.path.relpath(os.path.join(base, n), ROOT).replace(os.sep, "/")
                if not re.match(r"data/private-.*\.js$", rel):
                    files.append(rel)
        return files, []


def load_blocklist():
    if not os.path.exists(BLOCKLIST):
        return []
    with open(BLOCKLIST, encoding="utf-8") as fh:
        return [w.strip().lower() for w in fh if w.strip() and not w.lstrip().startswith("#")]


def main():
    files, tracked = published_files()
    words = load_blocklist()
    findings = []

    def hit(path, line, what, text):
        findings.append("%s:%s  %s  %s" % (path, line, what, text.strip()[:120]))

    for f in tracked:
        if re.match(r"(data/private-.*\.js|private/)", f) or f == "tools/blocklist.txt":
            hit(f, "-", "TRACKED PRIVATE FILE", "remove it from git and keep it ignored")

    for rel in sorted(files):
        if rel in SKIP_FILES:
            continue
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(rel)[1].lower()
        if ext in IMAGE_EXT:
            if not (rel.startswith(SCREENSHOTS) and ext == ".png"):
                hit(rel, "-", "IMAGE FILE", "only code-drawn faces are allowed (and PNG screenshots of the app in %s)" % SCREENSHOTS)
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        vendor = rel.startswith(SKIP_PATTERNS_UNDER)
        for n, line in enumerate(lines, 1):
            low = line.lower()
            for w in words:
                if w in low:
                    hit(rel, n, "BLOCKLIST '%s'" % w, line)
            if vendor:
                continue
            for m in RE_IP.finditer(line):
                ip = m.group(0)
                if any(int(o) > 255 for o in m.groups()) or ip in ALLOWED_IPS:
                    continue
                if not any(ipaddress.ip_address(ip) in net for net in DOC_NETS):
                    hit(rel, n, "IP ADDRESS", ip)
            for m in RE_MAC.finditer(line):
                hit(rel, n, "MAC ADDRESS", m.group(0))
            for m in RE_SERIAL.finditer(line):
                hit(rel, n, "SERIAL-LIKE", m.group(0))

    if not words:
        print("note: tools/blocklist.txt not found or empty - copy tools/blocklist.example.txt and add your own words")
    if findings:
        print("check_public: %d finding(s)\n" % len(findings))
        print("\n".join(findings))
        sys.exit(1)
    print("check_public: OK - %d file(s) scanned, no findings" % len(files))


if __name__ == "__main__":
    main()
