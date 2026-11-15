"""Pack the tv-home LG app (boot page that redirects to the bridge) as a webOS .ipk, in pure Python.

    python lg/build.py [--bridge http://<home-server>:8790] [--no-acg] [--version 0.1.0]   (or env TVHOME_BRIDGE)
    python lg/build.py --list build/lg/com.lgcleantv.home_0.1.0_all.ipk     (show what is inside)

Output: build/lg/<id>_<version>_all.ipk (+ the staged folder build/lg/app/). Install later on the TV in
Developer Mode with `ares-install --device <tv> <ipk>` or webOS Dev Manager (not done by this script).
--no-acg uses lg/appinfo.noacg.json (no "requiredACG"), for testing whether launch works without it.

The .ipk is a Debian-style "ar" archive: debian-binary, control.tar.gz, data.tar.gz with the app under
usr/palm/applications/<id>/ and usr/palm/packages/<id>/packageinfo.json.

_tar_gz, _ar and pack_python are adapted from couch-tv lg/build.py:

    Copyright (c) 2026 Seagey

    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
    associated documentation files (the "Software"), to deal in the Software without restriction,
    including without limitation the rights to use, copy, modify, merge, publish, distribute,
    sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all copies or
    substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
    NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
    DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
    OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
"""
import argparse
import io
import json
import os
import shutil
import struct
import sys
import tarfile
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "build", "lg")


# ------------------------------------------------------------------ adapted from couch-tv (MIT, above)
def _tar_gz(entries):
    """entries: (name in the archive, bytes or None for a folder). Same order every time."""
    buf = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as t:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.mtime, info.uid, info.gid, info.uname, info.gname = now, 0, 0, "root", "root"
            if data is None:
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                t.addfile(info)
            else:
                info.size, info.mode = len(data), 0o644
                t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _ar(members):
    """A System V "ar" archive, as ares-package writes it."""
    out = [b"!<arch>\n"]
    now = str(int(time.time())).encode()
    for name, data in members:
        out.append(name.encode().ljust(16) + now.ljust(12) + b"0".ljust(6) + b"0".ljust(6)
                   + b"100644".ljust(8) + str(len(data)).encode().ljust(10) + b"\x60\n")
        out.append(data)
        if len(data) % 2:
            out.append(b"\n")
    return b"".join(out)


def pack_python(stage, info, ipk):
    app_id, version = info["id"], info["version"]
    files = []
    for dirpath, dirnames, names in os.walk(stage):
        dirnames.sort()
        rel = os.path.relpath(dirpath, stage)
        rel = "" if rel == "." else rel.replace(os.sep, "/") + "/"
        if rel:
            files.append((rel, None))
        for n in sorted(names):
            files.append((rel + n, os.path.join(dirpath, n)))
    entries, size = [], 0
    for d in ("usr", "usr/palm", "usr/palm/applications", "usr/palm/packages",
              f"usr/palm/applications/{app_id}", f"usr/palm/packages/{app_id}"):
        entries.append((d + "/", None))
    for rel, full in files:
        name = f"usr/palm/applications/{app_id}/{rel}"
        if full is None:
            entries.append((name, None))
        else:
            with open(full, "rb") as f:
                data = f.read()
            size += len(data)
            entries.append((name, data))
    pkginfo = json.dumps({"id": app_id, "version": version, "app": app_id}, indent=2).encode() + b"\n"
    entries.append((f"usr/palm/packages/{app_id}/packageinfo.json", pkginfo))
    control = "\n".join([
        f"Package: {app_id}", f"Version: {version}", "Section: misc", "Priority: optional",
        "Architecture: all", f"Installed-Size: {size}", "Maintainer: N/A <nobody@example.com>",
        "Description: This is a webOS application.", "webOS-Package-Format-Version: 2",
        "webOS-Packager-Version: x.y.x"]) + "\n"
    with open(ipk, "wb") as f:
        f.write(_ar([("debian-binary", b"2.0\n"),
                     ("control.tar.gz", _tar_gz([("control", control.encode())])),
                     ("data.tar.gz", _tar_gz(entries))]))
# ------------------------------------------------------------------ end of adapted code


def png(size, draw):
    """Minimal RGBA PNG writer: draw(x, y) -> (r, g, b, a) for each pixel centre in 0..1 coordinates."""
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            row += bytes(draw((x + .5) / size, (y + .5) / size))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def cat_icon(x, y):
    """App icon: a black cat head with amber eyes on a dark blue rounded square."""
    def inside_round_rect(px, py, r=.2):
        dx, dy = max(abs(px - .5) - (.5 - r), 0), max(abs(py - .5) - (.5 - r), 0)
        return dx * dx + dy * dy <= r * r
    if not inside_round_rect(x, y):
        return (0, 0, 0, 0)
    bg = (int(29 + 20 * (1 - y)), int(42 + 25 * (1 - y)), int(80 + 40 * (1 - y)), 255)
    head = ((x - .5) / .30) ** 2 + ((y - .60) / .25) ** 2 <= 1
    ear_l = y > .22 and y < .5 and abs(x - .30) < (y - .22) * .55
    ear_r = y > .22 and y < .5 and abs(x - .70) < (y - .22) * .55
    if head or ear_l or ear_r:
        for ex in (.39, .61):
            if ((x - ex) / .065) ** 2 + ((y - .58) / .075) ** 2 <= 1:
                return (40, 30, 10, 255) if abs(x - ex) < .015 else (255, 190, 60, 255)
        return (16, 18, 24, 255)
    return bg


def list_ipk(path):
    """Print the ar members and the tar contents of an .ipk (verification)."""
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"!<arch>\n", "not an ar archive"
    pos, members = 8, []
    while pos < len(data):
        hdr = data[pos:pos + 60]
        name, size = hdr[:16].decode().strip(), int(hdr[48:58].decode().strip())
        assert hdr[58:60] == b"\x60\n", "bad ar header"
        body = data[pos + 60:pos + 60 + size]
        members.append((name, body))
        pos += 60 + size + (size % 2)
    print(f"{os.path.basename(path)}: ar members = {[m[0] for m in members]}")
    for name, body in members:
        if name.endswith(".tar.gz"):
            with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as t:
                print(f"  {name}:")
                for m in t.getmembers():
                    print(f"    {'d' if m.isdir() else '-'} {m.size:8d}  {m.name}")
                    if m.name.endswith("appinfo.json") or m.name == "control" or m.name.endswith("settings.js"):
                        txt = t.extractfile(m).read().decode()
                        print("      | " + txt.strip().replace("\n", "\n      | "))
        else:
            print(f"  {name}: {body!r}")
    return members


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--bridge", default=os.environ.get("TVHOME_BRIDGE", "http://192.168.1.10:8790"),
                    help="the bridge URL the app opens (default: env TVHOME_BRIDGE)")
    ap.add_argument("--no-acg", action="store_true", help="use appinfo without requiredACG")
    ap.add_argument("--version", default="", help="override appinfo version")
    ap.add_argument("--list", metavar="IPK", help="only list the contents of an .ipk")
    a = ap.parse_args()
    if a.list:
        list_ipk(a.list)
        return

    stage = os.path.join(OUT, "app")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    shutil.copytree(os.path.join(HERE, "app"), stage, ignore=shutil.ignore_patterns(".*", "*.md"))
    info_src = os.path.join(HERE, "appinfo.noacg.json") if a.no_acg else os.path.join(HERE, "app", "appinfo.json")
    with open(info_src, encoding="utf-8") as f:
        info = json.load(f)
    if a.version:
        info["version"] = a.version
    with open(os.path.join(stage, "appinfo.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2, ensure_ascii=False)
        f.write("\n")
    bridge = a.bridge.rstrip("/")
    if not bridge.startswith(("http://", "https://")):
        raise SystemExit("--bridge must start with http:// or https://")
    with open(os.path.join(stage, "settings.js"), "w", encoding="utf-8") as f:
        f.write("window.TVHOME = " + json.dumps({"bridge": bridge, "build": time.strftime("%Y-%m-%dT%H:%M:%S")}) + ";\n")
    for name, size in (("icon.png", 80), ("largeIcon.png", 130)):
        with open(os.path.join(stage, name), "wb") as f:
            f.write(png(size, cat_icon))

    os.makedirs(OUT, exist_ok=True)
    ipk = os.path.join(OUT, f"{info['id']}_{info['version']}_all.ipk")
    if os.path.exists(ipk):
        os.remove(ipk)
    pack_python(stage, info, ipk)
    print(f"built {os.path.relpath(ipk, ROOT)} ({os.path.getsize(ipk)} bytes), bridge {bridge}, "
          f"{'no requiredACG' if a.no_acg else 'requiredACG ' + ','.join(info.get('requiredACG', []))}")
    list_ipk(ipk)


if __name__ == "__main__":
    sys.exit(main())
