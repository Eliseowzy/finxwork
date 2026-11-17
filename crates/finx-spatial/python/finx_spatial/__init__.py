"""Reads a volume the kernel prepared and submits results back (spatial-design §5.3, §13).

`spatial_script` runs a script in a work directory holding
  volume.npy        int16, shape (k, j, i), in meta.json's "unit" (none: raw grey levels)
  meta.json         {"spacing": [dk, dj, di], "origin", "direction", "unit",
                     "image_numbers": [one per k], "k_towards_head": bool,
                     "masks": {"<id>": "masks/<id>.npy"}}
  masks/<id>.npy    bool, shape (k, j, i)
and reads back out/submit.jsonl, one JSON object per line with "type" one of
candidate | marker | structure | finding | profile. Structures carry the path of a mask
saved under out/masks/. The kernel checks every line; bad lines are refused.

The directory is $FINX_SPATIAL_DIR, else the current directory.
"""
import json
import os
import re

import numpy as np

__all__ = ["load", "submit", "Volume"]


def _dir():
    return os.environ.get("FINX_SPATIAL_DIR") or os.getcwd()


class Volume:
    def __init__(self, root):
        self.root = root
        with open(os.path.join(root, "meta.json"), encoding="utf-8") as f:
            self.meta = json.load(f)
        self.values = np.load(os.path.join(root, "volume.npy"), mmap_mode="r")
        self.spacing = tuple(float(v) for v in self.meta["spacing"])
        self.origin = tuple(self.meta.get("origin", (0.0, 0.0, 0.0)))
        self.direction = self.meta.get("direction")
        self.unit = self.meta.get("unit")
        self.k_towards_head = bool(self.meta.get("k_towards_head", True))
        self.image_numbers = list(self.meta.get("image_numbers") or [])
        self._masks = dict(self.meta.get("masks") or {})

    @property
    def hu(self):
        """The values, under the name scripts for CT use."""
        return self.values

    @property
    def shape(self):
        return tuple(self.values.shape)

    def segments(self):
        """Names of the masks the kernel provided: the document's structures."""
        return sorted(self._masks)

    def segment(self, name):
        """The bool mask of a structure, shape (k, j, i)."""
        if name in self._masks:
            return np.load(os.path.join(self.root, self._masks[name]), mmap_mode="r")
        raise KeyError(f"no segment {name!r}; have {self.segments()}")

    def slice_of_image(self, n):
        """The k index of the image whose number (as printed on the film / report) is n."""
        n = int(n)
        if self.image_numbers:
            if n in self.image_numbers:
                return self.image_numbers.index(n)
            raise KeyError(f"no image number {n}")
        k = n - 1
        if not 0 <= k < self.values.shape[0]:
            raise KeyError(f"no image number {n}")
        return k


def load():
    return Volume(_dir())


class _Submit:
    """Writes to out/submit.jsonl. Every call appends lines; nothing reaches the
    document until the script ends and the kernel accepts them."""

    def _out(self):
        out = os.path.join(_dir(), "out")
        os.makedirs(out, exist_ok=True)
        return out

    def _write(self, obj):
        with open(os.path.join(self._out(), "submit.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(_plain(obj), ensure_ascii=False) + "\n")

    def candidates(self, items, source=None, args=None, reference_label=None):
        for item in items:
            line = {"type": "candidate", **item}
            if source is not None:
                line["source_script"] = source
            if reference_label is not None:
                line["reference_label"] = reference_label
            self._write(line)

    def marker(self, center_voxel, label, source="ai", note=None):
        self._write({"type": "marker", "center_voxel": list(center_voxel), "label": label,
                     "source": source, "note": note})

    def structure(self, mask, id, name, color="#e0a040", opacity=None, hidden=False,
                  expect_ml=None, notes=None, unreliable=None):
        """A mask as a structure of the document. `hidden` keeps the mask for later
        scripts without showing a surface. `expect_ml` is (least, most): outside it the
        kernel reports the structure as unreliable. `unreliable` is the script's own reason
        not to trust it (it leaked, no seed was found), reported the same way. `notes` are
        remarks on how it was built, passed on to the model."""
        if not re.fullmatch(r"[a-z0-9_-]{1,64}", str(id)):
            raise ValueError("structure id: 1-64 of a-z 0-9 _ -")
        masks = os.path.join(self._out(), "masks")
        os.makedirs(masks, exist_ok=True)
        np.save(os.path.join(masks, f"{id}.npy"), np.asarray(mask, dtype=bool))
        self._write({"type": "structure", "id": id, "name": name, "color": color,
                     "mask": f"masks/{id}.npy", "opacity": opacity,
                     "hidden": True if hidden else None,
                     "expect_ml": None if expect_ml is None else [float(v) for v in expect_ml],
                     "notes": list(notes) if notes else None,
                     "unreliable": unreliable or None})

    def profile(self, orientation=None, unit=None, windows=None, disclaimer=None):
        """How the document is shown: axis labels ("patient" or "none"), the unit, named
        windows as (name, width, level) in order, and the line shown with AI findings."""
        self._write({"type": "profile", "orientation": orientation, "unit": unit,
                     "windows": [[n, float(w), float(l)] for n, w, l in (windows or [])],
                     "disclaimer": disclaimer})

    def finding(self, name, summary, source="ai", center_voxel=None, radius_mm=None,
                measures=None, evidence=None, report_item=None):
        self._write({"type": "finding", "name": name, "summary": summary, "source": source,
                     "center_voxel": None if center_voxel is None else list(center_voxel),
                     "radius_mm": radius_mm, "measures": measures or {},
                     "evidence": evidence or [], "report_item": report_item})


def _plain(v):
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items() if x is not None}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


submit = _Submit()
