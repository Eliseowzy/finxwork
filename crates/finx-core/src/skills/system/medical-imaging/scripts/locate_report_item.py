"""Rank places in a chest CT that match one finding from a report.

Run through `spatial_script`. Input: one JSON string in argv[1]:
  {"side": "right" | "left" | "any",          # patient's side
   "lobe": "upper" | "middle" | "lower" | "any",
   "kind": "solid" | "ground_glass" | "any",
   "size_mm": 8.0,                             # as written in the report
   "near": "pleura" | "any",                   # optional: 胸膜下
   "image_number": 141,                        # optional: report's image/slice number
   "label": "右肺上叶磨玻璃结节"}               # optional text for the marker
If image_number is given the script does not search: it submits a marker on that
slice (centre of the lung there) and says so. Otherwise it searches the lung of
the given side, limited to the lobe by height, and returns the best matches.

Output (also submitted): up to 5 matches
  {"rank": int, "center_voxel": [k, j, i], "diameter_mm": float, "kind": str,
   "mean_hu": float, "contact": [...], "match": float, "why": str}
or an empty list when nothing in that region fits (say so plainly; do not guess).
Lobe limits are approximate by height of the lung: upper top third, middle
(right only) middle third in front, lower bottom third and back.
"""
import json
import sys

import numpy as np
from scipy import ndimage as ndi

from finx_spatial import load, submit


def main():
    args = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else {}
    vol = load()
    hu = vol.hu
    sp = np.asarray(vol.spacing, dtype=float)
    label = args.get("label", "报告所述")

    seg = {"right": "lung_right", "left": "lung_left", "any": "lungs"}[args.get("side", "any")]
    lung = vol.segment(seg).astype(bool)

    if args.get("image_number") is not None:
        k = int(args["image_number"])
        # The kernel maps image numbers to slice indexes; vol.slice_of_image does the mapping.
        k = vol.slice_of_image(k)
        inside = lung[k]
        if not inside.any():
            print(json.dumps([]))
            return
        j, i = (int(round(v)) for v in ndi.center_of_mass(inside))
        submit.marker(center_voxel=[k, j, i], label=label, source="reference",
                      note="位置只到该层面，具体位置请在图上核对")
        print(json.dumps([{"rank": 1, "center_voxel": [k, j, i], "why": "按报告图像号定位到该层"}]))
        return

    # Restrict to a lobe by height (z axis, k) and front/back (y axis, j).
    lobe = args.get("lobe", "any")
    if lobe != "any" and lung.any():
        ks = np.where(lung.any(axis=(1, 2)))[0]
        ks_sorted = np.sort(ks)
        lo, hi = ks_sorted[0], ks_sorted[-1]
        # Direction of k vs head is given by the kernel.
        head_up = vol.k_towards_head
        t = (hi - lo + 1) / 3.0
        top = (lo + 2 * t, hi + 1) if head_up else (lo, lo + t)
        mid = (lo + t, lo + 2 * t)
        bot = (lo, lo + t) if head_up else (lo + 2 * t, hi + 1)
        lo_k, hi_k = {"upper": top, "middle": mid, "lower": bot}[lobe]
        keep = np.zeros_like(lung)
        keep[int(lo_k):int(hi_k)] = True
        lung = lung & keep

    # Candidate blobs, density classes by the report's kind.
    want = args.get("kind", "any")
    size = args.get("size_mm")
    classes = []
    if want in ("solid", "any"):
        classes.append(("solid", (hu > -300) & lung))
    if want in ("ground_glass", "any"):
        classes.append(("ground_glass", (hu > -750) & (hu <= -300) & lung))
    dist_edge = ndi.distance_transform_edt(vol.segment("lungs").astype(bool), sampling=sp)
    vox = float(np.prod(sp))
    out = []
    for kind, mask in classes:
        mask = ndi.binary_opening(mask, iterations=1)
        labels, n = ndi.label(mask)
        for lab, sl in enumerate(ndi.find_objects(labels), start=1):
            m = labels[sl] == lab
            d = (6.0 * m.sum() * vox / np.pi) ** (1 / 3)
            if d < 3 or d > 35:
                continue
            idx = np.argwhere(m)
            ext = (idx.max(0) - idx.min(0) + 1) * sp
            if ext.max() > 45:
                continue
            sph = float(ext.min() / ext.max())
            c = tuple(int(round(v)) for v in (idx.mean(0) + [s.start for s in sl]))
            near_pleura = bool(dist_edge[sl][m].min() <= 2.0)
            if args.get("near") == "pleura" and not near_pleura:
                continue
            match = 0.5 * sph
            why = [f"{kind}, ~{d:.0f} mm"]
            if size:
                match += 0.5 * max(0.0, 1 - abs(d - float(size)) / max(float(size), 1))
                why.append(f"report {size} mm")
            out.append({"center_voxel": list(c), "diameter_mm": round(float(d), 1), "kind": kind,
                        "mean_hu": round(float(hu[sl][m].mean()), 0),
                        "contact": ["pleura"] if near_pleura else [], "match": round(match, 3),
                        "why": "; ".join(why)})
    out.sort(key=lambda r: -r["match"])
    out = out[:5]
    for n, r in enumerate(out, start=1):
        r["rank"] = n
    submit.candidates(out, source="locate_report_item.py", args=args, reference_label=label)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
