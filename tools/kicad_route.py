#!/usr/bin/env python3
# plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
# SPDX-License-Identifier: LGPL-3.0-or-later
# Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

"""Routes a board spec through KiCad + Freerouting.

Usage: kicad_route.py SPEC_JSON SES_OUT [--single-layer]

Reads a board spec (see tools/lib/boardgeo.mjs buildBoardSpec), builds a
KiCad board in memory, exports Specctra DSN, runs the Freerouting autorouter
with its GUI disabled (v2.5.0 otherwise opens its Swing UI when a display
exists), and copies the resulting .ses session to SES_OUT.

With --single-layer, a board-wide keepout blocks B.Cu (tracks and vias), so
the router may only use F.Cu. The via padstack stays in the DSN: a board
without one crashes Freerouting (see tooling notes). The caller uses this for
a first F.Cu-only pass and re-runs without the flag when it comes back
unroutable.

Requires: python3 with the pcbnew module (kicad package), java >= 25 and the
Freerouting jar (tools/vendor/freerouting.jar or $FREEROUTING_JAR).

Tooling notes (KiCad 10 pcbnew SWIG quirks, all verified empirically):
  - every SWIG proxy added to the board (PCB_SHAPE, ZONE, SHAPE_POLY_SET
    passed to SetOutline, NETINFO_ITEM, FOOTPRINT, PAD) must be kept alive in
    a Python list; garbage-collecting them while the board still references
    them segfaults SaveBoard/ExportSpecctraDSN.
  - LSET(int) / LSET(list) ctors are broken in this build; use
    pcbnew.PAD.SMDMask() for SMD pads.
  - pcbnew emits harmless wx "PROPERTY_ENUM" asserts on stderr.
  - pcbnew.ImportSpecctraSES returns False silently in this build, so the
    caller parses the .ses directly (tools/lib/boardgeo.mjs sesToWorld).
  - DSN/SES mirror the y axis (KiCad y-down vs Specctra y-up) and carry their
    own (resolution unit div) header; see sesToWorld for the transform.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import pcbnew


def keepall(container):
    def add(*objs):
        container.extend(objs)
    return add


def find_freerouting():
    jar = os.environ.get("FREEROUTING_JAR")
    if jar and os.path.isfile(jar):
        return jar
    here = os.path.dirname(os.path.abspath(__file__))
    local = os.path.join(here, "vendor", "freerouting.jar")
    if os.path.isfile(local):
        return local
    raise SystemExit(
        "freerouting.jar not found; set FREEROUTING_JAR or place it at "
        + local
    )


def find_java():
    cand = os.environ.get("FREEROUTING_JAVA")
    if cand and os.path.exists(cand):
        return cand
    jvms = sorted(
        os.path.join(jvm, "bin", "java")
        for jvm in glob_dirs("/usr/lib/jvm", "java-*")
    )
    for j in reversed(jvms):  # newest first: freerouting 2.5 needs java >= 25
        if os.access(j, os.X_OK):
            return j
    java = shutil.which("java")
    if java:
        return java
    raise SystemExit("no java runtime found (freerouting needs java >= 25)")


def glob_dirs(base, pattern):
    try:
        names = os.listdir(base)
    except OSError:
        return []
    import fnmatch
    return [os.path.join(base, n) for n in sorted(names) if fnmatch.fnmatch(n, pattern)]


def build_board(spec, board_path, single_layer):
    keep = []
    add = keepall(keep)
    nm = int(spec["scaleNm"])

    def V(x, y):
        return pcbnew.VECTOR2I(int(round(x * nm)), int(round(y * nm)))

    board = pcbnew.NewBoard(board_path)
    add(board)

    edge = pcbnew.PCB_SHAPE(board)
    edge.SetShape(pcbnew.SHAPE_T_RECT)
    edge.SetStart(V(0, 0))
    edge.SetEnd(V(spec["board"]["w"], spec["board"]["d"]))
    edge.SetLayer(pcbnew.Edge_Cuts)
    board.Add(edge)
    add(edge)

    netitems = {}
    for net in spec["nets"]:
        item = pcbnew.NETINFO_ITEM(board, net["name"])
        board.Add(item)
        add(item)
        netitems[net["name"]] = item

    for fpack in spec["footprints"]:
        fp = pcbnew.FOOTPRINT(board)
        fp.SetReference(fpack["id"])
        fp.SetValue(fpack["id"])
        fp.SetPosition(V(fpack["x"], fpack["y"]))
        board.Add(fp)
        add(fp)
        for padpack in fpack["pads"]:
            pad = pcbnew.PAD(fp)
            pad.SetPadName(padpack["padName"])
            pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
            d = int(round(spec["padD"] * nm))
            pad.SetSize(pcbnew.VECTOR2I(d, d))
            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            pad.SetLayerSet(pcbnew.PAD.SMDMask())
            pad.SetPosition(V(padpack["x"], padpack["y"]))
            pad.SetNet(netitems[padpack["net"]])
            fp.Add(pad)
            add(pad)

    def zone(points, layer, tracks_only):
        z = pcbnew.ZONE(board)
        z.SetIsRuleArea(True)
        z.SetDoNotAllowTracks(True)
        if not tracks_only:
            z.SetDoNotAllowVias(True)
        z.SetLayer(layer)
        pol = pcbnew.SHAPE_POLY_SET()
        pol.NewOutline()
        for x, y in points:
            v = V(x, y)
            pol.Append(v.x, v.y)
        z.SetOutline(pol)
        board.Add(z)
        add(z, pol)

    def keepout(x0, y0, x1, y1, layer):
        zone(((x0, y0), (x1, y0), (x1, y1), (x0, y1)), layer, tracks_only=False)

    # TSV column shadow blocks behind stacked landing pads (see
    # boardgeo.mjs): tracks only — the final hop to the SMD pad is always
    # F.Cu, so vias stay legal. Both copper layers: a B.Cu trace hiding
    # behind a column reads exactly the same as an F.Cu one.
    for poly in spec.get("noTrackZones", []):
        zone(poly, pcbnew.F_Cu, tracks_only=True)
        zone(poly, pcbnew.B_Cu, tracks_only=True)

    if single_layer:
        # F.Cu-only pass: block B.Cu board-wide for tracks and vias. The
        # router keeps the via padstack but can never leave F.Cu.
        keepout(0, 0, spec["board"]["w"], spec["board"]["d"], pcbnew.B_Cu)
    return board, keep


def export_dsn(board, keep, dsn_path):
    if not pcbnew.ExportSpecctraDSN(board, dsn_path):
        raise SystemExit(f"ExportSpecctraDSN failed for {dsn_path}")


def run_freerouting(dsn_path, ses_path):
    jar = find_freerouting()
    java = find_java()
    # --gui.enabled=false: on a desktop v2.5.0 otherwise pops its Swing UI
    # (countdown dialog, auto-start, auto-save, auto-exit) per invocation.
    cmd = [java, "-Xmx2g", "-jar", jar, "-de", dsn_path, "-do", ses_path,
           "--gui.enabled=false", "--router.autorouter.max_passes=40",
           "-mt", "1"]
    log_path = os.path.splitext(ses_path)[0] + ".freerouting.log"
    with open(log_path, "w") as log:
        proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT,
                              timeout=600)
    if proc.returncode != 0 or not os.path.isfile(ses_path):
        raise SystemExit(
            f"freerouting failed (rc={proc.returncode}), log: {log_path}"
        )


def main():
    args = sys.argv[1:]
    single_layer = "--single-layer" in args
    args = [a for a in args if a != "--single-layer"]
    if len(args) < 2:
        raise SystemExit(__doc__)
    spec_path, ses_out = args[0], args[1]
    with open(spec_path) as f:
        spec = json.load(f)

    with tempfile.TemporaryDirectory(prefix="puml-pcb-") as tmp:
        board_path = os.path.join(tmp, "board.kicad_pcb")
        board, keep = build_board(spec, board_path, single_layer)
        dsn_path = os.path.join(tmp, "board.dsn")
        export_dsn(board, keep, dsn_path)
        shutil.copyfile(dsn_path, os.path.splitext(ses_out)[0] + ".dsn")
        ses_tmp = os.path.join(tmp, "board.ses")
        run_freerouting(dsn_path, ses_tmp)
        shutil.copyfile(ses_tmp, ses_out)
        log_tmp = os.path.splitext(ses_tmp)[0] + ".freerouting.log"
        if os.path.isfile(log_tmp):
            shutil.copyfile(log_tmp, os.path.splitext(ses_out)[0] + ".freerouting.log")
    print(f"ses: {ses_out}")


if __name__ == "__main__":
    main()
