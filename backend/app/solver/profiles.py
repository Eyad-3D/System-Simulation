"""Time-profile parsing for the Driving Task ('t:value; t:value; …')."""
from __future__ import annotations


def parse_profile(profile: str) -> list[tuple[float, float]]:
    """Parse 't:value; t:value; …' (also accepts ',' as pair separator)."""
    points: list[tuple[float, float]] = []
    for chunk in profile.replace("\n", ";").split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        sep = ":" if ":" in chunk else ","
        try:
            t_str, v_str = chunk.split(sep, 1)
            points.append((float(t_str), float(v_str)))
        except ValueError:
            continue
    points.sort(key=lambda p: p[0])
    return points


def interp_profile(points: list[tuple[float, float]], t: float, repeat: bool) -> float:
    if not points:
        return 0.0
    t0, tn = points[0][0], points[-1][0]
    if repeat and tn > t0:
        t = t0 + (t - t0) % (tn - t0)
    if t <= t0:
        return points[0][1]
    if t >= tn:
        return points[-1][1]
    for (ta, va), (tb, vb) in zip(points, points[1:]):
        if ta <= t <= tb:
            if tb == ta:
                return vb
            return va + (vb - va) * (t - ta) / (tb - ta)
    return points[-1][1]
