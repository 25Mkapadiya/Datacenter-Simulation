#!/usr/bin/env python3
"""
Build data/counties_tx.geojson from a Census cartographic boundary county
shapefile, filtered to Texas (STATEFP=48).

Source: https://www.census.gov/geographies/mapping-files/time-series/geo/
        cartographic-boundary.html
Download used: https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_20m.zip
(20m = most generalized/smallest cartographic boundary resolution -- appropriate
for a statewide siting-advisor map, not for parcel-level work.)

Usage:
    python3 scripts/build_county_layer.py <path-to-extracted-shapefile-dir>
"""
import glob
import json
import os
import sys

import shapefile  # pyshp

TX_STATEFP = "48"


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src_dir = sys.argv[1]
    shp_matches = glob.glob(os.path.join(src_dir, "*.shp"))
    if not shp_matches:
        raise SystemExit(f"no .shp file in {src_dir}")
    shp_path = shp_matches[0]

    sf = shapefile.Reader(shp_path)
    fields = [f[0] for f in sf.fields[1:]]  # skip deletion flag

    features = []
    for sr in sf.iterShapeRecords():
        rec = dict(zip(fields, sr.record))
        if rec.get("STATEFP") != TX_STATEFP:
            continue
        geom = sr.shape.__geo_interface__
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "geoid": rec.get("GEOID"),
                "county_fips": rec.get("COUNTYFP"),
                "name": rec.get("NAME"),
                "name_lsad": rec.get("NAMELSAD"),
                "aland_sqm": rec.get("ALAND"),
                "awater_sqm": rec.get("AWATER"),
            },
        })

    print(f"{len(features)} Texas counties")

    out = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "US Census Bureau cartographic boundary files, 2023, 20m resolution",
            "source_url": "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_20m.zip",
            "generated_by": "scripts/build_county_layer.py",
        },
        "features": features,
    }

    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "counties_tx.geojson")
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {out_path} ({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    main()
