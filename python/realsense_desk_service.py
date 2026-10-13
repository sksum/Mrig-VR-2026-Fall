#!/usr/bin/env python3
"""
realsense_desk_service.py — desk depth mapper for the sprites scene.

Replaces the old Corelink path. Reads a RealSense depth stream directly,
fits the desk plane, defines the fixed 2x2 ft (60x60 cm) play ROI, clusters
obstacles above the plane, and publishes a `deskMap` object into the
server.js DataStore over WebSocket:

    RealSense (USB) -> this service (2 Hz) -> wss://localhost:8447
        -> DataStore object 900001 {type:"deskMap", ...}
        -> browser sprites scene + MCP bridge (both read ws broadcasts)

Coordinate system (shared with MCP move_to / query_obstacles):
    origin = ROI center (desk centroid), units = millimeters,
    +x = right in camera image, +y = away from camera (top of image).

Modes:
    (default)         live RealSense -> publish
    --simulate        synthetic desk (no camera needed) -> publish
    --replay FILE     replay a --record capture -> publish
    --record FILE     live RealSense -> save processed frames, no publish
    --calibrate       one detection pass, print calibration info, exit

Usage:
    python3 python/realsense_desk_service.py --simulate
    python3 python/realsense_desk_service.py --calibrate
    python3 python/realsense_desk_service.py
"""

import argparse
import asyncio
import json
import math
import ssl
import sys
import time
from collections import deque

import numpy as np

try:
    import pyrealsense2 as rs
    HAVE_RS = True
except ImportError:
    HAVE_RS = False

try:
    import websockets
    HAVE_WS = True
except ImportError:
    HAVE_WS = False

TAG = "[desk-service]"


def log(*a):
    print(TAG, *a, flush=True)


# ---------------------------------------------------------------------------
# Frame sources — each yields (points, meta) where points is an (N,3) float32
# array of [px, py, depth_mm] in the cropped 448x224 pixel grid.
# ---------------------------------------------------------------------------

IMG_W, IMG_H = 448, 224          # 640x480 minus 96px side / 128px top-bottom crops
MAX_DEPTH_MM = 2000


class RealSenseSource:
    """Live RealSense camera (640x480 z16, cropped like realsense_bytestream.py)."""

    HBORDER, VBORDER = 96, 128

    def __init__(self):
        if not HAVE_RS:
            raise RuntimeError("pyrealsense2 is not installed (pip install pyrealsense2)")
        self.pipeline = rs.pipeline()
        config = rs.config()
        config.enable_stream(rs.stream.depth, 640, 480, rs.format.z16, 30)
        self.pipeline.start(config)
        log("RealSense pipeline started (640x480 z16 @30fps, cropped to %dx%d)" % (IMG_W, IMG_H))

    def read(self):
        frames = self.pipeline.wait_for_frames()
        depth_frame = frames.get_depth_frame()
        if not depth_frame:
            return None
        depth = np.asanyarray(depth_frame.get_data())[
            self.VBORDER:-self.VBORDER, self.HBORDER:-self.HBORDER].astype(np.float32)
        return depth_to_points(depth)

    def close(self):
        self.pipeline.stop()


def depth_to_points(depth):
    """Full cropped depth image -> subsampled [px, py, d] points (<= 12000)."""
    valid = depth[(depth > 0) & (depth < MAX_DEPTH_MM)]
    if valid.size < 100:
        return None
    mask = (depth > 0) & (depth < MAX_DEPTH_MM)
    ys, xs = np.nonzero(mask)
    ds = depth[ys, xs]
    # subsample for speed (full grid is ~100k px, we only need statistics + clusters)
    n = len(ds)
    if n > 12000:
        idx = np.random.choice(n, 12000, replace=False)
        ys, xs, ds = ys[idx], xs[idx], ds[idx]
    pts = np.stack([xs.astype(np.float32), ys.astype(np.float32), ds], axis=1)
    return pts


class SimulatedSource:
    """Synthetic desk: flat plane at 700mm with two boxes on it. For pipeline testing."""

    def __init__(self):
        log("SIMULATED source: plane 700mm, boxes at (-150,-100,80mm tall) and (120,80,150mm tall)")
        self.t = 0

    def read(self):
        rng = np.random.default_rng()
        self.t += 1
        xx, yy = np.meshgrid(np.arange(IMG_W), np.arange(IMG_H))
        depth = np.full((IMG_H, IMG_W), 700.0, dtype=np.float32)
        depth += rng.normal(0, 2.0, (IMG_H, IMG_W))                       # sensor noise
        cx, cy = IMG_W / 2, IMG_H / 2
        px_per_mm = 615.0 / 700.0                                          # fx / d
        # box A: 100x100mm, 80mm tall, at ROI (-150, -100) [mm, x right / y away]
        for (bx, by, sw, sh, hgt) in [(-150, -100, 50, 50, 80), (120, 80, 60, 40, 150)]:
            x0 = cx + (bx - sw) * px_per_mm
            x1 = cx + (bx + sw) * px_per_mm
            y0 = cy - (by + sh) * px_per_mm        # image y is down; +y away = up in image
            y1 = cy - (by - sh) * px_per_mm
            depth[int(y0):int(y1), int(x0):int(x1)] = 700 - hgt
        depth = np.clip(depth, 1, MAX_DEPTH_MM - 1)
        # sprinkle dropouts
        drop = rng.random((IMG_H, IMG_W)) < 0.05
        depth[drop] = 0
        return depth_to_points(depth)

    def close(self):
        pass


class ReplaySource:
    """Replay frames recorded with --record."""

    def __init__(self, path):
        self.frames = []
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    self.frames.append(np.array(json.loads(line), dtype=np.float32))
        log("replay: %d frames from %s" % (len(self.frames), path))
        self.i = 0

    def read(self):
        if not self.frames:
            return None
        pts = self.frames[self.i % len(self.frames)]
        self.i += 1
        return pts

    def close(self):
        pass


# ---------------------------------------------------------------------------
# Desk mapping: plane fit -> ROI -> obstacles -> temporal smoothing
# ---------------------------------------------------------------------------

class DeskMapper:
    def __init__(self, fx=615.0, roi_mm=600.0, plane_sigma_max=25.0, min_frac=0.15,
                 obstacle_min_mm=30.0, cell_px=8, min_cluster_pts=12):
        self.fx = fx
        self.roi_mm = roi_mm
        self.plane_sigma_max = plane_sigma_max
        self.min_frac = min_frac
        self.obstacle_min_mm = obstacle_min_mm
        self.cell_px = cell_px
        self.min_cluster_pts = min_cluster_pts
        self.ema_d = None
        self.ema_alpha = 0.3
        self.tracked = {}          # id -> {box, seen, missed}
        self.next_id = 1
        self.raw_d = None

    def find_plane(self, pts):
        """Dominant depth cluster via 10mm histogram. Returns (d_mm, sigma) or None."""
        d = pts[:, 2]
        hist, edges = np.histogram(d, bins=np.arange(0, MAX_DEPTH_MM + 10, 10))
        best_bin = int(np.argmax(hist))
        lo, hi = edges[best_bin], edges[best_bin + 1]
        inlier = d[(d >= lo - 20) & (d < hi + 20)]
        if inlier.size < self.min_frac * d.size or inlier.size < 300:
            return None
        med = float(np.median(inlier))
        sigma = float(np.std(inlier - med))
        if sigma > self.plane_sigma_max:
            return None
        return med, sigma

    def map_frame(self, pts):
        """One detection pass. Returns the deskMap dict (status may be 'searching')."""
        out = {
            "type": "deskMap",
            "ts": time.time(),
            "status": "searching",
            "roi": {"widthMm": self.roi_mm, "depthMm": self.roi_mm},
            "frame": {"w": IMG_W, "h": IMG_H},
            "desk": None,
            "obstacles": [],
        }
        if pts is None or len(pts) < 300:
            return out

        plane = self.find_plane(pts)
        if plane is None:
            log("plane: no dominant cluster found (%d pts)" % len(pts))
            self.ema_d = None
            return out
        med, sigma = plane
        self.raw_d = med
        self.ema_d = med if self.ema_d is None else self.ema_alpha * med + (1 - self.ema_alpha) * self.ema_d
        d_desk = self.ema_d

        px_per_mm = self.fx / d_desk
        # desk region = plane inliers; centroid defines ROI center
        inlier = pts[np.abs(pts[:, 2] - d_desk) < 30]
        cx_px, cy_px = float(inlier[:, 0].mean()), float(inlier[:, 1].mean())
        half_px = (self.roi_mm / 2) * px_per_mm

        out["status"] = "ok"
        out["desk"] = {
            "dMm": round(d_desk, 1),
            "sigmaMm": round(sigma, 1),
            "cx": round(cx_px, 1),
            "cy": round(cy_px, 1),
            "pxPerMm": round(px_per_mm, 4),
            "roiHalfPx": round(half_px, 1),
            "inliers": int(inlier.size),
        }

        # ---- obstacles: points above plane (closer to camera), inside ROI
        above = pts[(d_desk - pts[:, 2]) > self.obstacle_min_mm]
        roi = above[
            (np.abs(above[:, 0] - cx_px) < half_px) & (np.abs(above[:, 1] - cy_px) < half_px)]
        clusters = self._cluster(roi, cx_px, cy_px, px_per_mm, d_desk)
        out["obstacles"] = self._smooth(clusters)
        return out

    def _cluster(self, roi, cx_px, cy_px, px_per_mm, d_desk):
        """Grid connected components over the above-plane points inside the ROI."""
        if len(roi) < self.min_cluster_pts:
            return []
        cell = self.cell_px
        cells = {}
        for px, py, d in roi:
            k = (int(px // cell), int(py // cell))
            cells.setdefault(k, []).append(d)
        # BFS connected components (8-neighborhood)
        seen = set()
        clusters = []
        for k in cells:
            if k in seen:
                continue
            comp, queue = [], deque([k])
            seen.add(k)
            while queue:
                c = queue.popleft()
                comp.append(c)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nk = (c[0] + dx, c[1] + dy)
                        if nk in cells and nk not in seen:
                            seen.add(nk)
                            queue.append(nk)
            if len(comp) < 1:
                continue
            xs = [c[0] for c in comp]
            ys = [c[1] for c in comp]
            npts = sum(len(cells[c]) for c in comp)
            if npts < self.min_cluster_pts:
                continue
            x0, x1 = min(xs) * cell, (max(xs) + 1) * cell
            y0, y1 = min(ys) * cell, (max(ys) + 1) * cell
            # pixel bbox -> ROI mm coords (origin ROI center, +y away from camera)
            mx0 = (x0 - cx_px) / px_per_mm
            mx1 = (x1 - cx_px) / px_per_mm
            my0 = (cy_px - y1) / px_per_mm
            my1 = (cy_px - y0) / px_per_mm
            ds = np.array([d for c in comp for d in cells[c]])
            clusters.append({
                "x": round((mx0 + mx1) / 2, 1), "y": round((my0 + my1) / 2, 1),
                "w": round(mx1 - mx0, 1), "h": round(my1 - my0, 1),
                "heightMm": round(d_desk - float(np.median(ds)), 1),
            })
        return clusters

    def _smooth(self, clusters):
        """IoU matching for stable ids + add/remove debounce (2 consecutive)."""
        def iou(a, b):
            ax0, ax1 = a["x"] - a["w"] / 2, a["x"] + a["w"] / 2
            ay0, ay1 = a["y"] - a["h"] / 2, a["y"] + a["h"] / 2
            bx0, bx1 = b["x"] - b["w"] / 2, b["x"] + b["w"] / 2
            by0, by1 = b["y"] - b["h"] / 2, b["y"] + b["h"] / 2
            ix = max(0, min(ax1, bx1) - max(ax0, bx0))
            iy = max(0, min(ay1, by1) - max(ay0, by0))
            inter = ix * iy
            if inter <= 0:
                return 0.0
            return inter / (a["w"] * a["h"] + b["w"] * b["h"] - inter)

        result = []
        used = set()
        for cid, tr in list(self.tracked.items()):
            best, best_iou = None, 0.0
            for i, c in enumerate(clusters):
                if i in used:
                    continue
                v = iou(tr["box"], c)
                if v > best_iou:
                    best, best_iou = i, v
            if best is not None and best_iou > 0.3:
                used.add(best)
                self.tracked[cid] = {"box": clusters[best], "seen": tr["seen"] + 1, "missed": 0}
                if self.tracked[cid]["seen"] >= 2:
                    ob = dict(clusters[best]); ob["id"] = cid
                    result.append(ob)
            else:
                tr["missed"] += 1
                if tr["missed"] >= 2:
                    log("obstacle %d removed %s" % (cid, tr["box"]))
                    del self.tracked[cid]
        for i, c in enumerate(clusters):
            if i not in used:
                cid = self.next_id
                self.next_id += 1
                self.tracked[cid] = {"box": c, "seen": 1, "missed": 0}
                log("obstacle %d new (pending confirm) %s" % (cid, c))
        return result


# ---------------------------------------------------------------------------
# WebSocket publisher -> server.js DataStore
# ---------------------------------------------------------------------------

DESKMAP_ID = 900001


class Publisher:
    def __init__(self, url):
        if not HAVE_WS:
            raise RuntimeError("websockets is not installed (pip install websockets)")
        self.url = url
        self.ws = None
        self.inited = False
        self.ssl_ctx = ssl.create_default_context()
        self.ssl_ctx.check_hostname = False
        self.ssl_ctx.verify_mode = ssl.CERT_NONE     # server.js uses a self-signed cert

    async def run(self, get_map):
        """Connect (with reconnect) and publish whatever get_map() returns each tick."""
        while True:
            try:
                async with websockets.connect(self.url, ssl=self.ssl_ctx,
                                              max_size=2 ** 22, ping_interval=20) as ws:
                    self.ws = ws
                    self.inited = False
                    log("connected to", self.url)
                    while True:
                        m = get_map()
                        if m is not None:
                            await self.publish(m)
                        await asyncio.sleep(0.5)
            except (OSError, websockets.exceptions.WebSocketException) as e:
                log("ws disconnected/error:", e, "- reconnecting in 2s")
                await asyncio.sleep(2)

    async def publish(self, m):
        if self.ws is None:
            return
        if not self.inited:
            init_state = dict(m)
            init_state["objid"] = DESKMAP_ID
            await self.ws.send(json.dumps({
                "type": "objectInit", "ts": int(time.time() * 1000),
                "uid": "desk-service", "state": init_state}))
            self.inited = True
            log("objectInit sent for deskMap id", DESKMAP_ID)
        else:
            await self.ws.send(json.dumps({
                "type": "object", "ts": int(time.time() * 1000),
                "uid": "desk-service", "id": DESKMAP_ID, "state": m}))
        if m["status"] == "ok":
            log("publish: plane=%.1fmm px/mm=%.3f obstacles=%s" % (
                m["desk"]["dMm"], m["desk"]["pxPerMm"],
                [(o["id"], o["x"], o["y"], o["w"], o["h"], o["heightMm"]) for o in m["obstacles"]]))
        else:
            log("publish: status=searching (no desk found yet)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="RealSense desk mapper -> DataStore deskMap publisher")
    ap.add_argument("--ws-url", default="wss://localhost:8447")
    ap.add_argument("--fx", type=float, default=615.0, help="camera focal length px (D435 640w ~615)")
    ap.add_argument("--roi-mm", type=float, default=600.0, help="play ROI side in mm (2ft = 609.6)")
    ap.add_argument("--simulate", action="store_true", help="synthetic desk, no camera")
    ap.add_argument("--record", metavar="FILE", help="record processed frames to FILE (jsonl)")
    ap.add_argument("--replay", metavar="FILE", help="replay recorded frames from FILE")
    ap.add_argument("--calibrate", action="store_true", help="one pass, print calibration, exit")
    args = ap.parse_args()

    log("args:", vars(args))

    if args.simulate:
        src = SimulatedSource()
    elif args.replay:
        src = ReplaySource(args.replay)
    else:
        try:
            src = RealSenseSource()
        except RuntimeError as e:
            log("FATAL:", e)
            log("no camera available - use --simulate for pipeline testing")
            sys.exit(1)

    mapper = DeskMapper(fx=args.fx, roi_mm=args.roi_mm)
    rec_f = open(args.record, "w") if args.record else None
    latest = {"map": None}
    state = {"last_processed": 0.0}

    def tick():
        """Read a frame at most every 0.5s, map it, keep the latest result."""
        now = time.time()
        if now - state["last_processed"] < 0.5:
            return latest["map"]
        state["last_processed"] = now
        pts = src.read()
        if rec_f is not None and pts is not None:
            rec_f.write(json.dumps(pts.tolist()) + "\n")
            rec_f.flush()
        m = mapper.map_frame(pts)
        latest["map"] = m
        return m

    if args.calibrate:
        log("calibrate: reading a few frames - put markers at your intended 2x2 corners...")
        for _ in range(10):
            m = tick()
            time.sleep(0.4)
        if m and m["status"] == "ok":
            d = m["desk"]
            log("=" * 60)
            log("plane depth   : %.1f mm (sigma %.1f)" % (d["dMm"], d["sigmaMm"]))
            log("ROI center px : (%.1f, %.1f)" % (d["cx"], d["cy"]))
            log("px per mm     : %.4f  (fx=%.1f / d)" % (d["pxPerMm"], args.fx))
            log("ROI half box  : %.1f px  (= %.0f mm)" % (d["roiHalfPx"], args.roi_mm / 2))
            log("obstacles seen: %s" % m["obstacles"])
            log("re-run without --calibrate to stream; tune --fx if mm scale is off")
            log("=" * 60)
        else:
            log("calibrate: could not find a desk plane - check camera aim")
        src.close()
        return

    if not HAVE_WS:
        log("FATAL: websockets missing (pip install websockets)")
        sys.exit(1)

    async def producer():
        pub = Publisher(args.ws_url)
        await pub.run(tick)

    try:
        asyncio.run(producer())
    except KeyboardInterrupt:
        log("stopped")
    finally:
        if rec_f:
            rec_f.close()
        src.close()


if __name__ == "__main__":
    main()
